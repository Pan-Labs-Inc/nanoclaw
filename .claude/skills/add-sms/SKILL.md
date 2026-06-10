---
name: add-sms
description: Add SMS channel integration through Twilio Programmable Messaging. Native adapter, no Chat SDK bridge.
---

# Add SMS Channel

Adds SMS support through Twilio Programmable Messaging. The adapter is native
NanoClaw code and uses only Node.js builtins plus `fetch`.

## Install

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/sms.ts` exists
- `src/channels/index.ts` contains `import './sms.js';`
- `.env` has the Twilio values listed below

Otherwise continue. Every step below is safe to re-run.

### 1. Confirm the adapter import

Append to `src/channels/index.ts` if the line is missing:

```typescript
import './sms.js';
```

### 2. Configure environment

Add to `.env`:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your-auth-token
TWILIO_MESSAGING_SERVICE_SID=MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_SMS_WEBHOOK_URL=https://your-domain/webhook/sms
TWILIO_SMS_STATUS_CALLBACK_URL=https://your-domain/webhook/sms/status
TWILIO_VALIDATE_SIGNATURE=true
```

Production SMS deployments must use `TWILIO_MESSAGING_SERVICE_SID=MG...` so
Twilio Advanced Opt-Out applies through the Messaging Service.
`TWILIO_PHONE_NUMBER=+...` is a fallback for simpler local/dev senders and
requires `NANOCLAW_SMS_ALLOW_PHONE_SENDER=true` when using `setup/add-sms.sh`.

Sync to container:

```bash
mkdir -p data/env && cp .env data/env/env
```

### 3. Build and restart

```bash
pnpm run build
```

Restart the service for the new env to load.

## Assisted setup

From an interactive setup run, choose SMS in the channel selector. Outside the
full setup flow, run the noninteractive installer with env vars:

```bash
TWILIO_ACCOUNT_SID=AC... \
TWILIO_AUTH_TOKEN=... \
TWILIO_MESSAGING_SERVICE_SID=MG... \
TWILIO_SMS_WEBHOOK_URL=https://your-domain/webhook/sms \
TWILIO_SMS_STATUS_CALLBACK_URL=https://your-domain/webhook/sms/status \
bash setup/add-sms.sh
```

For local/dev phone-number senders only, replace the Messaging Service with
`TWILIO_PHONE_NUMBER=+...` and add `NANOCLAW_SMS_ALLOW_PHONE_SENDER=true`.

Then wire a direct SMS number:

```bash
pnpm exec tsx scripts/init-first-agent.ts \
  --channel sms \
  --user-id +15557654321 \
  --platform-id +15557654321 \
  --display-name "Your Name" \
  --agent-name Nano \
  --role owner
```

Only send SMS to numbers with explicit opt-in.

## Twilio settings

Configure the same sender in Twilio Console:

- Incoming message webhook: `https://your-domain/webhook/sms`
- Status callback URL: `https://your-domain/webhook/sms/status`
- HTTP method: `POST`

For local development, expose the shared webhook server with an HTTPS tunnel
or reverse proxy. The webhook server listens on `WEBHOOK_PORT`, default `3000`.

Keep `TWILIO_VALIDATE_SIGNATURE=true`. If a proxy rewrites host, protocol, or
path, set `TWILIO_SMS_WEBHOOK_URL` and `TWILIO_SMS_STATUS_CALLBACK_URL` to the
exact public URLs configured in Twilio.

NanoClaw always enforces local STOP/START suppression. STOP-family keywords are
recorded in `data/sms-opt-outs.json`; outbound sends to those numbers are
suppressed until the number sends START. Production deployments must enable
Twilio Advanced Opt-Out on the Messaging Service and verify STOP/HELP/START
with the actual Twilio sender before launch. When Twilio sends `OptOutType`,
NanoClaw records that action without sending a second keyword reply.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `sms`
- **terminology**: One E.164 phone number is one direct SMS conversation.
- **platform-id-format**: E.164 phone number, e.g. `+15105551234`.
- **how-to-find-id**: Ask for the recipient phone number in E.164 format. There are no group IDs or thread IDs. Register SMS as a DM with `--channel sms --platform-id +15105551234 --dm`.
- **supports-threads**: no
- **typical-use**: Direct SMS with a teen, parent, operator, or other opted-in individual.
- **default-isolation**: Separate agent group for distinct humans. Reuse the same agent group only when the same person is reachable across multiple channels.
