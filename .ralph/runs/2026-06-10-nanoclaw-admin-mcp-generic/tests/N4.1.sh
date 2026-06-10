#!/usr/bin/env bash
# acceptance_checks_sha: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# 1. Verdict line present in PROGRESS.md
grep -q 'N4 mount verdict:' .ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/PROGRESS.md \
  || { echo "FAIL: N4 mount verdict line missing from PROGRESS.md"; exit 1; }

# 2. group_mount_set writes to DB via updateContainerConfigJson (not container.json)
grep -q 'updateContainerConfigJson' src/admin-mcp.ts \
  || { echo "FAIL: admin-mcp.ts does not call updateContainerConfigJson"; exit 1; }

# 3. No direct container.json write in groupMountSetTool
# Check that the writeFileSync of container.json is gone from the mount section
! grep -A 30 'function groupMountSetTool' src/admin-mcp.ts | grep -q "writeFileSync.*container\.json" \
  || { echo "FAIL: groupMountSetTool still writes container.json directly"; exit 1; }

# 4. tsc clean
npx tsc --noEmit || { echo "FAIL: tsc errors"; exit 1; }

# 5. focused test run
npx vitest run src/admin-mcp.test.ts || { echo "FAIL: admin-mcp.test.ts failures"; exit 1; }

# 6. full suite
npx vitest run || { echo "FAIL: vitest suite failures"; exit 1; }

echo "RALPH-ACCEPTANCE-PASS N4.1"
exit 0
