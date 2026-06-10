# SMS channel + admin-MCP refactor — Ralph hand-off plan

Refactor of nanoclaw PR #3 (`feat: add native sms channel`) and pantalaimon PR #261
(`feat: add sms channel integration`) per review. Two workstreams, two repos,
sequenced: **N (nanoclaw) first, P (pantalaimon) second** — P consumes the verb
contract N finalizes.

Date: 2026-06-10. Review conversation established all decisions below; do not
relitigate them — execute.

---

## Verdict already reached (context, not tasks)

- The MCP **direction is correct**: NanoClaw (owner of groups/DB/channel state)
  exposes admin verbs; Pan is a client. This is the architecture that retires the
  raw-sqlite-over-SSH workaround class (`ncl-registry.js` header lessons,
  `nanoclaw-schema-truth.test.js`, FK-safe teardown ordering).
- The PR's **interface is wrong**: Pan semantics (`pan-(teen|parent)-{fid}` regex,
  `.pan-enrollment` parsing, teen/parent persona model, opt-in record schema) are
  baked into nanoclaw source, violating the Pan/NanoClaw ownership boundary.
  Genericize the verbs; Pan keeps all Pan knowledge and passes it as data.
- Merge mechanics are a non-issue: PR #3 branched at 9ffbff7 (Baileys v7), main is
  18 ahead, `git merge-tree` is conflict-free, and the merged tree passes
  `tsc --noEmit` + full vitest (40 files / 446 tests) with **zero dependency
  changes**. Verified 2026-06-10. Do not re-derive; just merge and re-verify.
- Upstream (`qwibitai/nanoclaw`): fork is 29 ahead / 136 behind. **Do NOT do a full
  upstream sync in this run** — only the 3–4 targeted security cherry-picks in N2.
  Full sync is a filed follow-up.
- Attribution model: SMS opt-in identity = possession of the phone number declared
  in `.pan-enrollment` (TEEN_PHONE/PARENT_PHONE). Known holes: swapped numbers at
  enrollment → cross-wired privacy breach; stale control events; shared devices.
  Per-persona one-time codes and Telegram `/start`-token flow are follow-ups, not
  in-run scope (except N7 stretch).
