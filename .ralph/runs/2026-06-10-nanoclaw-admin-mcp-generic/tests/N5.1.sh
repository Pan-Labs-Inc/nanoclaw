#!/usr/bin/env bash
# acceptance_checks_sha: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

STEP="N5.1"
FAIL=0

# 1. admin-mcp.ts imports redactPlatformId
grep -q "redactPlatformId" src/admin-mcp.ts || { echo "FAIL: redactPlatformId not imported/used in admin-mcp.ts"; FAIL=1; }

# 2. admin-mcp.ts imports log
grep -q "from './log.js'" src/admin-mcp.ts || { echo "FAIL: log not imported in admin-mcp.ts"; FAIL=1; }

# 3. audit log call present
grep -q "admin-mcp audit" src/admin-mcp.ts || { echo "FAIL: 'admin-mcp audit' log call not found in admin-mcp.ts"; FAIL=1; }

# 4. PROGRESS.md carries N5 redaction proven red
grep -q "N5 redaction proven red" .ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/PROGRESS.md || { echo "FAIL: 'N5 redaction proven red' line missing from PROGRESS.md"; FAIL=1; }

# 5. tsc clean
node_modules/.bin/tsc --noEmit > /dev/null 2>&1 || { echo "FAIL: tsc errors"; FAIL=1; }

# 6. vitest passes (scoped to admin-mcp.test.ts)
node_modules/.bin/vitest run src/admin-mcp.test.ts > /dev/null 2>&1 || { echo "FAIL: admin-mcp vitest tests failed"; FAIL=1; }

[ "$FAIL" -eq 0 ] || exit 1
echo "RALPH-ACCEPTANCE-PASS ${STEP}"
exit 0
