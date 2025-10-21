import express from 'express';
import bodyParser from 'body-parser';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import fetch from 'node-fetch'; // For Node v17 or below; omit if Node 18+
import cors from 'cors';
import dotenv from 'dotenv';

import { db, admin } from './firebaseAdmin.js';  // Your Firebase Admin SDK init here

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.error('Razorpay keys missing in environment variables');
  process.exit(1);
}

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

// Restrict CORS to only bakery domain
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);

    const allowedOrigin = 'https://bakery.toshankanwar.website';
    if (origin === allowedOrigin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));


app.use(bodyParser.json());

// Refund function remains unchanged
async function refundPayment(paymentId, amount, currency = "INR") {
  const refundUrl = `https://api.razorpay.com/v1/payments/${paymentId}/refund`;
  const body = { amount, speed: "normal" };
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

// Check stock availability function
async function checkStockAvailability(orderItems) {
  for (const item of orderItems) {
    const itemRef = db.collection('bakeryItems').doc(item.id);
    const snap = await itemRef.get();
    if (!snap.exists) {
      return { available: false, message: `Item with id ${item.id} not found` };
    }
    const currentQty = snap.data().quantity ?? 0;
    if (currentQty < item.quantity) {
      return { available: false, message: `Item ${item.id} out of stock` };
    }
  }
  return { available: true };
}

// Optimistically decrement stock before payment
async function decrementStock(orderItems) {
  const batch = db.batch();
  for (const item of orderItems) {
    const itemRef = db.collection('bakeryItems').doc(item.id);
    batch.update(itemRef, { quantity: admin.firestore.FieldValue.increment(-item.quantity) });
  }
  await batch.commit();
}

// Restock items if payment fails/cancelled
async function restockItems(orderItems) {
  const batch = db.batch();
  for (const item of orderItems) {
    const itemRef = db.collection('bakeryItems').doc(item.id);
    batch.update(itemRef, { quantity: admin.firestore.FieldValue.increment(item.quantity) });
  }
  await batch.commit();
}

// Endpoint: Create Razorpay Payment Order - Now checks stock first and decrements stock if available
app.post('/api/payment-order', async (req, res) => {
  try {
    const { amount, orderItems } = req.body;

    if (!amount || typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Amount is required and must be a positive number." });
    }
    if (!Array.isArray(orderItems) || orderItems.length === 0) {
      return res.status(400).json({ error: "Order items are required." });
    }

    // Check stock availability
    const stockCheck = await checkStockAvailability(orderItems);
    if (!stockCheck.available) {
      return res.status(400).json({ error: stockCheck.message || "Out of stock" });
    }

    // Decrement stock optimistically before payment window shown
    await decrementStock(orderItems);

    // Create Razorpay order
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

// Endpoint: Verify Payment and Confirm Order - update to restock if payment cancelled or failed
app.post('/api/payment-verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderDocId } = req.body || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !orderDocId) {
      return res.status(400).json({ status: "error", error: "Missing required fields" });
    }

    const generated_signature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (generated_signature !== razorpay_signature) {
      // Signature mismatch: cancel payment and order in Firestore and restock items
      const orderRef = db.collection("orders").doc(orderDocId);
      const orderSnap = await orderRef.get();
      if (orderSnap.exists) {
        const orderData = orderSnap.data();
        const orderItems = (orderData.items || []).map(item => ({
          id: item.productId || item.id,
          quantity: item.quantity,
        }));
        await restockItems(orderItems);
      }
      await orderRef.update({
        paymentStatus: "cancelled",
        orderStatus: "cancelled",
      });

      return res.status(400).json({
        status: "cancelled",
        message: "Payment and order both cancelled due to signature mismatch",
      });
    }

    const orderRef = db.collection("orders").doc(orderDocId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).json({
        status: "error",
        error: "Order document not found",
      });
    }
    const orderData = orderSnap.data();

    const orderItems = (orderData.items || []).map(item => ({
      id: item.productId || item.id,
      quantity: item.quantity,
    }));

    // No need to check stock again or decrement here, assumed done before payment

    // Confirm order
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
app.get('/', (req, res) => res.send('Payment Backend server running! for Toshan bakery'));

// Keep-alive self ping function stays same
function selfPing() {
  const publicUrl = process.env.SERVER_PUBLIC_URL;
  fetch(publicUrl)
    .then(res => {
      if (res.ok) {
        console.log(`[KEEP-ALIVE] Self-ping successful at ${new Date().toLocaleString()}`);
      } else {
        console.warn(`[KEEP-ALIVE] Self-ping responded with status ${res.status}`);
      }
    })
    .catch(err => {
      console.error('[KEEP-ALIVE] Self-ping failed:', err);
    });
}

setInterval(selfPing, 14 * 60 * 1000);
setTimeout(selfPing, 10 * 1000);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

