#!/usr/bin/env bash
# acceptance_checks_sha: 4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. sms.ts writes 'at:' field in controlEvents (persisted on every control event)
grep -q "at: now" src/channels/sms.ts || fail "src/channels/sms.ts does not write 'at: now' in recordSmsControlEvent"

# 2. admin-mcp.ts dmStatusTool reads event.at (not just event.receivedAt)
grep -q "event\.at" src/admin-mcp.ts || fail "src/admin-mcp.ts does not use event.at in dmStatusTool"

# 3. test file covers lastControlEvent.at field
grep -q "lastControlEvent" src/admin-mcp.test.ts || fail "src/admin-mcp.test.ts does not test lastControlEvent"
grep -q "\.at\b" src/admin-mcp.test.ts || fail "src/admin-mcp.test.ts does not assert .at field on lastControlEvent"

# 4. test file covers activationState: pending
grep -q "pending" src/admin-mcp.test.ts || fail "src/admin-mcp.test.ts does not test activationState 'pending'"

# 5. tsc clean
npx tsc -p tsconfig.json --noEmit || fail "tsc reported errors"

# 6. vitest passes (all admin-mcp tests including new timestamp + pending tests)
npx vitest run src/admin-mcp.test.ts || fail "vitest admin-mcp tests failed"

echo "RALPH-ACCEPTANCE-PASS N6.1"
exit 0
