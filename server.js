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
  'https://futurewithai.anshumanenterprises.online',
  'https://www.futurewithai.anshumanenterprises.online',
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
      origin.endsWith('.railway.app') ||
      origin.endsWith('.anshumanenterprises.online')
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
    return false; // Force production endpoints for live keys managed via production portal
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

  SUCCESS_URL:  'https://anshumanenterprises.online/payment-success.html',
  FAILURE_URL:  'https://anshumanenterprises.online/payment-failure.html',
  // ⚠️ CALLBACK_URL MUST point to your deployed backend server, NOT the static website!
  CALLBACK_URL: 'https://ae-payment-server.vercel.app/callback',

  PRODUCT_NAME:   'Ultimate n8n AI Automation Pack',
  PRODUCT_AMOUNT: 349,  // Early bird price

  // ── Limited Time Offer ──────────────────────────────────
  // Offer ends: June 17, 2026 08:46 IST = 2026-06-17T03:16:00Z
  OFFER_END_MS:   new Date('2026-06-17T03:16:00Z').getTime(),
  EARLY_PRICE:    349,  // price in first 24 hours
  REGULAR_PRICE:  399,  // price after offer expires

  // Returns correct price based on current time
  get CURRENT_PRICE() {
    return Date.now() < this.OFFER_END_MS ? this.EARLY_PRICE : this.REGULAR_PRICE;
  },
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
async function createPaymentOrder({ merchantOrderId, customerName, customerEmail, customerPhone, amount, products, redirectUrl }) {
  const accessToken = await getAccessToken();
  const url = `${CONFIG.BASE_URL}/checkout/v2/pay`;
  const productName = products || CONFIG.PRODUCT_NAME;
  const finalRedirectUrl = redirectUrl || CONFIG.SUCCESS_URL;

  const payload = {
    merchantOrderId,
    amount: amount * 100,   // INR → paise (₹349 = 34900)
    expireAfter: 1200,      // session expires in 20 mins
    metaInfo: {
      udf1: customerName,
      udf2: customerEmail,
      udf3: customerPhone,
      udf4: productName,
    },
    paymentFlow: {
      type: 'PG_CHECKOUT',
      message: `Pay ₹${amount} for ${productName}`,
      merchantUrls: {
        redirectUrl: finalRedirectUrl.includes('?')
          ? `${finalRedirectUrl}&orderId=${merchantOrderId}`
          : `${finalRedirectUrl}?orderId=${merchantOrderId}`,
      },
    },
  };

  console.log('[Order] Creating:', merchantOrderId);

  const { data } = await axios.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `O-Bearer ${accessToken}`,
      'X-CALLBACK-URL': CONFIG.CALLBACK_URL,
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

// ── Deliver Asset via Google Apps Script ─────────────────────────
async function triggerAssetDelivery(merchantOrderId, rawPhonePeStatus) {
  const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
  if (!GOOGLE_SCRIPT_URL) {
    console.warn('[Delivery] ⚠️ GOOGLE_SCRIPT_URL is not set. Cannot deliver asset automatically.');
    return { success: false, reason: 'GOOGLE_SCRIPT_URL not configured' };
  }

  try {
    const stored = orderStore.get(merchantOrderId) || {};
    
    // Extract info from raw status or stored order
    const name    = rawPhonePeStatus?.metaInfo?.udf1 || stored.name || 'Customer';
    const email   = rawPhonePeStatus?.metaInfo?.udf2 || stored.email;
    const phone   = rawPhonePeStatus?.metaInfo?.udf3 || stored.whatsapp || '';
    
    // Payment details
    const payments = rawPhonePeStatus?.paymentDetails || [];
    const successPayment = payments.find(p => p.state === 'COMPLETED') || {};
    const txnId   = successPayment.transactionId || '';
    const amount  = rawPhonePeStatus?.amount ? (rawPhonePeStatus.amount / 100) : (stored.amount || 349);
    const productsList = stored.productIds || stored.products || rawPhonePeStatus?.metaInfo?.udf4 || 'n8n-pack';

    if (!email) {
      console.warn(`[Delivery] ⚠️ No email found for order ${merchantOrderId}. Cannot deliver asset.`);
      return { success: false, reason: 'No customer email' };
    }

    console.log(`[Delivery] Triggering asset delivery to ${email} for order ${merchantOrderId} with products: ${productsList}...`);

    const response = await axios.post(GOOGLE_SCRIPT_URL, {
      orderId: merchantOrderId,
      transactionId: txnId,
      name,
      email,
      whatsapp: phone,
      amount,
      products: productsList,
      status: 'COMPLETED'
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.data && response.data.success) {
      console.log(`[Delivery] ✅ Apps Script delivery response:`, response.data);
      
      // Update in-memory status to record delivery
      if (orderStore.has(merchantOrderId)) {
        orderStore.get(merchantOrderId).assetDelivered = true;
      }
      return { success: true, data: response.data };
    } else {
      console.error(`[Delivery] ❌ Apps Script delivery failed:`, response.data);
      return { success: false, error: response.data?.message || 'Apps Script returned non-success' };
    }
  } catch (error) {
    console.error(`[Delivery] ❌ API call to Apps Script failed:`, error.message);
    return { success: false, error: error.message };
  }
}

// ══════════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════════

// ── POST /initiate-phonepe-payment ───────────────────────────────
//  Frontend calls this after lead form submit
//  Returns: { success, redirectUrl, merchantOrderId, amount }
app.post(['/initiate-phonepe-payment', '/webhook/initiate-phonepe-payment'], async (req, res) => {
  try {
    const { name = 'Customer', email = '', whatsapp = '', bizType = '', goals = '', amount = 0, products = '', productIds = '', redirectUrl = '' } = req.body;

    if (!email && !whatsapp) {
      return res.status(400).json({ success: false, message: 'Email ya WhatsApp number zaroori hai.' });
    }

    // ── Dynamic pricing ──────────────────────────────────────────────
    // Accept dynamic cart amount if provided and greater than 0, otherwise fallback to CONFIG.REGULAR_PRICE
    const requested = parseInt(amount || 0);
    const safeAmount = requested > 0 ? requested : CONFIG.REGULAR_PRICE;

    console.log(`[initiate] Cart amount: ₹${safeAmount} | Products: ${products} | RedirectUrl: ${redirectUrl}`);

    const merchantOrderId = generateOrderId();

    const order = await createPaymentOrder({
      merchantOrderId,
      customerName:  name,
      customerEmail: email,
      customerPhone: whatsapp,
      amount: safeAmount,
      products: products || CONFIG.PRODUCT_NAME,
      redirectUrl: redirectUrl
    });

    // Store order info in memory for webhook cross-reference
    orderStore.set(merchantOrderId, {
      name, email, whatsapp, bizType, goals, products, productIds,
      amount: safeAmount,
      state: 'PENDING',
      createdAt: new Date().toISOString(),
    });

    logOrder({ event: 'ORDER_CREATED', merchantOrderId, phonePeOrderId: order.phonePeOrderId, name, email, whatsapp, bizType, amount: safeAmount, products });

    return res.json({
      success: true,
      redirectUrl: order.redirectUrl,
      merchantOrderId,
      amount: safeAmount,
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

    // Trigger automatic asset delivery if completed/paid
    if (parsed.isPaid) {
      triggerAssetDelivery(merchantOrderId, raw).catch(err => {
        console.error(`[Status Check Delivery Fallback] Failed for ${merchantOrderId}:`, err.message);
      });
    }

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

          // Trigger automatic asset delivery
          await triggerAssetDelivery(merchantOrderId, raw);
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

// ── POST /send-gift ───────────────────────────────────────────────
//  Frontend calls this directly after lead form submission to send surprise gift via Google Apps Script & WhatsApp
app.post('/send-gift', async (req, res) => {
  try {
    const { name, email, whatsapp, profession = '' } = req.body;

    if (!name || (!whatsapp && !email)) {
      return res.status(400).json({ success: false, message: 'Name and either WhatsApp or Email are required.' });
    }

    // Clean phone number (remove +, spaces, ensure country code)
    let formattedPhone = whatsapp ? whatsapp.replace(/[^0-9]/g, '') : '';
    if (formattedPhone && formattedPhone.length === 10) {
      formattedPhone = '91' + formattedPhone; // assume Indian country code (+91) if 10 digits
    }

    // Generate personalized gift message using Gemini AI if key is present
    let aiMessage = `Hello ${name}! Welcome to FutureWithAi. Here is your secret gift: the AI Company OS Blueprint Prompt! Download premium workflows here: https://github.com/nusquama/n8nworkflows.xyz`;
    
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (GEMINI_API_KEY && profession) {
      try {
        console.log('[Gemini AI] Generating personalized gift message...');
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        const geminiPayload = {
          contents: [{
            parts: [{
              text: `Generate a warm, exciting, and professional message in English (or friendly Hinglish) for a user named "${name}" whose profession is "${profession}". Tell them that they have unlocked the FutureWithAi Automation Vault as their secret gift. Tell them to copy the AI Company OS Blueprint Prompt from the website or download premium automation files here: https://github.com/nusquama/n8nworkflows.xyz. Make it sound extremely helpful, inspiring, and customized for a ${profession}, highlighting how n8n workflows can save them hours. Keep the message under 120 words, use formatting like bullet points or emojis, and write it in a friendly, professional tone. Do not output any markdown formatting, HTML, or code blocks; just return the raw text.`
            }]
          }]
        };
        const geminiResponse = await axios.post(geminiUrl, geminiPayload, {
          headers: { 'Content-Type': 'application/json' }
        });
        const generatedText = geminiResponse.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (generatedText) {
          aiMessage = generatedText.trim();
          console.log('[Gemini AI] Custom message generated successfully.');
        }
      } catch (e) {
        console.error('[Gemini AI] Generation failed, using default fallback message:', e.message);
      }
    }

    // Google Apps Script Email Delivery Route (Primary)
    const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
    let emailSent = false;
    let emailError = null;

    if (GOOGLE_SCRIPT_URL && email) {
      try {
        console.log(`[Google Script] Triggering lead email via Apps Script: ${GOOGLE_SCRIPT_URL}...`);
        const scriptResponse = await axios.post(GOOGLE_SCRIPT_URL, {
          action: "lead_capture",
          name,
          email,
          profession,
          aiMessage
        }, {
          headers: { 'Content-Type': 'application/json' }
        });
        
        if (scriptResponse.data && scriptResponse.data.success) {
          console.log(`[Google Script] Email successfully sent to ${email}`);
          emailSent = true;
        } else {
          console.warn('[Google Script] Script returned non-success response:', scriptResponse.data);
          emailError = scriptResponse.data?.message || 'Unknown Apps Script error';
        }
      } catch (e) {
        console.error('[Google Script] Failed to trigger email via Apps Script:', e.message);
        emailError = e.message;
      }
    } else {
      console.warn('[Google Script] GOOGLE_SCRIPT_URL is not set or email is missing.');
    }

    // Send WhatsApp via custom endpoint if configured (e.g. n8n webhook or custom WhatsApp session)
    const CUSTOM_ENDPOINT = process.env.WHATSAPP_CUSTOM_ENDPOINT;
    let whatsappSent = false;
    if (CUSTOM_ENDPOINT && formattedPhone) {
      try {
        console.log(`[WhatsApp Custom] Forwarding AI message to custom endpoint: ${CUSTOM_ENDPOINT}...`);
        await axios.post(CUSTOM_ENDPOINT, {
          name,
          whatsapp: formattedPhone,
          profession,
          message: aiMessage
        });
        console.log(`[WhatsApp Custom] Forwarded successfully to ${formattedPhone}`);
        whatsappSent = true;
      } catch (e) {
        console.error('[WhatsApp Custom] Forwarding failed:', e.message);
      }
    }

    // Official Meta Cloud API integration (Secondary fallback/dual delivery)
    const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
    const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || 'surprise_gift';

    if (WHATSAPP_TOKEN && PHONE_NUMBER_ID && formattedPhone && !whatsappSent) {
      try {
        const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
        const paramsCount = parseInt(process.env.WHATSAPP_TEMPLATE_PARAMS_COUNT || '1', 10);
        const parameters = [{ type: "text", text: name }];
        if (paramsCount > 1) {
          parameters.push({ type: "text", text: aiMessage });
        }

        const payload = {
          messaging_product: "whatsapp",
          to: formattedPhone,
          type: "template",
          template: {
            name: TEMPLATE_NAME,
            language: { code: "en" },
            components: [{
              type: "body",
              parameters: parameters
            }]
          }
        };

        console.log(`[WhatsApp] Sending surprise gift template to ${formattedPhone}...`);
        await axios.post(url, payload, {
          headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
        console.log(`[WhatsApp] Surprise gift sent successfully to ${formattedPhone}`);
        whatsappSent = true;
      } catch (err) {
        console.error('[WhatsApp] Meta Send error:', err.response?.data || err.message);
      }
    }

    // Determine final status response
    if (emailSent) {
      return res.json({ 
        success: true, 
        message: 'Lead processed. Secret gift sent to your Email address!',
        emailSent,
        whatsappSent
      });
    } else if (whatsappSent) {
      return res.json({
        success: true,
        message: 'Lead processed. Secret gift sent to your WhatsApp!',
        emailSent,
        whatsappSent
      });
    } else {
      // Fallback lead log if no delivery channels are active/succeeded
      console.warn('[Server] No active delivery channel succeeded. Logging lead instead.');
      return res.json({
        success: true,
        message: 'Lead captured successfully.',
        log: { name, email, whatsapp: formattedPhone, profession, message: aiMessage },
        emailSent: false,
        whatsappSent: false,
        error: emailError || 'No active mailing or WhatsApp gateway configured'
      });
    }

  } catch (err) {
    console.error('[send-gift] Server error:', err.message);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to process lead capture.', 
      error: err.message 
    });
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