- **Awareness inversion (register-first, born-suppressed)** — decided 2026-06-10,
  supersedes the PR's opt-in-gates-registration ordering. `dm_register` runs at
  finalize time with `require_opt_in: true`: the wiring exists immediately but the
  channel starts suppressed (NanoClaw's existing STOP/START store, fail-closed
  outbound). When the keyword arrives, NanoClaw — which now knows exactly who the
  number belongs to — flips delivery state AND seeds the owning agent's session
  ("Teen sent START") via the messages_in primitive. Consequences, all in scope:
  (a) NanoClaw's suppression/control store is the SINGLE consent record; Pan's
  derived `.sms-opt-in` file is eliminated (two records of one fact = the
  escalations.md/#587 disease). (b) Pan's polling wait-loop evaporates; activation
  completes asynchronously. (c) The freshness rule moves into NanoClaw's state
  machine: a `require_opt_in` registration activates only on a keyword event
  NEWER than the registration — a harness fact, not a Pan timestamp comparison
  (ADR 025). (d) Consent-leak guard: a suppressed registration processes ONLY
  control keywords — inbound must not trigger agent turns before activation.
  (e) `channel_control_event_get` is demoted from activation-critical polling to
  a diagnostic status read (`dm_status`). Bootstrap verbs (group_put, mounts,
  shared base, dm_register itself) are irreducible — awareness can't replace the
  structures it flows through.

## Repo / branch logistics

- **Workstream N** runs in the nanoclaw repo (`/Users/dustin/Source/pan/nanoclaw`,
  origin = `git@github.com:Pan-Labs-Inc/nanoclaw.git`). PR #3's head branch
  `feature/sms-channel-panlabs` is **in-repo** (author bluemoon/Bradford Toney).
  Create a NEW branch `feature/sms-channel-generic` from
  `merge(origin/main, refs/pull/3/head)`; open a new draft PR that supersedes #3
  and credits the original. OPERATOR DECISION at kickoff: push to Bradford's
  branch instead iff he's agreed; default = new branch.
- **Workstream P** runs in the pantalaimon repo. PR #261 (branch on origin)
  predates the env-naming standard (#678), reset-family (#674), exercise-harness
  merge (#675), and the cold-open work (#673). **Do not rebase #261.** Treat it as
  a reference implementation: branch `feature/sms-channel-generic-261` off current
  `main`, port logic file-by-file onto current idioms (normalizeEnv, runtime-paths,
  ADR 027 pinning), adapted to the N verb contract.
- Ralph execution: two sequential runs (one per repo), or one run rooted in
  pantalaimon with explicit sibling write access to `../nanoclaw` — operator picks
  at breakdown time. P must not start until N3 (contract freeze) is committed.
- Never touch `--env production`. All live verification on dev/lima/pan-test VM.

## Verb contract (freeze in N3; P codes against this)

Endpoint renamed `/webhook/pan-mcp` → `/webhook/admin-mcp`; token env
`NANOCLAW_PAN_MCP_TOKEN` → `NANOCLAW_ADMIN_MCP_TOKEN`. Tools (replacing all nine
`pan_*` tools; zero `pan` strings in nanoclaw src):

| New verb | Replaces | Notes |
|---|---|---|
| `group_put` {groupName, files[{path,contentBase64,mode}], force} | `pan_put_group` | groupName validated by nanoclaw's `isValidGroupFolder` only — no pan regex. Keep atomic staging + path-escape guards. |
| `group_file_get` {groupName, path} | `pan_sms_read_enrollment` | Raw file read inside a group dir. Pan parses. |
| `group_file_put` {groupName, path, contentBase64, mode} | `pan_sms_record_opt_in` (partially) | Atomic write, generic primitive. NOTE: no `.sms-opt-in` usage — consent state lives ONLY in NanoClaw's control store (awareness inversion). Pan must not write a derived consent file. |
| `group_mount_set` {groupName, mounts[{sourceGroup, containerPath, readonly}]} | `pan_write_parent_mount` | Must write the file container-runner ACTUALLY reads — see N4 (PR wrote `container.json`/`additionalMounts`; Pan's pipeline writes `nanoclaw-config.json`; reconcile to one truth). |
| `dm_register` {channel, address, groupName, displayName?, **require_opt_in?**} | `pan_sms_register` | Reuses internal db modules; MUST generate gateway-safe (leading-letter) ids and populate `container_configs` (the two `ncl groups create` bugs Pan's raw SQL dodges). `require_opt_in: true` → registration is born-suppressed; activates only on a control keyword NEWER than the registration (N6 state machine). |
| `shared_base_write` {marker, content} | `pan_write_shared_base` | Keep marker idempotency semantics identical to Pan's sync-global. |
| `dm_status` {channel, address} | `pan_sms_get_control_event` (demoted) | Read-only diagnostic: {registered, activationState: pending\|active\|suppressed, lastControlEvent: {keyword, at}\|null}. Consumed by doctor/status display — NOT an activation-critical polling surface; no Pan flow may gate on polling it in a loop. |
| *(dropped)* | `pan_sms_resolve_phone` | Pure Pan logic (enrollment field lookup) — moves to Pan client side. |
| *(dropped)* | `pan_sms_read_opt_in`, `pan_sms_record_opt_in` | Consent state single-sourced in NanoClaw's control store; exposed via `dm_status`. |

## Workstream N — nanoclaw

**N1. Baseline branch.** Create `feature/sms-channel-generic` =
merge(origin/main, pull/3/head).
Accept: branch exists; `npx tsc --noEmit` exit 0; `npx vitest run` all green;
`git diff origin/main...HEAD -- package.json pnpm-lock.yaml` empty.

**N2. Security cherry-picks from upstream.** Cherry-pick, resolving conflicts:
`c6627d3` (authorize create_agent host-side), `6227bd1` (approval-response admin
authz), `7d15dbc` (scope channel approval targets). Evaluate `6420c0e` (egress
lockdown, opt-in) — take it only if it applies cleanly; otherwise note in PR body.
Accept: the 3 picks present in `git log`; full suite green. If a pick conflicts
beyond mechanical resolution, STOP that pick, record why in PROGRESS, continue.

**N3. Genericize the tool surface (contract freeze).** Implement the verb table
above in `src/admin-mcp.ts` (rename from pan-mcp.ts); delete all Pan semantics
(GROUP_NAME_RE pan-regex, `.pan-enrollment` parsing, persona arg, opt-in record
rendering, `readFamilyEnrollment`). Keep timingSafeEqual auth, JSON-RPC framing,
path-safety helpers. Rewrite `src/pan-mcp.test.ts` → `src/admin-mcp.test.ts`.
Accept: `grep -ri "pan" src/admin-mcp.ts` → 0 hits (excluding none);
`test -f src/pan-mcp.ts` fails; `npx vitest run src/admin-mcp.test.ts` green;
full suite green; tools/list returns exactly the 7 contract verbs.

**N4. Mount truth.** Determine which filename/schema container-runner reads for
additional mounts (`container.json` vs `nanoclaw-config.json`; check
`src/container-runner.ts` / `materializeContainerJson` / `buildMounts`).
Make `group_mount_set` write that one; add a test that spawns the mount-resolution
code path against a fixture group and asserts the mount lands. If Pan's existing
`nanoclaw-config.json` is the live truth, the verb writes that format.
Accept: a test in admin-mcp.test.ts (or container-config test file) proves
mount-set output is consumed by the real reader function (no parallel format);
note the verdict in PR body.

**N5. Endpoint hardening.** (a) Audit log: every `tools/call` logs
{tool, groupName/channel+key, outcome} via the standard logger — phone numbers
through `redactPlatformId`. (b) Scoping: optional env
`NANOCLAW_ADMIN_MCP_GROUP_PREFIXES` (comma list); when set, group-targeting verbs
reject groups outside the prefixes. (c) Rotation: document token rotation in
.env.example + README section. Mirror the host-side re-authorization pattern from
the N2 cherry-picks where applicable.
Accept: tests prove (i) call against out-of-prefix group → error, (ii) audit line
emitted on success AND failure, (iii) raw phone never appears in log output
(test red without redaction).

**N6. Opt-in state machine + awareness seeding (the inversion's core).**
(a) Timestamps: store an ISO `at` on every control event in
`data/sms-opt-outs.json`; `dm_status` returns it. (b) Born-suppressed
registrations: `dm_register` with `require_opt_in: true` records the registration
time and starts in `pending`; it transitions to `active` ONLY on a control
keyword (START/YES) with `at` > registration time — a stale keyword event from a
previous enrollment must NOT activate (freshness is a harness fact here, not a
Pan-side check). (c) Consent-leak guard: while `pending` (and while suppressed
post-STOP), inbound on that wiring processes control keywords only — no agent
turns, no message routing to the session. (d) Awareness seeding via the existing
`messages_in` primitive (same mechanism as `ncl messages send --record` /
cold-open ADR 028): activation seeds the owning agent ("User sent START — channel
active"); post-activation STOP = turn-triggering system message ("User sent STOP —
channel suppressed; do not schedule outreach; inform counterpart agent per your
instructions"); START-after-STOP = re-activation, trigger-0 context. (e)
Enforcement (suppression store, fail-closed send) is UNCHANGED — delivery-layer
only; seeding is awareness on top, never a substitute.
Accept: unit tests — (i) keyword for unregistered number seeds nothing and
changes no state, (ii) keyword OLDER than the registration leaves state `pending`
(prove red by removing the freshness comparison), (iii) non-keyword inbound while
`pending` triggers no agent turn, (iv) fresh START flips `pending`→`active` AND
writes the activation messages_in row, (v) STOP on an active registration writes
a turn-triggering messages_in row, (vi) suppression still blocks outbound
regardless of seeding; full suite green.

**N7 (stretch — skip if N1–N6 burn the budget).** Telegram `/start <token>`
capture: recognize `/start <token>` pre-routing in the telegram adapter, record as
control event {channel:'telegram', key:token, address:chatId, at} instead of
routing to an agent session. No Pan knowledge; enables pantalaimon #630.
Accept: adapter test green; bare `/start` (no token) behaves as before.

**N8. Finish.** README + .env.example reflect renames; PR body documents the verb
contract, the supersede-of-#3 relationship, and the N4 mount verdict. Full suite +
`pnpm run build` + format check green. Open draft PR.
Accept: PR URL recorded in PROGRESS; CI green on the PR.

## Workstream P — pantalaimon

**P1. Client port.** Branch `feature/sms-channel-generic-261` off main. Port
`scripts/lib/nanoclaw-mcp.js` from #261 to the new endpoint/token/verb names.
Pan-side logic absorbed from nanoclaw: persona→phone resolution from enrollment,
opt-in record rendering/parsing (the KEY=VALUE schema from the PR), group-name
construction, `.pan-enrollment` reads via `group_file_get`.
Accept: unit tests for the client (mock fetch) covering each verb + auth header +
non-2xx throw; `npx vitest run --project=unit <explicit paths>` green. (Lesson:
never bare-keyword vitest — zero matches exits 0.)

**P2. Flow port (async-activation shape).** Port from #261 onto current main
idioms (normalizeEnv, runtime-paths, current provision.js/host.js/family-remote.js
shapes), restructured for the awareness inversion:
`add-family --channel sms` / `finalize --channel sms` register both phones at
finalize time via `dm_register {require_opt_in: true}` and EXIT with activation
pending — no wait-loop. The former `sms-opt-in` verb shrinks to a status command
(reads `dm_status`, prints pending/active per persona; optionally `--wait` for
operator convenience, but no Pan flow may *gate* on it). `register --channel sms`
likewise registers born-suppressed. Also port: host env writing
`NANOCLAW_ADMIN_MCP_TOKEN`, Twilio preflights, `sms-smoke`, docs
(`docs/ops/sms-production-acceptance.md`, updated for async activation). Non-SMS
paths keep SSH (explicitly out of scope to migrate). Drop #261's Tailscale
preflight removal if it conflicts with current host.js — current main is truth.
Accept: `./pan test --suite sms` green (port + reshape the suite from #261); full
unit suite green; `grep -rn "pan-mcp\|PAN_MCP" scripts/` → 0 hits (all renamed).

**P3. Consent single-sourcing guard (test-first).** NanoClaw's control store is
the only consent record. Pan must not write or read a derived `.sms-opt-in` file,
and no Pan code may poll `dm_status` in an activation-gating loop (status display
and an explicit operator `--wait` are the only consumers). Pin both structurally:
a source-scan guard test (remote-boundary-guard style) asserting (i) the string
`.sms-opt-in` does not appear in `scripts/` and (ii) `dm_status` callers are
limited to an allowlist (status verb, doctor). Prove the guard red by introducing
a violation, then remove it.
Accept: named describe block (`sms consent — single-sourced in NanoClaw`) green;
guard proven red in a throwaway commit noted in PROGRESS.

**P4. Guards + conventions sweep.** (a) Confirm no NEW raw SQL was introduced —
`nanoclaw-schema-truth.test.js` PAN_SQL_SOURCES unchanged or correctly extended.
(b) Commit format + issue linking per CLAUDE.md (Refs #261 lineage, Closes the
SMS issue if one exists; offer-to-create otherwise — record in PROGRESS for
operator). (c) Run review subagents on the full diff: safety-reviewer (teen
channel + suppression semantics), privacy-reviewer (parent mount verb crosses the
boundary), dev-principles-reviewer (ownership boundary now clean). Fix what they
flag or record disposition.
Accept: subagent verdicts recorded in PROGRESS with dispositions; suite green.

**P5. Finish + follow-ups.** Open draft PR (supersedes #261, links nanoclaw PR
from N8, carries #261's production-blockers list + #619 checkbox forward). File
follow-up issues: (1) Telegram `/start`-token activation reusing the
`dm_register {require_opt_in}` born-suppressed state machine (#630 work; ref N7
state), (2) full upstream sync
(29 ahead/136 behind, security fixes accumulating), (3) transport convergence —
migrate remaining raw-SQL/SSH writes (ncl-registry upserts, sessions, teardown) to
admin verbs and retire schema-snapshot guards, (4) per-persona one-time opt-in
codes ("reply START 4827") for swapped-number prevention — product decision.
Accept: PR URL + 4 issue URLs in PROGRESS.

## Gotchas for the runner

- Worktrees have no node_modules: symlink the main checkout's `scripts/node_modules`
  and run vitest with `--root <worktree>/scripts` (the --root is essential).
  nanoclaw deps: symlink works (no dep changes); UI is irrelevant here.
- `vitest run <keyword>` exits 0 on zero matches — pin tests by explicit path and
  `test -f` the file first.
- Any guard/regression test must be PROVEN RED against the unguarded code before
  counting as done (paper-tiger lesson).
- gh against nanoclaw needs `--repo Pan-Labs-Inc/nanoclaw`.
- Long local runs: caffeinate (macOS sleep trap).
- Do not modify bluemoon's `feature/sms-channel-panlabs` branch or close PRs #3 /
  #261 — supersession and closure are operator calls at review time.
