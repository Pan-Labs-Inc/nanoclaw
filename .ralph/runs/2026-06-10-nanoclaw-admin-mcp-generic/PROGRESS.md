STATUS: READY        <!-- READY | RUNNING | DONE | BLOCKED | STUCK -->
CURRENT: N1-GATE   <!-- the step a fresh round works next; never skip ahead -->

# 2026-06-10-nanoclaw-admin-mcp-generic build ledger

The **only memory between rounds**. Each round is a fresh, context-free Claude.
It learns everything from this file + this run's `spec.json` + branch git history.

## Pointers
- Run id: `2026-06-10-nanoclaw-admin-mcp-generic`  ·  Run dir: `.ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/` (all state lives here)
- Spec (source of truth): `.ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/spec.json`
- Config: `.ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/ralph.config`  ·  Overnight: `.ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/OVERNIGHT.md`
  (gitignored)  ·  Timeout sentinel: `.ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/.timeout-pending`
- Plan: `.ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/plan.md` (committed copy of ~/.claude/plans/sms-mcp-generic-refactor.md — decisions are frozen; execute, do not relitigate)
- Branch: `ralph/2026-06-10-nanoclaw-admin-mcp-generic` (per-run; commit every round here; NEVER the default
  branch)
- Multi-run: runs coexist under `.ralph/runs/<run-id>/`, each on branch
  `ralph/<run-id>`, executed one at a time. The runner resolves a run by arg /
  sole-auto / `--list` and exports `RALPH_RUN`; the step skill resolves from
  `RALPH_RUN`. Never read or write another run's dir.
