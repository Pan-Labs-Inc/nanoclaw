#!/usr/bin/env bash
# acceptance_checks_sha: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "N3.2 check 1: src/admin-mcp.test.ts exists"
test -f src/admin-mcp.test.ts || { echo "FAIL: src/admin-mcp.test.ts missing"; exit 1; }

echo "N3.2 check 2: path-escape rejection tests present"
grep -q "escape" src/admin-mcp.test.ts || { echo "FAIL: no path-escape test found in admin-mcp.test.ts"; exit 1; }

echo "N3.2 check 3: force semantics test present"
grep -q "force" src/admin-mcp.test.ts || { echo "FAIL: no force semantics test found in admin-mcp.test.ts"; exit 1; }

echo "N3.2 check 4: all 7 contract verbs tested"
for verb in group_put group_file_get group_file_put group_mount_set dm_register shared_base_write dm_status; do
  grep -q "$verb" src/admin-mcp.test.ts || { echo "FAIL: no test for verb $verb"; exit 1; }
done

echo "N3.2 check 5: npx vitest run src/admin-mcp.test.ts passes"
npx vitest run --reporter verbose src/admin-mcp.test.ts || { echo "FAIL: vitest admin-mcp.test.ts failed"; exit 1; }

echo "N3.2 check 6: full vitest suite passes"
npx vitest run --reporter verbose || { echo "FAIL: full vitest suite failed"; exit 1; }

echo "RALPH-ACCEPTANCE-PASS N3.2"
exit 0
