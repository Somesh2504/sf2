// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors({ origin: '*' }));

// --------------------
// In-memory atomic lock for payment processing
// --------------------
const processingPayments = new Set();

// --------------------
// CONFIG
// --------------------
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const FRONTEND_BASE_URL = 'https://studentforgesf.netlify.app/';


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


async function logToGoogleSheet(sheet, data) {
  try {
    await axios.post(process.env.GSHEET_LOG_URL, {
      sheet,
      ...data
    }, {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('❌ Google Sheet log failed:', err.response?.data || err.message);
  }
}

async function saveTransaction(data) {
  if (data.status === 'SUCCESS') {
  const already = await isPaymentAlreadyProcessed(data.order_id, data.payment_id);
  if (already) {
    console.warn("⚠️ Duplicate SUCCESS insert prevented");
    return;
  }
}
  await logToGoogleSheet('transactions', {
    timestamp: new Date().toISOString(),
    order_id: data.order_id || '',
    payment_id: data.payment_id || '',
    status: data.status || '',
    amount: data.amount || '',
    method: data.method || '',
    raw_response: JSON.stringify(
      data.raw_payment_response ||
      data.verification_response ||
      data.raw_body ||
      {}
    )
  });
}

async function saveVerificationLog(log) {
  await logToGoogleSheet('verification_logs', {
    timestamp: new Date().toISOString(),
    step: log.step || '',
    order_id: log.order_id || '',
    payment_id: log.payment_id || '',
    signature_matched: log.signature_matched ?? '',
    razorpay_status: log.razorpay_status || '',
    raw_data: JSON.stringify(
      log.full_response ||
      log.error ||
      {}
    )
  });
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
// VERIFY PAYMENT (AUDIT-READY)
// --------------------
app.post('/verify_payment', async (req, res) => {
  const { order_id, payment_id, signature } = req.body;
  console.log("order_id===",order_id);
  console.log("payment_id===",payment_id);
  console.log("signature===",signature)
     const alreadyVerified = await isPaymentAlreadyProcessed(order_id, payment_id);
if (alreadyVerified) {
  return res.json({ valid: false, reason: 'Payment already processed' });
}
  // 1️⃣ Signature generation
  const generated_signature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(order_id + "|" + payment_id)
    .digest('hex');

  const signatureMatched = generated_signature === signature;
  console.log("generate signature===",generated_signature);
  console.log("received signature===",signature)

  // ✅ LOG VERIFICATION REQUEST + SIGNATURE RESULT
 await saveVerificationLog({
    step: "SIGNATURE_VERIFICATION",
    order_id,
    payment_id,
    received_signature: signature,
    generated_signature,
    signature_matched: signatureMatched,
    time: new Date().toISOString()
  });

  if (!signatureMatched) {
    return res.json({
      valid: false,
      reason: "Signature mismatch"
    });
  }

  try {
    // 2️⃣ STATUS API (DUAL INQUIRY)
    const paymentResp = await axios.get(
      `https://api.razorpay.com/v1/payments/${payment_id}`,
      {
        auth: {
          username: RAZORPAY_KEY_ID,
          password: RAZORPAY_KEY_SECRET
        }
      }
    );

    // ✅ LOG STATUS API RESPONSE
    await saveVerificationLog({
      step: "STATUS_API",
      order_id,
      payment_id,
      razorpay_status: paymentResp.data.status,
      full_response: paymentResp.data,
      time: new Date().toISOString()
    });

    if (paymentResp.data.status !== "captured") {
      return res.json({
        valid: false,
        reason: "Payment not captured"
      });
    }

    return res.json({
      valid: true,
      payment: paymentResp.data
    });

  } catch (err) {
   await saveVerificationLog({
      step: "STATUS_API_ERROR",
      order_id,
      payment_id,
      error: err.response?.data || err.message,
      time: new Date().toISOString()
    });

    return res.status(500).json({
      valid: false,
      reason: "Status API failed"
    });
  }
});


// // --------------------
// // RAZORPAY PAYMENT FAILED / CANCELLED
// // --------------------
// app.all('/payment_failed', async (req, res) => {
//   const orderId =
//     req.body.razorpay_order_id ||
//     req.query.razorpay_order_id ||
//     '';

//   const paymentId =
//     req.body.razorpay_payment_id ||
//     req.query.razorpay_payment_id ||
//     '';

//   const reason =
//     req.body.error_description ||
//     req.query.error_description ||
//     'payment_failed';

//   await saveTransaction({
//     order_id: orderId,
//     payment_id: paymentId,
//     status: 'FAILED',
//     error_description: reason,
//     raw_body: req.body,
//     raw_query: req.query
//   });

//   return res.redirect(302,
//     `${FRONTEND_BASE_URL}payment_failed.html` +
//     `?reason=missing_callback_params`
//   );
// });

// async function isPaymentAlreadyProcessed(order_id, payment_id) {
//   try {
//     const resp = await axios.post(process.env.GSHEET_LOG_URL, {
//       sheet: 'transactions',
//       check_only: true,
//       order_id,
//       payment_id
//     });
//     return resp.data?.exists === true;
//   } catch (err) {
//     console.error('❌ Duplicate check failed', err.message);
//     return false; // fail-safe: allow once
//   }
// }

// // --------------------
// // RAZORPAY CALLBACK (AUDIT SAFE)
// // --------------------
// app.post('/payment_callback', async (req, res) => {
//   const razorpay_payment_id =
//     req.body.razorpay_payment_id || req.query.razorpay_payment_id;

//   const razorpay_order_id =
//     req.body.razorpay_order_id || req.query.razorpay_order_id;

//   const razorpay_signature =
//     req.body.razorpay_signature || req.query.razorpay_signature;

//     if (processingPayments.has(razorpay_payment_id)) {
//   console.warn("⚠️ Parallel duplicate blocked:", razorpay_payment_id);
//   return res.status(409).send("Duplicate request blocked");
// }

// // Lock it immediately
// processingPayments.add(razorpay_payment_id);

//   // ✅ Log raw incoming payload (AUDIT EVIDENCE)
//   console.log("🔔 Razorpay Callback Received");
//   console.log("BODY:", req.body);
//   console.log("QUERY:", req.query);
//       const alreadyProcessed = await isPaymentAlreadyProcessed(
//   razorpay_order_id,
//   razorpay_payment_id
// );

// if (alreadyProcessed) {
//   console.warn('⚠️ Duplicate callback blocked:', razorpay_order_id);
//   return res.status(409).send('Duplicate payment callback ignored');
// }
//   // ❌ If any value missing → FAIL FAST
//   if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {

//     // Save FAILED attempt for audit trace
//   await  saveTransaction({
//       order_id: razorpay_order_id || 'NA',
//       payment_id: razorpay_payment_id || 'NA',
//       status: 'FAILED',
//       reason: 'Missing Razorpay callback parameters',
//       raw_body: req.body,
//       raw_query: req.query,
//       time: new Date().toISOString()
//     });

//     return res.redirect(302,
//       `${FRONTEND_BASE_URL}payment_failed.html` +
//       `?reason=missing_callback_params`
//     );

//   }

//   try {
//     // ✅ Call internal verification API (Signature + Status API)
//     const verifyResp = await axios.post(
//       'https://sf2.onrender.com/verify_payment',
//       {
//         order_id: razorpay_order_id,
//         payment_id: razorpay_payment_id,
//         signature: razorpay_signature
//       }
//     );

//     // ❌ Verification failed
//     if (!verifyResp.data.valid) {

//     await  saveTransaction({
//         order_id: razorpay_order_id,
//         payment_id: razorpay_payment_id,
//         status: 'FAILED',
//         reason: 'Signature mismatch or payment not captured',
//         verification_response: verifyResp.data,
//         time: new Date().toISOString()
//       });

//       return res.redirect(302,
//         `${FRONTEND_BASE_URL}payment_failed.html` +
//         `&reason=verification_failed`
//       );
//     }

//     // ✅ SUCCESS
//     const payment = verifyResp.data.payment;

//    await saveTransaction({
//       order_id: razorpay_order_id,
//       payment_id: razorpay_payment_id,
//       status: 'SUCCESS',
//       amount: payment.amount/100,
//       method: payment.method,
//       raw_payment_response: payment,
//       time: new Date().toISOString()
//     });

//     // ✅ Mandatory audit success response fields
//     processingPayments.delete(razorpay_payment_id);
//     const successToken = crypto.randomBytes(16).toString('hex');

// // Store token in memory (temporary secure storage)
// if (!global.successTokens) global.successTokens = {};
// global.successTokens[successToken] = {
//   order_id: razorpay_order_id,
//   payment_id: razorpay_payment_id,
//   amount: payment.amount / 100,
//   expires: Date.now() + 5 * 60 * 1000 // 5 min expiry
// };

// processingPayments.delete(razorpay_payment_id);

// return res.redirect(302,
//   `${FRONTEND_BASE_URL}payment_success.html?ref=${successToken}`
// );

//   } catch (err) {
//     console.error("❌ Callback verification error", err.response?.data || err.message);

//     await saveTransaction({
//       order_id: razorpay_order_id,
//       payment_id: razorpay_payment_id,
//       status: 'FAILED',
//       reason: 'Server error during verification',
//       error: err.message,
//       time: new Date().toISOString()
//     });

//     res.status(500).send(`
//       <h2>Payment Error</h2>
//       <p>Something went wrong while verifying payment.</p>
//     `);
//   }
//   processingPayments.delete(razorpay_payment_id);
// });

app.post('/payment_callback', async (req, res) => {

  const razorpay_payment_id =
    req.body.razorpay_payment_id || req.query.razorpay_payment_id;

  const razorpay_order_id =
    req.body.razorpay_order_id || req.query.razorpay_order_id;

  const razorpay_signature =
    req.body.razorpay_signature || req.query.razorpay_signature;

  // 1️⃣ Validate required params first
  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    return res.status(400).send("Missing parameters");
  }

  // 2️⃣ Race Condition Lock
  if (processingPayments.has(razorpay_payment_id)) {
    console.warn("⚠️ Parallel duplicate blocked:", razorpay_payment_id);
    return res.status(409).send("Duplicate request blocked");
  }

  processingPayments.add(razorpay_payment_id);

  try {

    const alreadyProcessed = await isPaymentAlreadyProcessed(
      razorpay_order_id,
      razorpay_payment_id
    );

    if (alreadyProcessed) {
      return res.status(409).send("Duplicate payment ignored");
    }

    const verifyResp = await axios.post(
      'https://sf2.onrender.com/verify_payment',
      {
        order_id: razorpay_order_id,
        payment_id: razorpay_payment_id,
        signature: razorpay_signature
      }
    );

    if (!verifyResp.data.valid) {
      return res.status(400).send("Verification failed");
    }

    const payment = verifyResp.data.payment;

    await saveTransaction({
      order_id: razorpay_order_id,
      payment_id: razorpay_payment_id,
      status: 'SUCCESS',
      amount: payment.amount / 100,
      method: payment.method,
      raw_payment_response: payment
    });

    // Generate secure token
    const successToken = crypto.randomBytes(16).toString('hex');

    if (!global.successTokens) global.successTokens = {};

    global.successTokens[successToken] = {
      order_id: razorpay_order_id,
      payment_id: razorpay_payment_id,
      amount: payment.amount / 100,
      expires: Date.now() + 5 * 60 * 1000
    };

    return res.redirect(302,
      `${FRONTEND_BASE_URL}payment_success.html?ref=${successToken}`
    );

  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error");

  } finally {
    processingPayments.delete(razorpay_payment_id);
  }

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

app.get('/validate_success', (req, res) => {
  const ref = req.query.ref;

  if (!ref || !global.successTokens || !global.successTokens[ref]) {
    return res.status(403).json({ valid: false });
  }

  const data = global.successTokens[ref];

  if (Date.now() > data.expires) {
    delete global.successTokens[ref];
    return res.status(403).json({ valid: false });
  }

  delete global.successTokens[ref];

  return res.json({
    valid: true,
    order_id: data.order_id,
    payment_id: data.payment_id,
    amount: data.amount
  });
});

// --------------------
// START SERVER
// --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
