#!/usr/bin/env bash
# acceptance_checks_sha: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "N3.1 check 1: src/admin-mcp.ts exists"
test -f src/admin-mcp.ts || { echo "FAIL: src/admin-mcp.ts missing"; exit 1; }

echo "N3.1 check 2: src/pan-mcp.ts is gone"
test ! -f src/pan-mcp.ts || { echo "FAIL: src/pan-mcp.ts still exists"; exit 1; }

echo "N3.1 check 3: token env var is NANOCLAW_ADMIN_MCP_TOKEN"
grep -q 'NANOCLAW_ADMIN_MCP_TOKEN' src/admin-mcp.ts || { echo "FAIL: NANOCLAW_ADMIN_MCP_TOKEN not found in src/admin-mcp.ts"; exit 1; }

echo "N3.1 check 4: no banned Pan identifiers in src/admin-mcp.ts"
if grep -qP 'pan_sms_|GROUP_NAME_RE|readFamilyEnrollment|personaArg|renderOptInRecord|pan-enrollment' src/admin-mcp.ts; then
  echo "FAIL: banned Pan identifier found in src/admin-mcp.ts:"
  grep -P 'pan_sms_|GROUP_NAME_RE|readFamilyEnrollment|personaArg|renderOptInRecord|pan-enrollment' src/admin-mcp.ts
  exit 1
fi

echo "N3.1 check 5: tsc compiles clean"
npx tsc --noEmit || { echo "FAIL: tsc --noEmit failed"; exit 1; }

echo "N3.1 check 6: admin-mcp.test.ts smoke test passes (tools/list returns 7 verbs)"
npx vitest run --reporter verbose src/admin-mcp.test.ts || { echo "FAIL: admin-mcp.test.ts failed"; exit 1; }

echo "N3.1 check 7: full vitest suite passes"
npx vitest run --reporter verbose || { echo "FAIL: full vitest suite failed"; exit 1; }

echo "RALPH-ACCEPTANCE-PASS N3.1"
exit 0
