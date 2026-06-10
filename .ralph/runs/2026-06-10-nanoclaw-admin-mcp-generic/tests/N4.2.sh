#!/usr/bin/env bash
# acceptance_checks_sha: 4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# Check 1: test file uses materializeContainerJson (real reader, not reimplementation)
grep -q 'materializeContainerJson' src/admin-mcp.test.ts || { echo "FAIL: materializeContainerJson not found in test"; exit 1; }

# Check 2: test file calls group_mount_set
grep -q 'group_mount_set' src/admin-mcp.test.ts || { echo "FAIL: group_mount_set not found in test"; exit 1; }

# Check 3: test file asserts additionalMounts from the reader
grep -q 'additionalMounts' src/admin-mcp.test.ts || { echo "FAIL: additionalMounts assertion not found in test"; exit 1; }

# Check 4: focused vitest run passes
npx vitest run src/admin-mcp.test.ts || { echo "FAIL: vitest focused run failed"; exit 1; }

# Check 5: full vitest suite passes
npx vitest run || { echo "FAIL: full vitest suite failed"; exit 1; }

# Check 6: tsc clean
npx tsc --noEmit || { echo "FAIL: tsc --noEmit failed"; exit 1; }

echo "RALPH-ACCEPTANCE-PASS N4.2"
exit 0
