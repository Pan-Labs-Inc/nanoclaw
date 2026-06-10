#!/usr/bin/env bash
# acceptance_checks_sha: 38607cac927b611d1cb971ea7a08d1aa98c71439e48a99f44641d002abeddfad
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# Check 1: disposition line present in PROGRESS.md
grep -q 'N2 cherry-pick disposition:' .ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/PROGRESS.md || {
  echo "FAIL: no 'N2 cherry-pick disposition:' line found in PROGRESS.md"
  exit 1
}

# Check 2: tsc clean
npx tsc --noEmit --pretty false || {
  echo "FAIL: tsc --noEmit failed"
  exit 1
}

# Check 3: vitest pass
npx vitest run || {
  echo "FAIL: vitest run failed"
  exit 1
}

echo "RALPH-ACCEPTANCE-PASS N2.1"
exit 0
