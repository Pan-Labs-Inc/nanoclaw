#!/usr/bin/env bash
# acceptance_checks_sha: 37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570
# Phase N1 GATE: runs all done step acceptance scripts for phase N1
# Phase acceptance prose: run-branch HEAD contains merge of f624ee4 and origin/main;
#   npx tsc --noEmit exits 0; npx vitest run exits 0;
#   package.json and pnpm-lock.yaml byte-identical to origin/main.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

RALPH_TEST_DIR=".ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/tests"
GATE_ID="N1-GATE"
FAILING=()

echo "=== $GATE_ID: running all phase N1 acceptance scripts ==="

# Run each done step script (sorted; skip this gate script itself)
while IFS= read -r script; do
  base="$(basename "$script")"
  [[ "$base" == "N1-GATE.sh" ]] && continue
  [[ "$base" == "regression.sh" ]] && continue
  echo "--- running $base ---"
  if bash "$script"; then
    echo "PASS: $base"
  else
    echo "FAIL: $base"
    FAILING+=("$base")
  fi
done < <(find "$RALPH_TEST_DIR" -name 'N1*.sh' | sort)

if [[ ${#FAILING[@]} -gt 0 ]]; then
  echo "GATE FAIL: regressing scripts: ${FAILING[*]}"
  exit 1
fi

echo "=== All phase N1 scripts pass ==="
echo "RALPH-ACCEPTANCE-PASS $GATE_ID"
exit 0
