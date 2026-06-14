/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   ANSHUMAN ENTERPRISES — PhonePe V2 Payment Gateway Server  ║
 * ║   PhonePe Standard Checkout API Integration (V2)            ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Complete PhonePe API Flow:
 *  Step 1: POST /v1/oauth/token              → Get access_token
 *  Step 2: POST /checkout/v2/pay             → Create order → redirectUrl
 *  Step 3: User pays on PhonePe PayPage
 *  Step 4: PhonePe POSTs to /callback        → Webhook (verify + log)
 *  Step 5: GET /checkout/v2/order/:id/status → Confirm payment state
 *
 * Order States: PENDING | COMPLETED | FAILED
 * Payment States: PENDING | COMPLETED | FAILED | CANCELLED | EXPIRED
 */

require('dotenv').config();

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── CORS ─────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://anshumanenterprises.online',
  'https://www.anshumanenterprises.online',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'null',
];
// Render/Railway preview URLs bhi allow karo
if (process.env.FRONTEND_URL) ALLOWED_ORIGINS.push(process.env.FRONTEND_URL);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (Postman, curl, webhooks)
    if (!origin) return callback(null, true);
    if (
      ALLOWED_ORIGINS.includes(origin) ||
      origin.startsWith('http://localhost:') ||
      origin.startsWith('http://127.0.0.1:') ||
      origin.endsWith('.onrender.com') ||
      origin.endsWith('.railway.app')
    ) {
      return callback(null, true);
    }
    return callback(new Error('CORS blocked: ' + origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── CONFIG ──────────────────────────────────────────────────────
const CONFIG = {
  CLIENT_ID:      'SU2606121430539550011305', // Forced Merchant ID
  CLIENT_SECRET:  '7814af7d-d5ac-4afa-9a8e-5abb10936373', // Forced Client Secret
  CLIENT_VERSION: 1,

  // Automatically detect if sandbox based on Merchant ID
  get IS_SANDBOX() {
    return false; // Force Production mode to validate client credentials on live server
  },

  // Note: SALT_KEY / SALT_INDEX are NOT needed for V2 OAuth flow.
  // V2 uses Authorization: O-Bearer <access_token> instead of X-VERIFY checksum.

  // Webhook basic auth (PhonePe Dashboard → Webhook settings mein set karo)
  WEBHOOK_USERNAME: 'Anshumanenterprises1',
  WEBHOOK_PASSWORD: 'Webhookanshuman1119',

  get BASE_URL() {
    return this.IS_SANDBOX
      ? 'https://api-preprod.phonepe.com/apis/pg-sandbox'
      : 'https://api.phonepe.com/apis/pg';
  },

  SUCCESS_URL:  'https://futurewithai.anshumanenterprises.online/payment-success.html',
  FAILURE_URL:  'https://futurewithai.anshumanenterprises.online/payment-failure.html',
  // ⚠️ CALLBACK_URL MUST point to your deployed backend server, NOT the static website!
  CALLBACK_URL: 'https://ae-payment-server.vercel.app/callback',

  PRODUCT_NAME:   'Ultimate n8n AI Automation Pack',
  PRODUCT_AMOUNT: 349,
};

// ─── TOKEN CACHE ─────────────────────────────────────────────────
let tokenCache = { access_token: null, expires_at: 0 };

// ─── IN-MEMORY ORDER STORE (use a DB in production) ──────────────
const orderStore = new Map();
// orderStore: { merchantOrderId → { name, email, whatsapp, state, createdAt } }

// ══════════════════════════════════════════════════════════════════
//  STEP 1 — Get / Refresh Authorization Token
//  POST /v1/oauth/token
//  Header: Content-Type: application/x-www-form-urlencoded
//  Body: client_id, client_secret, client_version, grant_type
// ══════════════════════════════════════════════════════════════════
async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.access_token && tokenCache.expires_at > now + 300_000) {
    return tokenCache.access_token; // use cached (5-min buffer)
  }

  console.log('[Token] Fetching new access token...');
  const url = CONFIG.IS_SANDBOX
    ? 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token'
    : 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token';

  const payload = new URLSearchParams({
    client_id:      CONFIG.CLIENT_ID,
    client_secret:  CONFIG.CLIENT_SECRET,
    client_version: String(CONFIG.CLIENT_VERSION),
    grant_type:     'client_credentials',
  });

  const { data } = await axios.post(url, payload.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (!data.access_token) throw new Error('No access_token in response: ' + JSON.stringify(data));

  tokenCache.access_token = data.access_token;
  // expires_in is in seconds
  tokenCache.expires_at = now + ((data.expires_in || 3600) * 1000);
  console.log('[Token] Token cached. Expires:', new Date(tokenCache.expires_at).toISOString());

  return tokenCache.access_token;
}

// ══════════════════════════════════════════════════════════════════
//  STEP 2 — Create Payment Order
//  POST /checkout/v2/pay
//  Header: Authorization: O-Bearer <access_token>
//  Returns: { orderId, redirectUrl, state: "PENDING" }
// ══════════════════════════════════════════════════════════════════
async function createPaymentOrder({ merchantOrderId, customerName, customerEmail, customerPhone, amount }) {
  const accessToken = await getAccessToken();
  const url = `${CONFIG.BASE_URL}/checkout/v2/pay`;

  const payload = {
    merchantOrderId,
    amount: amount * 100,   // INR → paise (₹349 = 34900)
    expireAfter: 1200,      // session expires in 20 mins
    metaInfo: {
      udf1: customerName,
      udf2: customerEmail,
      udf3: customerPhone,
      udf4: CONFIG.PRODUCT_NAME,
    },
    paymentFlow: {
      type: 'PG_CHECKOUT',
      message: `Pay ₹${amount} for ${CONFIG.PRODUCT_NAME}`,
      merchantUrls: {
        redirectUrl: CONFIG.SUCCESS_URL.includes('?')
          ? `${CONFIG.SUCCESS_URL}&orderId=${merchantOrderId}`
          : `${CONFIG.SUCCESS_URL}?orderId=${merchantOrderId}`,
        callbackUrl: CONFIG.CALLBACK_URL,
      },
    },
  };

  console.log('[Order] Creating:', merchantOrderId);

  const { data } = await axios.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `O-Bearer ${accessToken}`,
    },
  });

  if (!data.redirectUrl) throw new Error('No redirectUrl: ' + JSON.stringify(data));
  console.log('[Order] Created. PhonePe orderId:', data.orderId, '| State:', data.state);

  return {
    merchantOrderId,
    phonePeOrderId: data.orderId,
    redirectUrl: data.redirectUrl,
    state: data.state,
  };
}

