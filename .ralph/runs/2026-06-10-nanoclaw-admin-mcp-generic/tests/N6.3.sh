#!/usr/bin/env bash
# acceptance_checks_sha: 37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# Check 1: consent gate present in sms.ts (resolveActivationState or checkActivationState used in handler)
grep -q 'activationState' src/channels/sms.ts || { echo "FAIL: consent gate (activationState check) not found in sms.ts"; exit 1; }

# Check 2: pending gate test present in sms.test.ts
grep -q 'pending' src/channels/sms.test.ts || { echo "FAIL: pending gate test not found in sms.test.ts"; exit 1; }

# Check 3: suppressed gate test present in sms.test.ts
grep -q 'suppressed' src/channels/sms.test.ts || { echo "FAIL: suppressed gate test not found in sms.test.ts"; exit 1; }

# Check 4: run sms tests (includes new consent-gate tests)
npx vitest run src/channels/sms.test.ts || { echo "FAIL: sms tests failed"; exit 1; }

# Check 5: tsc clean
npx tsc --noEmit || { echo "FAIL: tsc errors"; exit 1; }

echo "RALPH-ACCEPTANCE-PASS N6.3"
exit 0
