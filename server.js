import express from 'express';
import bodyParser from 'body-parser';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import fetch from 'node-fetch'; // For Node v17 or below; omit if Node 18+
import cors from 'cors';
import dotenv from 'dotenv';

import { db, admin } from './firebaseAdmin.js';  // Your Firebase Admin SDK init here

// Load environment variables from .env
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

// Use environment variables for Razorpay keys (make sure defined in your .env)
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_live_7p3V38KUQoolpn";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "YiI6F57QxpxzkDy2BlDXiFrL";

// Initialize Razorpay client
const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

// Enable CORS for all domains or restrict using FRONTEND_ORIGIN variable
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(bodyParser.json());

// Helper function - Refund Razorpay payment
async function refundPayment(paymentId, amount, currency = "INR") {
  const refundUrl = `https://api.razorpay.com/v1/payments/${paymentId}/refund`;
  const body = {
    amount, // amount in paise
    speed: "normal",
  };
  const authString = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');

  const resp = await fetch(refundUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${authString}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errorData = await resp.json().catch(() => ({}));
    throw new Error(`Refund failed: ${resp.status} ${resp.statusText} - ${JSON.stringify(errorData)}`);
  }
  return await resp.json();
}

// Internal Firestore transaction to confirm order and decrement stock
async function confirmOrderAndDecrementStock(orderDocId, paymentStatus, orderItems) {
  const result = await db.runTransaction(async (transaction) => {
    const orderRef = db.collection('orders').doc(orderDocId);
    const orderSnap = await transaction.get(orderRef);
    if (!orderSnap.exists) {
      throw new Error('Order not found');
    }

    const itemDocs = [];
    for (const item of orderItems) {
      const itemRef = db.collection('bakeryItems').doc(item.id);
      const itemSnap = await transaction.get(itemRef);
      if (!itemSnap.exists) {
        throw new Error(`Bakery item ${item.id} not found`);
      }
      itemDocs.push({ ref: itemRef, snap: itemSnap, qtyToDecrement: item.quantity });
    }

    // Check stock availability
    for (const { snap, qtyToDecrement } of itemDocs) {
      const currentQty = Number(snap.data().quantity) ?? 0;
      if (currentQty < qtyToDecrement) {
        return { success: false, insufficientItemId: snap.id };
      }
    }

    // All stock sufficient; update order & decrement stock atomically
    transaction.update(orderRef, {
      orderStatus: 'confirmed',
      paymentStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    for (const { ref, snap, qtyToDecrement } of itemDocs) {
      const currentQty = Number(snap.data().quantity) ?? 0;
      transaction.update(ref, { quantity: currentQty - qtyToDecrement });
    }

    return { success: true };
  });

  return result;
}

// Endpoint: Create Razorpay Payment Order
app.post('/api/payment-order', async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Amount is required and must be a positive number." });
    }

    const paymentOrder = await razorpay.orders.create({
      amount,
      currency: "INR",
      payment_capture: 1,
    });

    return res.status(200).json(paymentOrder);
  } catch (e) {
    console.error("Create payment order error:", e);
    return res.status(500).json({ error: e.message || "Server error" });
  }
});

// Endpoint: Verify Payment and Confirm Order
app.post('/api/payment-verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderDocId } = req.body || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !orderDocId) {
      return res.status(400).json({ status: "error", error: "Missing required fields" });
    }

    // Verify Razorpay signature
    const generated_signature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (generated_signature !== razorpay_signature) {
      // Signature mismatch: cancel payment and order in Firestore
      const orderRef = db.collection("orders").doc(orderDocId);
      await orderRef.update({
        paymentStatus: "cancelled",
        orderStatus: "cancelled",
      });

      return res.status(400).json({
        status: "cancelled",
        message: "Payment and order both cancelled due to signature mismatch",
      });
    }

    // Signature valid: get order document
    const orderRef = db.collection("orders").doc(orderDocId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).json({
        status: "error",
        error: "Order document not found",
      });
    }
    const orderData = orderSnap.data();

    // Prepare orderItems for decrement stock
    const orderItems = (orderData.items || []).map(item => ({
      id: item.productId || item.id,
      quantity: item.quantity,
    }));

    // Confirm order and decrement stock
    const confirmResult = await confirmOrderAndDecrementStock(orderDocId, "confirmed", orderItems);

    if (!confirmResult.success) {
      // Insufficient stock: update order as cancelled and refund payment
      await orderRef.update({
        paymentStatus: "confirmed",
        orderStatus: "cancelled",
        razorpayPaymentId: razorpay_payment_id,
        cancellationReason: "Insufficient stock",
      });

      const paymentAmount = orderData.totalAmount || 0;
      try {
        await refundPayment(razorpay_payment_id, paymentAmount * 100, orderData.currency || "INR");
        console.log(`Refund successful for paymentId: ${razorpay_payment_id}`);
      } catch (refundError) {
        console.error("Refund failed:", refundError);
      }

      return res.status(200).json({
        status: "payment_confirmed_order_cancelled",
        message: "Payment confirmed but order cancelled due to insufficient stock. Refund initiated.",
        insufficientItemId: confirmResult.insufficientItemId || null,
      });
    }

    // Payment and order confirmed successfully
// After signature verification and stock decrement success
await orderRef.update({
    paymentStatus: "confirmed",
    orderStatus: "confirmed",
    razorpayPaymentId: razorpay_payment_id,
  });
  
    return res.status(200).json({
      status: "success",
      message: "Payment and order confirmed successfully",
    });
  } catch (error) {
    console.error("Payment verification API error:", error);
    return res.status(500).json({
      status: "error",
      error: error.message || "Internal server error",
    });
  }
});

// Optional health check route
app.get('/', (req, res) => res.send('Backend server running!'));

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
