# 🔌 PhonePe V2 Payment Server

This Node.js/Express server implements the PhonePe Standard Checkout API (V2) integration.

## Key Flow
1. Fetch Access Token via OAuth V2
2. Create Order page checkout link
3. Handle basic auth callback webhooks
4. Check payment status on demand

## Setup
1. Run `npm install`
2. Create `.env` file from `.env.example`
3. Run `npm start`
