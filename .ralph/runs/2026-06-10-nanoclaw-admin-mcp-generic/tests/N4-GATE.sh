#!/usr/bin/env bash
# acceptance_checks_sha: 37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
RUN_DIR=".ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic"
TEST_DIR="$RUN_DIR/tests"

# Phase N4 prose acceptance:
# PROGRESS.md carries a line beginning 'N4 mount verdict:' naming the exact filename
# and code path container-runner reads for additional mounts; group_mount_set writes
# that file format; a vitest test feeds a fixture group written by group_mount_set
# through the real reader function (materializeContainerJson/buildMounts code path,
# not a reimplementation) and asserts the mount appears; npx vitest run exits 0.

FAILED=()

# Run all step test scripts (excluding *-GATE.sh to prevent cascade recursion)
for script in $(find "$TEST_DIR" -name '*.sh' | grep -v '\-GATE\.sh' | sort); do
  echo "=== $script ==="
  if bash "$script" 2>&1 | tail -3; then
    echo "OK"
  else
    echo "FAIL"
    FAILED+=("$script")
  fi
done

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "GATE FAIL — regressing scripts: ${FAILED[*]}"
  exit 1
fi

# Explicit prose checks
grep -q 'N4 mount verdict:' "$RUN_DIR/PROGRESS.md" || { echo "FAIL: N4 mount verdict line missing"; exit 1; }
grep -qE 'materializeContainerJson|buildMounts' src/admin-mcp.test.ts || { echo "FAIL: reader-coupled check missing"; exit 1; }
npx vitest run src/admin-mcp.test.ts 2>&1 | tail -5 || { echo "FAIL: focused vitest run"; exit 1; }
npx vitest run 2>&1 | tail -5 || { echo "FAIL: full vitest suite"; exit 1; }

echo "RALPH-ACCEPTANCE-PASS N4-GATE"
exit 0