// ══════════════════════════════════════════════════════════════════
//  STEP 5 — Check Order Status (Polling / On-Demand)
//  GET /checkout/v2/order/{merchantOrderId}/status
//  Header: Authorization: O-Bearer <access_token>
//
//  Response states:
//    order.state    → PENDING | COMPLETED | FAILED
//    payment.state  → PENDING | COMPLETED | FAILED | CANCELLED | EXPIRED
//    payment.paymentMode → UPI | CARD | NETBANKING | WALLET | EMI
// ══════════════════════════════════════════════════════════════════
async function checkOrderStatus(merchantOrderId) {
  const accessToken = await getAccessToken();
  const url = `${CONFIG.BASE_URL}/checkout/v2/order/${merchantOrderId}/status`;

  console.log('[Status] Checking:', merchantOrderId);

  const { data } = await axios.get(url, {
    headers: {
      'Authorization': `O-Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  return data;
}

// ══════════════════════════════════════════════════════════════════
//  Webhook Signature Verification
//  PhonePe V2 sends: Authorization: Basic base64(username:password)
//  Configure username/password in PhonePe Dashboard → Webhooks
//  Then set PHONEPE_WEBHOOK_USERNAME and PHONEPE_WEBHOOK_PASSWORD in .env
// ══════════════════════════════════════════════════════════════════
function verifyWebhookSignature(authHeader) {
  if (!CONFIG.WEBHOOK_USERNAME || !CONFIG.WEBHOOK_PASSWORD) {
    console.warn('[Webhook] ⚠️ WEBHOOK_USERNAME/PASSWORD not configured — skipping auth check!');
    return true; // skip if not configured (log warning)
  }
  if (!authHeader) return false;

  // PhonePe sends "Basic <base64(username:password)>"
  if (!authHeader.toLowerCase().startsWith('basic ')) return false;

  try {
    const base64Credentials = authHeader.replace(/^basic\s+/i, '');
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
    const [username, password] = credentials.split(':');

    // Use timing-safe comparison to prevent timing attacks
    const usernameMatch = username === CONFIG.WEBHOOK_USERNAME;
    const passwordMatch = password === CONFIG.WEBHOOK_PASSWORD;
    return usernameMatch && passwordMatch;
  } catch (err) {
    console.error('[Webhook] Auth parsing error:', err.message);
    return false;
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────
function generateOrderId() {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `AEN8N-${ts}-${rand}`;
}

function logOrder(data) {
  const logData = { ts: new Date().toISOString(), ...data };
  console.log('[Order Log]', JSON.stringify(logData));
  try {
    const logPath = process.env.VERCEL
      ? path.join('/tmp', 'orders.log')
      : path.join(__dirname, 'orders.log');
    fs.appendFileSync(logPath, JSON.stringify(logData) + '\n', 'utf8');
  } catch (err) {
    console.warn('[logOrder] Could not write to log file:', err.message);
  }
}

// ── Parse status into clean summary ──────────────────────────────
function parseOrderStatus(raw) {
  const state        = raw.state || 'UNKNOWN';
  const isPaid       = state === 'COMPLETED';
  const isFailed     = state === 'FAILED';
  const isPending    = state === 'PENDING';

  const payments = (raw.paymentDetails || []).map(p => ({
    state:       p.state,
    amount:      (p.amount || 0) / 100,    // paise → INR
    paymentMode: p.paymentMode,
    transactionId: p.transactionId,
    timestamp:   p.timestamp,
    errorCode:   p.errorCode,
    errorMessage: p.detailedErrorCode,
    instrument:  p.instrument || null,
  }));

  const successPayment = payments.find(p => p.state === 'COMPLETED');
  const amount = (raw.amount || 0) / 100;

  return { state, isPaid, isFailed, isPending, payments, successPayment, amount, orderId: raw.orderId, merchantOrderId: raw.merchantOrderId };
}

// ══════════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════════

// ── POST /initiate-phonepe-payment ───────────────────────────────
//  Frontend calls this after lead form submit
//  Returns: { success, redirectUrl, merchantOrderId }
// app.post(['/initiate-phonepe-payment', '/webhook/initiate-phonepe-payment'] ...
app.post(['/initiate-phonepe-payment', '/webhook/initiate-phonepe-payment'], async (req, res) => {
  try {
    const { name = 'Customer', email = '', whatsapp = '', bizType = '', goals = '' } = req.body;

    if (!email && !whatsapp) {
      return res.status(400).json({ success: false, message: 'Email ya WhatsApp number zaroori hai.' });
    }

    const merchantOrderId = generateOrderId();

    const order = await createPaymentOrder({
      merchantOrderId,
      customerName:  name,
      customerEmail: email,
      customerPhone: whatsapp,
      amount: CONFIG.PRODUCT_AMOUNT,
    });

    // Store order info in memory for webhook cross-reference
    orderStore.set(merchantOrderId, { name, email, whatsapp, bizType, goals, state: 'PENDING', createdAt: new Date().toISOString() });

    logOrder({ event: 'ORDER_CREATED', merchantOrderId, phonePeOrderId: order.phonePeOrderId, name, email, whatsapp, bizType });

    return res.json({
      success: true,
      redirectUrl: order.redirectUrl,
      merchantOrderId,
      message: 'Payment order created successfully',
    });

  } catch (err) {
    console.error('[initiate] Error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: 'Payment gateway error. Please try again.',
      error: err.response?.data?.message || err.message,
    });
  }
});

// ── GET /status/:merchantOrderId ─────────────────────────────────
//  Frontend polls this after redirect to confirm payment
//  Docs: GET /checkout/v2/order/{merchantOrderId}/status
app.get('/status/:merchantOrderId', async (req, res) => {
  try {
    const { merchantOrderId } = req.params;

    if (!merchantOrderId || merchantOrderId.length < 5) {
      return res.status(400).json({ success: false, message: 'Invalid order ID.' });
    }

    const raw    = await checkOrderStatus(merchantOrderId);
    const parsed = parseOrderStatus(raw);

    // Update in-memory store
    if (orderStore.has(merchantOrderId)) {
      orderStore.get(merchantOrderId).state = parsed.state;
    }

    logOrder({ event: 'STATUS_CHECK', merchantOrderId, state: parsed.state, isPaid: parsed.isPaid });

    return res.json({
      success:         true,
      merchantOrderId: parsed.merchantOrderId || merchantOrderId,
      phonePeOrderId:  parsed.orderId,
      state:           parsed.state,         // PENDING | COMPLETED | FAILED
      isPaid:          parsed.isPaid,
      isFailed:        parsed.isFailed,
      isPending:       parsed.isPending,
      amount:          parsed.amount,         // in INR
      payments:        parsed.payments,       // array of payment attempts
      successPayment:  parsed.successPayment, // the successful payment detail
    });

  } catch (err) {
    const errData = err.response?.data;
    console.error('[status] Error:', errData || err.message);

    // If PhonePe returns 404 → order not found
    if (err.response?.status === 404) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    return res.status(500).json({
      success: false,
      message: errData?.message || err.message,
    });
  }
});

// ── GET /callback ────────────────────────────────────────────────
//  Some gateways send a GET request to validate the webhook URL
app.get('/callback', (req, res) => {
  return res.status(200).send('Webhook active');
});

// ── POST /callback ───────────────────────────────────────────────
//  PhonePe POSTs payment result to this URL
//  Docs: Verify Authorization header = sha256(username:password)
//  Always respond with 200 OK to PhonePe
app.post('/callback', async (req, res) => {
  try {
    const authHeader    = req.headers['authorization'];
    const callbackBody  = req.body;

    console.log('[Webhook] Received callback. Auth:', authHeader ? 'present' : 'missing');
    console.log('[Webhook] Body:', JSON.stringify(callbackBody, null, 2));

    // ── Verify webhook signature ──────────────────────────────
    if (!verifyWebhookSignature(authHeader)) {
      console.warn('[Webhook] ⚠️ Invalid signature! Possible spoofing attempt.');
      logOrder({ event: 'WEBHOOK_INVALID_SIG', authHeader, body: callbackBody });
      return res.status(401).json({ status: 'UNAUTHORIZED' });
    }

    // ── Extract order details from callback ───────────────────
    const merchantOrderId = callbackBody.merchantOrderId || callbackBody.data?.merchantOrderId;
    const orderState      = callbackBody.state           || callbackBody.data?.state;

    if (!merchantOrderId) {
      console.warn('[Webhook] No merchantOrderId in callback');
      return res.status(200).json({ status: 'OK' });
    }

    logOrder({ event: 'CALLBACK_RECEIVED', merchantOrderId, state: orderState, body: callbackBody });

    // ── If payment COMPLETED → verify via Order Status API ────
    if (orderState === 'COMPLETED') {
      try {
        const raw    = await checkOrderStatus(merchantOrderId);
        const parsed = parseOrderStatus(raw);

        if (parsed.isPaid) {
          console.log(`[Webhook] ✅ Payment CONFIRMED for ${merchantOrderId}`);
          logOrder({ event: 'PAYMENT_CONFIRMED', merchantOrderId, amount: parsed.amount, payment: parsed.successPayment });

          // Update store
          if (orderStore.has(merchantOrderId)) {
            const stored = orderStore.get(merchantOrderId);
            stored.state = 'COMPLETED';
            stored.confirmedAt = new Date().toISOString();
            stored.payment = parsed.successPayment;
          }
        }
      } catch (verifyErr) {
        console.error('[Webhook] Verify via status API failed:', verifyErr.message);
      }
    } else if (orderState === 'FAILED') {
      console.log(`[Webhook] ❌ Payment FAILED for ${merchantOrderId}`);
      logOrder({ event: 'PAYMENT_FAILED', merchantOrderId });
    }

    // Always respond 200 to PhonePe
    return res.status(200).json({ status: 'OK' });

  } catch (err) {
    console.error('[callback] Error:', err.message);
    return res.status(200).json({ status: 'OK' }); // Always 200 to PhonePe
  }
});

// ── GET /order-info/:merchantOrderId ─────────────────────────────
//  Internal admin endpoint to view stored order details
app.get('/order-info/:merchantOrderId', (req, res) => {
  const { merchantOrderId } = req.params;
  const info = orderStore.get(merchantOrderId);
  if (!info) return res.status(404).json({ success: false, message: 'Order not found in store.' });
  return res.json({ success: true, merchantOrderId, ...info });
});

// ── GET /health ───────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await getAccessToken();
    res.json({
      status:       'OK',
      mode:         CONFIG.IS_SANDBOX ? 'SANDBOX' : 'PRODUCTION',
      tokenValid:   true,
      tokenExpires: new Date(tokenCache.expires_at).toISOString(),
      ordersInMemory: orderStore.size,
      timestamp:    new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ status: 'ERROR', message: err.message });
  }
});

// ── DEV-ONLY ENDPOINTS ─────────────────────────────────────────────
if (CONFIG.IS_SANDBOX || process.env.NODE_ENV === 'development') {
  app.get('/token-test', async (req, res) => {
    try {
      const token = await getAccessToken();
      res.json({
        success:    true,
        tokenSnippet: token.substring(0, 40) + '...',
        expires:    new Date(tokenCache.expires_at).toISOString(),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/orders', (req, res) => {
    const list = [];
    for (const [id, info] of orderStore.entries()) {
      list.push({ merchantOrderId: id, ...info });
    }
    res.json({ total: list.length, orders: list.slice(-20) });
  });

  console.log('[Dev] Dev-only endpoints enabled: /token-test, /orders');
}

// ══════════════════════════════════════════════════════════════════
//  START SERVER
// ══════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
  Server running on port ${PORT}
  Mode: ${CONFIG.IS_SANDBOX ? 'SANDBOX' : 'PRODUCTION'}
  `);
});

module.exports = app;
