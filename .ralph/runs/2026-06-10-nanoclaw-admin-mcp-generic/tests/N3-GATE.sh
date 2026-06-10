#!/usr/bin/env bash
# acceptance_checks_sha: 37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570
# Phase N3 GATE: runs all accumulated STEP acceptance scripts through phase N3.
# Skips earlier GATE scripts (*-GATE.sh) to prevent recursive re-invocation.
# Phase acceptance prose:
#   src/admin-mcp.ts exists and src/pan-mcp.ts does not;
#   tools/list returns exactly {group_put, group_file_get, group_file_put,
#     group_mount_set, dm_register, shared_base_write, dm_status};
#   endpoint path is /webhook/admin-mcp, token env is NANOCLAW_ADMIN_MCP_TOKEN;
#   none of the deleted Pan identifiers appear in src/admin-mcp.ts;
#   npx vitest run src/admin-mcp.test.ts and the full suite exit 0.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

RALPH_TEST_DIR=".ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/tests"
GATE_ID="N3-GATE"
FAILING=()

echo "=== $GATE_ID: running all accumulated step acceptance scripts (skipping gate scripts to prevent recursion) ==="

# Run each done step script (sorted; skip gate scripts and regression.sh to avoid cascade recursion)
while IFS= read -r script; do
  base="$(basename "$script")"
  [[ "$base" == *"-GATE.sh" ]] && continue
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
