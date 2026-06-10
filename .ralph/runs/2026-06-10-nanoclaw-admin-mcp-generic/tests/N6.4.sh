#!/usr/bin/env bash
# acceptance_checks_sha: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "=== N6.4: Awareness seeding via messages_in ==="

# Check 1: seedControlEvent injectable hook exists in SmsConfig
grep -q 'seedControlEvent' src/channels/sms.ts || { echo "FAIL: seedControlEvent not found in sms.ts"; exit 1; }
echo "PASS: seedControlEvent hook present in sms.ts"

# Check 2: resolveSession imported from session-manager
grep -q 'resolveSession' src/channels/sms.ts || { echo "FAIL: resolveSession not imported in sms.ts"; exit 1; }
echo "PASS: resolveSession imported in sms.ts"

# Check 3: getMessagingGroupByPlatform imported from db
grep -q 'getMessagingGroupByPlatform' src/channels/sms.ts || { echo "FAIL: getMessagingGroupByPlatform not imported in sms.ts"; exit 1; }
echo "PASS: getMessagingGroupByPlatform imported in sms.ts"

# Check 4: seeding tests present in sms.test.ts
grep -q 'seedControlEvent' src/channels/sms.test.ts || { echo "FAIL: seedControlEvent tests not found in sms.test.ts"; exit 1; }
echo "PASS: seedControlEvent tests present in sms.test.ts"

# Check 5: tsc clean
npx tsc --noEmit || { echo "FAIL: TypeScript errors"; exit 1; }
echo "PASS: tsc clean"

# Check 6: sms tests pass (all 36+)
npx vitest run src/channels/sms.test.ts 2>&1 | tee /tmp/N6.4-vitest.out
grep -E 'Tests\s+[0-9]+ passed' /tmp/N6.4-vitest.out || { echo "FAIL: vitest did not report all passed"; exit 1; }
# Ensure at least 36 tests pass
PASSED=$(grep -E 'Tests\s+[0-9]+ passed' /tmp/N6.4-vitest.out | grep -oE '[0-9]+' | head -1)
[ "${PASSED:-0}" -ge 36 ] || { echo "FAIL: expected >=36 sms tests, got ${PASSED:-0}"; exit 1; }
echo "PASS: ${PASSED} sms tests pass"

echo "RALPH-ACCEPTANCE-PASS N6.4"
exit 0
