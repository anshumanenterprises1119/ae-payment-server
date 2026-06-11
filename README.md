# Anshuman Enterprises — PhonePe Gateway Server

Node.js + Express backend for PhonePe V2 Payment Gateway integration.

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
| GET | `/health` | Health check |
| GET | `/token-test` | Dev: test token generation |

## Deployment

### Railway (Recommended)

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app)
3. New Project → Deploy from GitHub
4. Add Environment Variables (from .env.example)
5. Done ✅

### Environment Variables Required

```
PHONEPE_CLIENT_ID=
PHONEPE_CLIENT_SECRET=
PHONEPE_SALT_KEY=
PHONEPE_SANDBOX=false
PORT=3001
```
