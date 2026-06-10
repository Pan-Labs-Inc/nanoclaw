#!/usr/bin/env bash
# acceptance_checks_sha: 4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945
# N6-GATE: phase gate — Opt-in state machine + awareness seeding (awareness inversion core)
# Runs the full accumulated test suite for phases N1-N6 (excluding GATE scripts
# to prevent cascade recursion). All scripts must exit 0 and emit their RALPH-ACCEPTANCE-PASS marker.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

RALPH_TEST_DIR=".ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/tests"
PASS=1
FAILED_STEPS=""

# Phase N6 prose acceptance checks
grep -q 'at:' src/channels/sms.ts || { echo "FAIL gate-at-field: 'at:' not found in sms.ts"; PASS=0; }
grep -q 'activationState' src/admin-mcp.ts || { echo "FAIL gate-activation-state: activationState not in admin-mcp.ts"; PASS=0; }
grep -q 'resolveActivationState' src/channels/sms.ts || { echo "FAIL gate-resolve-activation: resolveActivationState not in sms.ts"; PASS=0; }
grep -q 'seedControlEventAwareness' src/channels/sms.ts || { echo "FAIL gate-seed-awareness: seedControlEventAwareness not in sms.ts"; PASS=0; }
test -f src/sms-activation.test.ts || { echo "FAIL gate-test-file: src/sms-activation.test.ts does not exist"; PASS=0; }
grep -q 'N6 freshness proven red' '.ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/PROGRESS.md' || { echo "FAIL gate-proven-red: N6 freshness proven red not in PROGRESS.md"; PASS=0; }

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
  echo "RALPH-ACCEPTANCE-PASS N6-GATE"
  exit 0
fi
exit 1