- Remote: `git@github.com:Pan-Labs-Inc/nanoclaw.git`. Push every round.
- Externality roster: N8.2 (gh auth + push to Pan-Labs-Inc/nanoclaw -> operator verifies: draft PR exists with the verb-contract body + supersede credit to @bluemoon; feature/sms-channel-panlabs untouched; PR #3 still open)
- GitHub mirror: skipped — not opted in; rerun later with the mirror opted-in if wanted

## The Ralph protocol (a fresh instance follows this exactly)
1. Read this whole file. Pick the step named in `CURRENT:`. If its status is
   `in-progress`, resume it; never skip ahead.
2. **Timeout recovery first.** If `<run-dir>/.timeout-pending` exists, the prior
   round was killed by the runner's per-round timeout. Convert it to a committed
   FAIL of the named step: `rounds:+1`, append a Round-log FAIL entry
   ("round timed out (hang); no diagnosis; next instance: shrink scope or
   pre-seed a SMALLER acceptance, do NOT re-derive a larger one"), set
   `status: in-progress`; if `rounds` ≥ BREAKER_N → `status: stuck` +
   `STATUS: STUCK`. Delete the sentinel. Targeted-commit. Exit (this round IS the
   FAIL).
3. **Derive acceptance once.** If the step's `acceptance:` is empty, derive a
   concrete, mechanically-checkable criterion from the spec task body + that
   phase's `acceptance`. **Budget ≤ ~8 checks; model on prior passed steps; do
   NOT exceed.** Write it in. **Immutable thereafter** — a failed round inherits
   it verbatim, never re-derives/strengthens/softens. Also write an executable
   test at `$RALPH_TEST_DIR/<step-id>.sh` (`#!/usr/bin/env bash`; `set -uo pipefail`;
   runs the ≤8 checks; on all-pass: `echo 'RALPH-ACCEPTANCE-PASS <step-id>'` and
   exit 0; else non-zero + diagnostic). `chmod +x` (or `git update-index --chmod=+x`).
   Immutability guard: if the file already exists, never rewrite it (idempotent
   recovery). Set the acceptance ledger line to `see <path> — <one-line summary>`.
   `mkdir -p "$RALPH_TEST_DIR"` if needed (perl or git workaround if mkdir blocked).
4. Do the step's work on `ralph/<run-id>`. Stay in scope (one step only).
5. Run the acceptance check **for real**: `bash "$RALPH_TEST_DIR/<step-id>.sh"`.
   PASS iff it exits 0 AND stdout contains `RALPH-ACCEPTANCE-PASS <step-id>`.
   A check that did not run is a FAIL, not a pass. No optimistic passes.
6. Outcome:
   - **PASS** → `status: done`; Round-log entry (what shipped + how verified); set
     `CURRENT:` to the next step; **targeted** `git add` (this step's files + this
     ledger ONLY — never `git add -A`) + commit `ralph <step>: pass`; push only if
     a remote exists; exit.
   - **FAIL** → `rounds:+1`; Round-log + explicit handoff (what to try, what NOT
     to repeat); `status: in-progress`; targeted commit; exit.
   - **EXTERNAL** → make best effort + any local sanity check, then
     `status: done (needs-operator-confirm)` + note what to verify by eye + advance.
     Block (`status: blocked` + `STATUS: BLOCKED` + commit + stop) ONLY when a later
     step cannot proceed without this verification.
7. **Circuit breaker:** `rounds` ≥ BREAKER_N → `status: stuck`,
   `STATUS: STUCK`, stop.
8. **Done:** no pending/in-progress steps → `STATUS: DONE`, final summary, stop.

**Phase-GATE (when `CURRENT:` is `*-GATE`):** After re-asserting the phase
acceptance prose from `spec.json`, re-run every done step's test file for this
run: find `$RALPH_TEST_DIR` for `*.sh` files whose step is `done`; `bash` each;
all must exit 0. The whole loop is bounded by `$RALPH_GATE_TIMEOUT` (perl-alarm
shim — same pattern as the round timeout). A previously-green test that now
fails → GATE FAIL: `rounds:+1`; Round-log NAMES each regressing step; handoff:
`root cause is a later step's drift; fix THERE, never weaken the regressing
step's test`. Circuit breaker applies (unfixable regression → `STATUS: STUCK`).
GATE writes its own `<gate-id>.sh` (runs the full suite) so the GATE is
re-runnable. Regression does NOT route to G1 (re-splitting a GATE is
meaningless).

Sweep-exclusion (never `git add` unless it IS the step's deliverable):
`<run-dir>/OVERNIGHT.md`, `<run-dir>/.timeout-pending`, `bin/ralph-runner`,
operator configs, and any OTHER run's dir. Targeted add only.

## Steps (ledger order == dependency order; do not reorder)

### N1.1 — Merge PR #3 head into the run branch and verify green
- status: done
- rounds: 0
- acceptance: see .ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/tests/N1.1.sh — PR #3 head (f624ee4) merged, tsc clean, all 446 vitest tests pass, no dep drift vs origin/main
- handoff:

### N1-GATE — phase gate: Baseline: merge PR #3 head onto current main
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N2.1 — Cherry-pick upstream authz commits and record disposition
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N2-GATE — phase gate: Upstream security cherry-picks
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N3.1 — Implement the 7-verb generic surface in src/admin-mcp.ts
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N3.2 — Rewrite the endpoint test suite as src/admin-mcp.test.ts
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N3-GATE — phase gate: Contract freeze: rename to admin-mcp, 7 generic verbs, zero Pan semantics
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N4.1 — Determine the live mount-config reader and make group_mount_set write it
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N4.2 — Reader-coupled mount test
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N4-GATE — phase gate: Mount-config truth reconciliation
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N5.1 — Audit logging with platform-id redaction
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N5.2 — Group-prefix scoping + token rotation docs
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N5-GATE — phase gate: Endpoint hardening: audit log, prefix scoping, rotation docs
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N6.1 — Control-event timestamps + dm_status enrichment
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N6.2 — Born-suppressed registrations: pending until fresh keyword
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N6.3 — Consent-leak guard: keywords only while not active
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N6.4 — Awareness seeding via messages_in
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N6.5 — Six-scenario activation test file + prove freshness red
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N6-GATE — phase gate: Opt-in state machine + awareness seeding (awareness inversion core)
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N8.1 — Docs + rename sweep + release-grade verification
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N8.2 — Clean feature branch + draft PR superseding #3
- status: pending
- rounds: 0
- acceptance:
- handoff:

### N8-GATE — phase gate: Finish: docs, build, clean feature branch, draft PR
- status: pending
- rounds: 0
- acceptance:
- handoff:


## Round log (append-only; newest at bottom)
<!-- one entry per round: `#N <step> <PASS|FAIL|BLOCKED> — what happened / handoff` -->
#1 N1.1 PASS — fetched origin/main + refs/pull/3/head; merged f624ee4 (no-ff merge commit); fixed pre-existing q.test.ts env issue (spawnSync('pnpm'→tsx path) so tests run on machines without pnpm in PATH; vitest runner: vitest; 446/446 pass; tsc clean; no dep drift. Project test file: scripts/q.test.ts.
