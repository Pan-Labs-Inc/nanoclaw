#!/usr/bin/env bash
# regression.sh — runs all project test files registered in manifest.json
# Updated at N6-GATE pass. Re-run any time to verify no regressions.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

RALPH_TEST_DIR=".ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/tests"
MANIFEST="$RALPH_TEST_DIR/manifest.json"
FAILING=()

echo "=== regression suite: running project test files from manifest ==="

# Read manifest and run each project test file with vitest
while IFS="=" read -r step_id test_path; do
  echo "--- $step_id: npx vitest run $test_path ---"
  if npx vitest run "$test_path"; then
    echo "PASS: $test_path"
  else
    echo "FAIL: $test_path"
    FAILING+=("$test_path")
  fi
done < <(python3 -c "
import json, sys
m = json.load(open('$MANIFEST'))
for k,v in m.items():
    print(f'{k}={v}')
")

if [[ ${#FAILING[@]} -gt 0 ]]; then
  echo "regression suite: FAIL — regressing files: ${FAILING[*]}"
  exit 1
fi

echo "regression suite: all pass"
exit 0
