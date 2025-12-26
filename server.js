require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors({
  origin: '*'
}));
app.use(bodyParser.json());

// --------------------
// CONFIG
// --------------------
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;


// Load courses from JSON
let allowedCourses = {};
try {
  const coursesData = fs.readFileSync(path.join(__dirname, 'courses.json'), 'utf-8');
  const courses = JSON.parse(coursesData);

  courses.forEach(course => {
    allowedCourses[course.name] = course.price;
  });

  console.log("✅ Courses loaded:", Object.keys(allowedCourses));
} catch (err) {
  console.error("❌ Failed to load courses.json", err);
  process.exit(1);
}

// --------------------
// CREATE ORDER
// --------------------
app.post('/create_order', async (req, res) => {
  console.log("Received order creation request:", req.body);
  try {
    const { course } = req.body;

    // Validate course
    if (!course || !allowedCourses[course]) {
      return res.status(400).json({ error: "Invalid course selected" });
    }

    const amount = allowedCourses[course];

    // Create Razorpay order via API
    console.log("🔑 Razorpay Key ID:", RAZORPAY_KEY_ID);
    const { data } = await axios.post(
      'https://api.razorpay.com/v1/orders',
      {
        amount: amount * 100, // paise
        currency: "INR",
        receipt: `receipt_${Date.now()}`,
        payment_capture: 1
      },
      {
        auth: {
          username: RAZORPAY_KEY_ID,
          password: RAZORPAY_KEY_SECRET
        }
      }
    );

    res.json({
      order_id: data.id,
      amount: data.amount,
      currency: data.currency,
      course,
      key: RAZORPAY_KEY_ID
    });

  } catch (err) {
    console.error("❌ Razorpay API ERROR");
    console.error("Status:", err.response?.status);
    console.error("Data:", err.response?.data);
    console.error("Message:", err.message);
    res.status(500).json(err.response?.data || { error: err.message });
  }
});

// --------------------
// VERIFY PAYMENT
// --------------------
app.post('/verify_payment', async (req, res) => {
  try {
    const { order_id, payment_id, signature } = req.body;

    const generated_signature = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(order_id + "|" + payment_id)
      .digest('hex');

    if (generated_signature !== signature) {
      return res.json({ valid: false, reason: "Signature mismatch" });
    }

    // 🔁 DUAL INQUIRY (MANDATORY)
    const paymentResp = await axios.get(
      `https://api.razorpay.com/v1/payments/${payment_id}`,
      {
        auth: {
          username: RAZORPAY_KEY_ID,
          password: RAZORPAY_KEY_SECRET
        }
      }
    );

    if (paymentResp.data.status !== "captured") {
      return res.json({ valid: false, reason: "Payment not captured" });
    }
    saveTransaction({
      order_id,
      payment_id,
      status: "SUCCESS",
      amount: paymentResp.data.amount,
      time: new Date().toISOString()
    });
    res.json({ valid: true, payment: paymentResp.data });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Verification failed" });
  }
});


app.post('/payment_callback', async (req, res) => {
  const {
    razorpay_payment_id,
    razorpay_order_id,
    razorpay_signature
  } = req.body; // ⬅️ NOT req.query

  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    return res.send(`
      <h2>Payment Failed</h2>
      <p>Missing payment details</p>
    `);
  }

  try {
    const verifyResp = await axios.post(
      'https://sf2.onrender.com/verify_payment',
      {
        order_id: razorpay_order_id,
        payment_id: razorpay_payment_id,
        signature: razorpay_signature
      }
    );

    if (!verifyResp.data.valid) {
      saveTransaction({
        order_id: razorpay_order_id,
        payment_id: razorpay_payment_id,
        status: "FAILED",
        time: new Date().toISOString()
      });

      return res.send(`
        <h2>Payment Failed</h2>
        <p>Verification failed</p>
      `);
    }

    const payment = verifyResp.data.payment;

    res.send(`
      <h2>Payment Successful</h2>
      <p><strong>Order ID:</strong> ${razorpay_order_id}</p>
      <p><strong>Payment ID:</strong> ${razorpay_payment_id}</p>
      <p><strong>Amount:</strong> ₹${payment.amount / 100}</p>
    `);

  } catch (err) {
    console.error(err);
    res.send(`<h2>Payment Error</h2>`);
  }
});

// Health check route for Render.com
app.get('/', (req, res) => {
  res.send('Server is up and running!');
});



app.post('/verify_phone', (req, res) => {
  const { phone, idToken } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone missing' });

  console.log('✅ Verified phone received:', phone);

  // Optional: store in-memory or DB for later reference
  // Example (in-memory, not persistent):
  // if(!global.verifiedPhones) global.verifiedPhones = [];
  // global.verifiedPhones.push(phone);

  // If you want to verify idToken here, add Firebase Admin and verify the token:
  // const admin = require('firebase-admin');
  // admin.auth().verifyIdToken(idToken)
  //   .then(decoded => res.json({ success: true, phone, uid: decoded.uid }))
  //   .catch(err => res.status(401).json({ error: 'Invalid idToken' }));

  res.json({ success: true, phone });
});


function saveTransaction(data) {
  const file = path.join(__dirname, 'transactions.json');
  let existing = [];
  if (fs.existsSync(file)) {
    existing = JSON.parse(fs.readFileSync(file));
  }
  existing.push(data);
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));
}

// --------------------
// START SERVER
// --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
