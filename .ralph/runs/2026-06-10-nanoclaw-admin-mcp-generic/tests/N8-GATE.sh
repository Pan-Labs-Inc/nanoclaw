#!/usr/bin/env bash
# acceptance_checks_sha: 9a55a5978ae124fbfd971a7feb6a70294ca2aff8ea82480985220f8cfb0deafc
# N8-GATE: phase gate — Finish: docs, build, clean feature branch, draft PR
# Runs the full accumulated test suite for phases N1-N8 (excluding GATE scripts
# to prevent cascade recursion). All scripts must exit 0 and emit their RALPH-ACCEPTANCE-PASS marker.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

RALPH_TEST_DIR=".ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/tests"
PASS=1
FAILED_STEPS=""

TSC="node_modules/.bin/tsc"
PRETTIER="node_modules/.bin/prettier"
VITEST="node_modules/.bin/vitest"

# Phase N8 prose acceptance checks
grep -qrn 'pan-mcp\|PAN_MCP' README.md .env.example 2>/dev/null && { echo "FAIL gate-no-old-name: pan-mcp or PAN_MCP found in README.md or .env.example"; PASS=0; } || echo "OK: no pan-mcp/PAN_MCP in README.md or .env.example"
grep -q 'N8 PR:' '.ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/PROGRESS.md' && echo "OK: N8 PR: line present" || { echo "FAIL gate-pr-line: N8 PR: line missing from PROGRESS.md"; PASS=0; }
"$TSC" 2>&1 | tail -5 && echo "OK: tsc build" || { echo "FAIL gate-build: tsc build failed"; PASS=0; }
"$PRETTIER" --check "src/**/*.ts" >/dev/null 2>&1 && echo "OK: format:check" || { echo "FAIL gate-format: prettier format:check failed"; PASS=0; }

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
  echo "RALPH-ACCEPTANCE-PASS N8-GATE"
  exit 0
fi
exit 1
