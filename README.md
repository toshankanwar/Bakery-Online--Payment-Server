# 🧁 Toshan Bakery - Online Payment Server

This is the official backend **payment server** for the [Toshan Bakery Management & E-commerce](https://github.com/toshankanwar/bakery-management-and-ecommerce) project. It handles **Razorpay-based online transactions**, payment verification, **order confirmation**, **stock decrement**, and **auto-refund** for stock mismatch cases. Built with Node.js, Express, Firebase, and hosted on Render.

🌐 **Live API**: [https://bakery-online-payment-server.onrender.com](https://bakery-online-payment-server.onrender.com)  
📧 **Contact**: [contact@toshankanwar.website](mailto:contact@toshankanwar.website)  
🐙 **Main Bakery Repo**: [Bakery E-commerce Platform](https://github.com/toshankanwar/bakery-management-and-ecommerce)

---

## 🚀 Features

- 🛒 Create Razorpay payment orders  
- 🔐 Verify payment signatures securely  
- ✅ Auto-confirm orders and decrement stock  
- ❌ Auto-cancel & refund on stock mismatch  
- 📦 Firebase Firestore integration  
- 🌍 CORS enabled for secure frontend usage  
- 🔁 Self ping to prevent Render free tier sleep  

---

## ⚙️ Tech Stack

- **Node.js**, **Express**  
- **Razorpay SDK**  
- **Firebase Admin SDK (Firestore)**  
- **dotenv**, **cors**, **body-parser**  
- **Render** hosting with keep-alive  

---

## 🔑 Environment Variables

Create a `.env` file in the root directory and add:

```env
RAZORPAY_KEY_ID=your_razorpay_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
FRONTEND_ORIGIN=https://your-frontend-url.com
PORT=5001
```

> 🔒 **Note**: Never hardcode live secrets. Use `.env` + Render’s dashboard to configure secrets.

---

## 📦 API Endpoints

### `POST /api/payment-order`

Creates a new Razorpay order.

**Request:**
```json
{
  "amount": 25000
}
```
> Amount is in **paise** (e.g., 25000 = ₹250)

**Response:**
```json
{
  "id": "order_xyz123",
  "amount": 25000,
  "currency": "INR",
  ...
}
```

---

### `POST /api/payment-verify`

Verifies Razorpay payment and updates the order.

**Request:**
```json
{
  "razorpay_order_id": "order_xyz123",
  "razorpay_payment_id": "pay_abc456",
  "razorpay_signature": "generated_signature",
  "orderDocId": "firestore_doc_id"
}
```

**Behavior:**
- ✅ Signature matched ➝ Confirms payment + order  
- ❌ Signature mismatch ➝ Cancels payment & order  
- ❌ Stock unavailable ➝ Confirms payment, cancels order, triggers refund  

**Response (Success):**
```json
{
  "status": "success",
  "message": "Payment and order confirmed successfully"
}
```

---

## 🧪 Health Check

To check if the server is alive:

```http
GET /
```

**Response:**
```
Payment Backend server running! for Toshan bakery
```

---

## 🌀 Render Deployment Notes

- **Platform**: [Render.com](https://render.com)  
- **Service Type**: Web Service  
- **Build Command**: `npm install`  
- **Start Command**: `node index.js` (or your entry file)  
- **Environment Variables**: Add all `.env` keys in Render Dashboard  

---

## ♻️ Prevent Sleep (Keep-Alive Ping)

To prevent Render from sleeping the server, a self-ping is made every 9 minutes:

```js
setInterval(selfPing, 9 * 60 * 1000); // Every 9 mins
```

> Can be disabled if using Render’s paid plan.

---

## 🔐 Firebase Integration

- Uses **Firebase Admin SDK** to access:
  - `orders` collection
  - `bakeryItems` collection
- Automatically decrements stock and updates payment status inside a transaction.

---

## 📁 File Structure Overview

```bash
📁 project-root
├── index.js                # Main server logic (Razorpay + Firebase)
├── firebaseAdmin.js        # Firebase admin SDK initialization
├── .env                    # Secret credentials
└── README.md               # ← You are here!
```

---

## 🤝 Contribution & Contact

Have suggestions or issues?

- 🧠 **Email**: [contact@toshankanwar.website](mailto:contact@toshankanwar.website)  
- 🌍 **GitHub (Main Site)**: [https://github.com/toshankanwar/bakery-management-and-ecommerce](https://github.com/toshankanwar/bakery-management-and-ecommerce)  
- ⚙️ **This Repo**: [https://github.com/toshankanwar/Bakery-Online--Payment-Server](https://github.com/toshankanwar/Bakery-Online--Payment-Server)  

---

## 📜 License

MIT License  
© 2025 [Toshan Kanwar](https://github.com/toshankanwar)

---

> ⭐ If you find this useful, consider starring the repo and sharing it with fellow developers!
