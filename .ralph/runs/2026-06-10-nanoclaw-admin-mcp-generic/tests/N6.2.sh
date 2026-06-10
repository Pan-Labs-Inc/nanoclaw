#!/usr/bin/env bash
# acceptance_checks_sha: 37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# Check 1: require_opt_in in admin-mcp.ts
grep -q 'require_opt_in' src/admin-mcp.ts || { echo "FAIL: require_opt_in not found in admin-mcp.ts"; exit 1; }

# Check 2: stale-event test present in test file
grep -q 'stale START event' src/admin-mcp.test.ts || { echo "FAIL: stale START event test not found"; exit 1; }

# Check 3: run admin-mcp tests (includes 2 new stale-event tests)
npx vitest run src/admin-mcp.test.ts || { echo "FAIL: admin-mcp tests failed"; exit 1; }

# Check 4: tsc clean
npx tsc --noEmit || { echo "FAIL: tsc errors"; exit 1; }

echo "RALPH-ACCEPTANCE-PASS N6.2"
exit 0
