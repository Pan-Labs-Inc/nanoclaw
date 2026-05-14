# Remove SMS

1. Comment out `import './sms.js'` in `src/channels/index.ts`.
2. Remove `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`,
   `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_SMS_WEBHOOK_URL`,
   `TWILIO_SMS_STATUS_CALLBACK_URL`, and `TWILIO_VALIDATE_SIGNATURE` from `.env`.
3. Sync env and restart:

```bash
mkdir -p data/env && cp .env data/env/env
pnpm run build
```
