#!/usr/bin/env bash
# N5-GATE: phase gate — endpoint hardening: audit log, prefix scoping, rotation docs
# Runs the full accumulated test suite for phases N1-N5 (excluding GATE scripts
# to prevent cascade recursion). All scripts must exit 0 and emit their RALPH-ACCEPTANCE-PASS marker.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

RALPH_TEST_DIR=".ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/tests"
PASS=1
FAILED_STEPS=""

# Phase prose acceptance checks
grep -q 'admin-mcp audit' src/admin-mcp.ts || { echo "FAIL gate-audit-call: admin-mcp audit call missing in admin-mcp.ts"; PASS=0; }
grep -q 'redactPlatformId' src/admin-mcp.ts || { echo "FAIL gate-redact: redactPlatformId not in admin-mcp.ts"; PASS=0; }
grep -q 'NANOCLAW_ADMIN_MCP_GROUP_PREFIXES' src/admin-mcp.ts || { echo "FAIL gate-prefixes: NANOCLAW_ADMIN_MCP_GROUP_PREFIXES not in admin-mcp.ts"; PASS=0; }
grep -q 'NANOCLAW_ADMIN_MCP_TOKEN' .env.example || { echo "FAIL gate-token-env: NANOCLAW_ADMIN_MCP_TOKEN not in .env.example"; PASS=0; }
grep -q 'NANOCLAW_ADMIN_MCP_GROUP_PREFIXES' .env.example || { echo "FAIL gate-prefix-env: NANOCLAW_ADMIN_MCP_GROUP_PREFIXES not in .env.example"; PASS=0; }
grep -qi 'rotat' README.md || { echo "FAIL gate-readme-rotation: no rotation content in README.md"; PASS=0; }
grep -q 'N5 redaction proven red' '.ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/PROGRESS.md' || { echo "FAIL gate-proven-red: N5 redaction proven red not in PROGRESS.md"; PASS=0; }

# Full accumulated test suite (non-GATE scripts only)
for f in $(find "$RALPH_TEST_DIR" -name '*.sh' | grep -v '\-GATE\.sh' | sort); do
  step=$(basename "$f" .sh)
  echo "--- $step ---"
  if bash "$f"; then
    echo "OK: $step"
  else
    echo "FAIL: $step"
    PASS=0
    FAILED_STEPS="$FAILED_STEPS $step"
  fi
done

if [ -n "$FAILED_STEPS" ]; then
  echo "GATE FAIL — regressing steps:$FAILED_STEPS"
fi

if [ "$PASS" -eq 1 ]; then
  echo "RALPH-ACCEPTANCE-PASS N5-GATE"
  exit 0
fi
exit 1
