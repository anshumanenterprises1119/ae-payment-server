# Anshuman Enterprises — PhonePe V2 Gateway Server

Node.js + Express backend for PhonePe Standard Checkout V2 API.

## ✅ Local Test Results
- Token API: **WORKING** ✅
- Order Create: **WORKING** ✅  
- Health Check: **WORKING** ✅
- Mode: **SANDBOX** (PhonePe UAT)

## Tech Stack
- Node.js 18+
- Express 4
- PhonePe Standard Checkout V2 API
- dotenv for secrets management

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/initiate-phonepe-payment` | Create PhonePe order → returns redirectUrl |
| GET | `/status/:merchantOrderId` | Poll order status from PhonePe |
| POST | `/callback` | PhonePe webhook (server-to-server) |
| GET | `/health` | Health check + token validity |
| GET | `/token-test` | Dev: test token generation |
| GET | `/orders` | Dev: last 20 orders list |

## 🚀 Deployment — Railway (Recommended Free)

### Step 1: GitHub pe Push karo
```bash
# payment-server folder ke andar se:
git init
git add .
git commit -m "PhonePe V2 Gateway Server"
git remote add origin https://github.com/YOUR_USERNAME/ae-payment-server.git
git push -u origin main
```

### Step 2: Railway Deploy
1. [railway.app](https://railway.app) pe jao → **GitHub se Login**
2. **New Project** → **Deploy from GitHub Repo**
3. `ae-payment-server` repo select karo
4. **Variables** tab pe jao → Add karo:

```
PHONEPE_CLIENT_ID=M22SXD53UEY41_2606112015
PHONEPE_CLIENT_SECRET=NzRjNGM1YzYtMjEwYi00ZGRhLWFjOWQtNGZjMzU4NTQwNTc3
PHONEPE_SALT_KEY=099eb0cd-02cf-4e2a-8aca-3e6c6aff0399
PHONEPE_SANDBOX=true
PORT=3001
```

5. **Settings** tab → **Generate Domain** → Copy URL
6. Ye URL hoga: `https://ae-payment-server-production.up.railway.app`

### Step 3: DNS Setup (Cloudflare)
- `pay.anshumanenterprises.online` → CNAME → `ae-payment-server-production.up.railway.app`

### Step 4: n8n-automation-pack.html Update
```javascript
const PAYMENT_SERVER = 'https://pay.anshumanenterprises.online';
```

## Environment Variables Required

```
PHONEPE_CLIENT_ID=       # PhonePe Merchant ID
PHONEPE_CLIENT_SECRET=   # PhonePe Secret Key
PHONEPE_SALT_KEY=        # Salt Key from dashboard
PHONEPE_SANDBOX=true     # false for production
PORT=3001
```

## 🔴 Production ke liye
1. PhonePe dashboard se **Production credentials** lao
2. `PHONEPE_SANDBOX=false` karo
3. Webhook URL set karo: `https://pay.anshumanenterprises.online/callback`
