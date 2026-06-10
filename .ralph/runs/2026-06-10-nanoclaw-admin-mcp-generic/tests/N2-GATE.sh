#!/usr/bin/env bash
# acceptance_checks_sha: 37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570
# Phase N2 GATE: runs all done step acceptance scripts accumulated through phase N2.
# Phase acceptance prose: PROGRESS.md carries 'N2 cherry-pick disposition:' line naming
#   each of c6627d3, 6227bd1, 7d15dbc, 6420c0e as taken or abandoned-with-reason;
#   npx vitest run and npx tsc --noEmit exit 0 after the picks.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

RALPH_TEST_DIR=".ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/tests"
GATE_ID="N2-GATE"
FAILING=()

echo "=== $GATE_ID: running all accumulated step acceptance scripts ==="

# Run each done step script (sorted; skip this gate script and regression.sh)
while IFS= read -r script; do
  base="$(basename "$script")"
  [[ "$base" == "N2-GATE.sh" ]] && continue
  [[ "$base" == "regression.sh" ]] && continue
  echo "--- running $base ---"
  if bash "$script"; then
    echo "PASS: $base"
  else
    echo "FAIL: $base"
    FAILING+=("$base")
  fi
done < <(find "$RALPH_TEST_DIR" -name '*.sh' | sort)

if [[ ${#FAILING[@]} -gt 0 ]]; then
  echo "GATE FAIL: regressing scripts: ${FAILING[*]}"
  exit 1
fi

echo "=== All accumulated step scripts pass ==="
echo "RALPH-ACCEPTANCE-PASS $GATE_ID"
exit 0
