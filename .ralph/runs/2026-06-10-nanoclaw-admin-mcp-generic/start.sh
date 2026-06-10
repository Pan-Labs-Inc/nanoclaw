#!/usr/bin/env bash
# Per-run kickoff. One operator command that prepares the repo (allowlist +
# branch + .gitignore) and launches the Ralph loop. Idempotent — safe to re-run
# to resume after Ctrl-C, after a BLOCKED fix, or to relaunch a finished run.
#
#   bash .ralph/runs/<run-id>/start.sh
#
# Run-scoped: sources the sibling ralph.config to learn the run-id and plugin
# path, then composes the two existing idempotent tools:
#   1. $RALPH_PLUGIN_DIR/bin/ralph-setup  $RALPH_RUN_ID
#   2. $RALPH_PLUGIN_DIR/bin/ralph-supervise $RALPH_RUN_ID  (default)
#      or $RALPH_PLUGIN_DIR/bin/ralph-runner $RALPH_RUN_ID  (fallback / opt-out)
#
# Knobs:
#   RALPH_SUPERVISE=0  — skip the supervisor; run a single ralph-runner pass
#   RALPH_NTFY=<topic> — push ntfy notifications (honored by ralph-supervise)
#
# Worktree mode is a separate path — provision with `ralph-worktree add`, then
# run this script from inside the worktree (the per-worktree ralph.config
# rewrite is honored automatically).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$SCRIPT_DIR/ralph.config"
[ -f "$CFG" ] || { echo "✗ no ralph.config next to start.sh ($CFG)"; exit 1; }
# shellcheck disable=SC1090
. "$CFG"

: "${RALPH_RUN_ID:?ralph.config missing RALPH_RUN_ID}"
: "${RALPH_PLUGIN_DIR:?ralph.config missing RALPH_PLUGIN_DIR}"

bash "$RALPH_PLUGIN_DIR/bin/ralph-setup" "$RALPH_RUN_ID" || exit $?

SUPERVISE="${RALPH_SUPERVISE:-1}"
SUPERVISOR="$RALPH_PLUGIN_DIR/bin/ralph-supervise"

if [ "$SUPERVISE" = "0" ]; then
  exec "$RALPH_PLUGIN_DIR/bin/ralph-runner" "$RALPH_RUN_ID"
elif [ -x "$SUPERVISOR" ]; then
  exec "$SUPERVISOR" "$RALPH_RUN_ID"
else
  echo "⚠ ralph-supervise unavailable — falling back to a single ralph-runner pass"
  exec "$RALPH_PLUGIN_DIR/bin/ralph-runner" "$RALPH_RUN_ID"
fi
