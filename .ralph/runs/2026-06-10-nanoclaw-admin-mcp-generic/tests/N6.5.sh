#!/usr/bin/env bash
# acceptance_checks_sha: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# 1. sms-activation.test.ts exists
test -f src/sms-activation.test.ts || { echo "FAIL: src/sms-activation.test.ts missing"; exit 1; }

# 2. sms-activation.test.ts passes
npx vitest run src/sms-activation.test.ts || { echo "FAIL: sms-activation.test.ts tests failed"; exit 1; }

# 3. PROGRESS.md carries proven-red evidence
grep -q 'N6 freshness proven red' .ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/PROGRESS.md \
  || { echo "FAIL: N6 freshness proven red ledger line missing"; exit 1; }

# 4. full suite green
npx vitest run || { echo "FAIL: full vitest suite failed"; exit 1; }

echo "RALPH-ACCEPTANCE-PASS N6.5"
exit 0
