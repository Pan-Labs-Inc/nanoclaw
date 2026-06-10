# Verify SMS

1. Confirm the service is running and the adapter started:

```bash
grep "SMS adapter initialized" logs/nanoclaw.log
```

2. Send a text to the Twilio sender. NanoClaw should respond within a few seconds.

3. Confirm status callbacks are being accepted:

```bash
grep "Twilio SMS delivery status received" logs/nanoclaw.log
```

If inbound messages are rejected with signature errors, compare the Twilio
Console webhook URL with `TWILIO_SMS_WEBHOOK_URL` exactly.
