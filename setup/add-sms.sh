#!/usr/bin/env bash
#
# Configure the native Twilio SMS adapter, persist credentials to .env +
# data/env/env, build, and restart the service. Non-interactive: the
# operator-facing Twilio walkthrough lives in setup/channels/sms.ts.
#
# Required env vars:
#   TWILIO_ACCOUNT_SID
#   TWILIO_AUTH_TOKEN
#   TWILIO_SMS_WEBHOOK_URL
#   TWILIO_SMS_STATUS_CALLBACK_URL  # required with TWILIO_MESSAGING_SERVICE_SID
#   TWILIO_MESSAGING_SERVICE_SID
#
# Optional env vars:
#   TWILIO_VALIDATE_SIGNATURE
#   NANOCLAW_SMS_ALLOW_PHONE_SENDER=true  # local/dev only, permits TWILIO_PHONE_NUMBER
#
# Emits exactly one status block on stdout (ADD_SMS) at the end. All chatty
# progress messages go to stderr so setup:auto's raw-log capture sees the
# full story without cluttering the final block for the parser.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

emit_status() {
  local status=$1 error=${2:-}
  local already=${ADAPTER_ALREADY_INSTALLED:-false}
  echo "=== NANOCLAW SETUP: ADD_SMS ==="
  echo "STATUS: ${status}"
  echo "ADAPTER_ALREADY_INSTALLED: ${already}"
  [ -n "${SENDER_VALUE:-}" ] && echo "SENDER: ${SENDER_VALUE}"
  [ -n "${TWILIO_SMS_WEBHOOK_URL:-}" ] && echo "WEBHOOK_URL: ${TWILIO_SMS_WEBHOOK_URL}"
  [ -n "${TWILIO_SMS_STATUS_CALLBACK_URL:-}" ] && echo "STATUS_CALLBACK_URL: ${TWILIO_SMS_STATUS_CALLBACK_URL}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}

log() { echo "[add-sms] $*" >&2; }

valid_e164() {
  [[ "$1" =~ ^\+[1-9][0-9]{7,14}$ ]]
}

valid_account_sid() {
  [[ "$1" =~ ^AC[[:xdigit:]]{32}$ ]]
}

valid_messaging_service_sid() {
  [[ "$1" =~ ^MG[[:xdigit:]]{32}$ ]]
}

valid_url() {
  node -e '
    try {
      const u = new URL(process.argv[1]);
      process.exit((u.protocol === "https:" || u.protocol === "http:") ? 0 : 1);
    } catch {
      process.exit(1);
    }
  ' "$1"
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

normalize_sms_webhook_url() {
  node -e '
    const u = new URL(process.argv[1]);
    if (!u.pathname || u.pathname === "/") u.pathname = "/webhook/sms";
    process.stdout.write(u.toString());
  ' "$1"
}

derive_status_url() {
  node -e '
    const u = new URL(process.argv[1]);
    u.pathname = u.pathname.endsWith("/") ? `${u.pathname}status` : `${u.pathname}/status`;
    process.stdout.write(u.toString());
  ' "$1"
}

if [ -z "${TWILIO_ACCOUNT_SID:-}" ]; then
  emit_status failed "TWILIO_ACCOUNT_SID env var not set"
  exit 1
fi
if ! valid_account_sid "$TWILIO_ACCOUNT_SID"; then
  emit_status failed "TWILIO_ACCOUNT_SID format invalid"
  exit 1
fi

if [ -z "${TWILIO_AUTH_TOKEN:-}" ]; then
  emit_status failed "TWILIO_AUTH_TOKEN env var not set"
  exit 1
fi
if [ "${#TWILIO_AUTH_TOKEN}" -lt 16 ]; then
  emit_status failed "TWILIO_AUTH_TOKEN format invalid"
  exit 1
fi

SENDER_VALUE=""
SENDER_KEY=""
if [ -n "${TWILIO_MESSAGING_SERVICE_SID:-}" ]; then
  if ! valid_messaging_service_sid "$TWILIO_MESSAGING_SERVICE_SID"; then
    emit_status failed "TWILIO_MESSAGING_SERVICE_SID format invalid"
    exit 1
  fi
  SENDER_KEY="TWILIO_MESSAGING_SERVICE_SID"
  SENDER_VALUE="$TWILIO_MESSAGING_SERVICE_SID"
elif [ -n "${TWILIO_PHONE_NUMBER:-}" ]; then
  if ! is_true "${NANOCLAW_SMS_ALLOW_PHONE_SENDER:-false}"; then
    emit_status failed "TWILIO_PHONE_NUMBER is local/dev only; set TWILIO_MESSAGING_SERVICE_SID for production or NANOCLAW_SMS_ALLOW_PHONE_SENDER=true for local/dev"
    exit 1
  fi
  if ! valid_e164 "$TWILIO_PHONE_NUMBER"; then
    emit_status failed "TWILIO_PHONE_NUMBER must be E.164, like +15551234567"
    exit 1
  fi
  SENDER_KEY="TWILIO_PHONE_NUMBER"
  SENDER_VALUE="$TWILIO_PHONE_NUMBER"
elif [ -n "${TWILIO_FROM_NUMBER:-}" ]; then
  if ! is_true "${NANOCLAW_SMS_ALLOW_PHONE_SENDER:-false}"; then
    emit_status failed "TWILIO_FROM_NUMBER is local/dev only; set TWILIO_MESSAGING_SERVICE_SID for production or NANOCLAW_SMS_ALLOW_PHONE_SENDER=true for local/dev"
    exit 1
  fi
  if ! valid_e164 "$TWILIO_FROM_NUMBER"; then
    emit_status failed "TWILIO_FROM_NUMBER must be E.164, like +15551234567"
    exit 1
  fi
  SENDER_KEY="TWILIO_PHONE_NUMBER"
  SENDER_VALUE="$TWILIO_FROM_NUMBER"
else
  emit_status failed "set TWILIO_MESSAGING_SERVICE_SID"
  exit 1
fi

if [ -z "${TWILIO_SMS_WEBHOOK_URL:-}" ]; then
  emit_status failed "TWILIO_SMS_WEBHOOK_URL env var not set"
  exit 1
fi
if ! valid_url "$TWILIO_SMS_WEBHOOK_URL"; then
  emit_status failed "TWILIO_SMS_WEBHOOK_URL must be an http(s) URL"
  exit 1
fi
TWILIO_SMS_WEBHOOK_URL="$(normalize_sms_webhook_url "$TWILIO_SMS_WEBHOOK_URL")"

if [ -z "${TWILIO_SMS_STATUS_CALLBACK_URL:-}" ] && [ "$SENDER_KEY" = "TWILIO_MESSAGING_SERVICE_SID" ]; then
  emit_status failed "TWILIO_SMS_STATUS_CALLBACK_URL env var not set; required for Messaging Service installs"
  exit 1
fi
if [ -z "${TWILIO_SMS_STATUS_CALLBACK_URL:-}" ]; then
  TWILIO_SMS_STATUS_CALLBACK_URL="$(derive_status_url "$TWILIO_SMS_WEBHOOK_URL")"
fi
if ! valid_url "$TWILIO_SMS_STATUS_CALLBACK_URL"; then
  emit_status failed "TWILIO_SMS_STATUS_CALLBACK_URL must be an http(s) URL"
  exit 1
fi

TWILIO_VALIDATE_SIGNATURE="${TWILIO_VALIDATE_SIGNATURE:-true}"

need_install() {
  [ ! -f src/channels/sms.ts ] && return 0
  ! grep -q "^import './sms.js';" src/channels/index.ts 2>/dev/null && return 0
  return 1
}

ADAPTER_ALREADY_INSTALLED=true
if need_install; then
  ADAPTER_ALREADY_INSTALLED=false
  if [ ! -f src/channels/sms.ts ]; then
    emit_status failed "src/channels/sms.ts is missing in this checkout"
    exit 1
  fi

  if ! grep -q "^import './sms.js';" src/channels/index.ts; then
    log "Registering SMS adapter import..."
    printf "\nimport './sms.js';\n" >> src/channels/index.ts
  fi
else
  log "SMS adapter already installed."
fi

touch .env
upsert_env() {
  local key=$1 value=$2
  if grep -q "^${key}=" .env; then
    awk -v k="$key" -v v="$value" \
        'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' \
      .env > .env.tmp && mv .env.tmp .env
  else
    echo "${key}=${value}" >> .env
  fi
}

delete_env() {
  local key=$1
  if grep -q "^${key}=" .env; then
    awk -v k="$key" 'BEGIN{FS=OFS="="} $1==k {next} {print}' \
      .env > .env.tmp && mv .env.tmp .env
  fi
}

upsert_env TWILIO_ACCOUNT_SID "$TWILIO_ACCOUNT_SID"
upsert_env TWILIO_AUTH_TOKEN "$TWILIO_AUTH_TOKEN"
upsert_env "$SENDER_KEY" "$SENDER_VALUE"
if [ "$SENDER_KEY" = "TWILIO_MESSAGING_SERVICE_SID" ]; then
  delete_env TWILIO_PHONE_NUMBER
  delete_env TWILIO_FROM_NUMBER
else
  delete_env TWILIO_MESSAGING_SERVICE_SID
fi
upsert_env TWILIO_SMS_WEBHOOK_URL "$TWILIO_SMS_WEBHOOK_URL"
upsert_env TWILIO_SMS_STATUS_CALLBACK_URL "$TWILIO_SMS_STATUS_CALLBACK_URL"
upsert_env TWILIO_VALIDATE_SIGNATURE "$TWILIO_VALIDATE_SIGNATURE"

mkdir -p data/env
cp .env data/env/env

log "Building..."
pnpm run build >&2 2>/dev/null || {
  emit_status failed "pnpm run build failed"
  exit 1
}

log "Restarting service so the SMS adapter picks up the credentials..."
# shellcheck source=setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
case "$(uname -s)" in
  Darwin)
    launchctl kickstart -k "gui/$(id -u)/$(launchd_label)" >&2 2>/dev/null || true
    ;;
  Linux)
    systemctl --user restart "$(systemd_unit)" >&2 2>/dev/null \
      || sudo systemctl restart "$(systemd_unit)" >&2 2>/dev/null \
      || true
    ;;
esac

sleep 3

emit_status success
