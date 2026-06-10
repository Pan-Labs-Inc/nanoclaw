#!/usr/bin/env bash
# acceptance_checks_sha: a53818bdd8389591bc4ecbcbbeeb9f82b19d11c7561fd68956e982c155a91b00
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "=== N1.1 acceptance: PR #3 merged, tsc green, vitest green, no dep drift ==="

# n1-pr3-merged: PR #3 head sha is an ancestor of HEAD
git merge-base --is-ancestor f624ee4 HEAD || { echo "FAIL: f624ee4 not in history"; exit 1; }
echo "PASS: f624ee4 is ancestor of HEAD"

# n1-tsc: typecheck clean
npx tsc --noEmit --pretty false || { echo "FAIL: tsc errors"; exit 1; }
echo "PASS: tsc clean"

# n1-vitest: full test suite green
npx vitest run || { echo "FAIL: vitest failures"; exit 1; }
echo "PASS: vitest green"

# n1-deps-unchanged: package.json and pnpm-lock.yaml byte-identical to origin/main baseline
git diff --quiet "$(git merge-base origin/main HEAD)" HEAD -- package.json pnpm-lock.yaml || {
  echo "FAIL: package.json or pnpm-lock.yaml drifted from origin/main"
  exit 1
}
echo "PASS: no dep drift"

echo "RALPH-ACCEPTANCE-PASS N1.1"
exit 0
