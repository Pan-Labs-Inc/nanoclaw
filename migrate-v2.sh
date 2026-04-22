#!/usr/bin/env bash
#
# NanoClaw v1 → v2 migration entry point.
#
# Invoked by a v1 user who wants to migrate to v2 without merging the v2
# rewrite into their existing checkout. Parallel to `nanoclaw.sh` (which
# runs a fresh setup): this one keeps the v1 tree untouched and lays a
# v2 worktree alongside it, then hands off to `pnpm run migrate:v1-to-v2`
# which owns the rest of the flow.
#
# Runs from the user's v1 project root. Expects `git` and Node ≥20 on
# PATH. Everything else (pnpm via corepack, v2 deps, the TypeScript
# driver) is set up here before handing off.
#
# Three-stage flow:
#   1. Preflight — sanity-check this looks like v1, fetch upstream/v2,
#      ensure pnpm is available via corepack.
#   2. Worktree — `git worktree add .migrate-worktree upstream/v2 --detach`
#      (or reuse an existing one if the user is resuming).
#   3. Driver — `pnpm install` in the worktree, then exec the TS driver
#      with --v1-root pointing at the original checkout.

set -euo pipefail

V1_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$V1_ROOT"

WORKTREE_DIR="$V1_ROOT/.migrate-worktree"
UPSTREAM_URL_DEFAULT="https://github.com/qwibitai/nanoclaw.git"
UPSTREAM_REF_DEFAULT="upstream/v2"

# ─── color helpers (matches nanoclaw.sh) ────────────────────────────────

use_ansi() { [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; }
dim()      { use_ansi && printf '\033[2m%s\033[0m' "$1" || printf '%s' "$1"; }
gray()     { use_ansi && printf '\033[90m%s\033[0m' "$1" || printf '%s' "$1"; }
red()      { use_ansi && printf '\033[31m%s\033[0m' "$1" || printf '%s' "$1"; }
bold()     { use_ansi && printf '\033[1m%s\033[0m' "$1" || printf '%s' "$1"; }
brand_bold() {
  if use_ansi; then
    if [ "${COLORTERM:-}" = "truecolor" ] || [ "${COLORTERM:-}" = "24bit" ]; then
      printf '\033[1;38;2;43;183;206m%s\033[0m' "$1"
    else
      printf '\033[1;36m%s\033[0m' "$1"
    fi
  else
    printf '%s' "$1"
  fi
}

step() { printf '  %s  %s\n' "$(gray '◆')" "$1"; }
ok()   { printf '  %s  %s\n' "$(gray '◇')" "$1"; }
warn() { printf '  %s  %s\n' "$(red '!')" "$1"; }
die()  { printf '\n  %s %s\n\n' "$(red '✗')" "$1"; [ "${2:-}" ] && printf '  %s\n\n' "$(dim "$2")"; exit 1; }

# ─── intro ──────────────────────────────────────────────────────────────

printf '\n  %s%s  %s\n' "$(bold 'Nano')" "$(brand_bold 'Claw')" "$(dim '· v1 → v2 migration')"
printf '  %s\n\n' "$(dim "v1 root: $V1_ROOT")"

# ─── preflight ──────────────────────────────────────────────────────────

if ! command -v git >/dev/null 2>&1; then
  die "git isn't installed." "Install git first, then re-run this script."
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  die "$V1_ROOT isn't a git repository." "Run this script from the root of your v1 NanoClaw checkout."
fi

# v1/v2 detection — refuse to run if we don't see v1 state. Mirrors the
# heuristic in setup/migrate/detect-v1.ts so false positives here don't
# surprise the driver later.
if [ -f "$V1_ROOT/data/v2.db" ] && [ ! -f "$V1_ROOT/store/messages.db" ]; then
  die "This looks like v2 already — nothing to migrate." \
      "If you want to re-seed, delete data/v2.db and re-run."
fi
if [ ! -f "$V1_ROOT/store/messages.db" ] && [ ! -f "$V1_ROOT/.env" ]; then
  die "Can't find a v1 install at $V1_ROOT." \
      "Expected to see store/messages.db. Run this from a v1 NanoClaw checkout."
fi

# Node ≥ 20 is required by the v2 trunk (see package.json engines).
if ! command -v node >/dev/null 2>&1; then
  die "Node isn't installed." "Install Node 20+ (or run bash setup.sh first) and retry."
fi
NODE_MAJOR=$(node -v | sed -E 's/^v([0-9]+)\..*/\1/')
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  die "Node $(node -v) is too old." "v2 requires Node ≥ 20. Upgrade and retry."
fi
ok "Node $(node -v)"

# Ensure `upstream` remote is configured. If missing, add the default.
# Users with a non-qwibit upstream can set it explicitly before invoking.
if ! git remote get-url upstream >/dev/null 2>&1; then
  step "Adding upstream remote → $UPSTREAM_URL_DEFAULT"
  git remote add upstream "$UPSTREAM_URL_DEFAULT"
fi
ok "upstream: $(git remote get-url upstream)"

# Let the user override the ref in case the v2 release is tagged (e.g.
# v2.0.0) or living on a non-standard branch.
UPSTREAM_REF="${NANOCLAW_V2_REF:-$UPSTREAM_REF_DEFAULT}"

step "Fetching $UPSTREAM_REF…"
# Fetch the branch by the short name the user passed (e.g. 'v2') so
# refs/remotes/upstream/v2 gets updated. If they passed 'upstream/v2',
# strip the prefix so `git fetch upstream v2` works.
FETCH_REF="${UPSTREAM_REF#upstream/}"
git fetch upstream "$FETCH_REF" --tags 2>&1 | sed 's/^/    /' || \
  die "Couldn't fetch $UPSTREAM_REF." "Check network + upstream URL, then retry."
ok "Fetched upstream/$FETCH_REF"

# ─── worktree ───────────────────────────────────────────────────────────

if [ -e "$WORKTREE_DIR" ]; then
  warn "Worktree already exists at $WORKTREE_DIR"
  printf '  %s  %s\n' "$(gray '?')" "Remove it and start fresh? [y/N] "
  read -r ANS </dev/tty
  case "${ANS:-N}" in
    [Yy]*)
      step "Removing existing worktree…"
      git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || rm -rf "$WORKTREE_DIR"
      ;;
    *)
      ok "Reusing existing worktree."
      ;;
  esac
fi

if [ ! -d "$WORKTREE_DIR" ]; then
  step "Creating v2 worktree at .migrate-worktree/"
  git worktree add "$WORKTREE_DIR" "$UPSTREAM_REF" --detach 2>&1 | sed 's/^/    /' || \
    die "Couldn't create worktree." "Inspect 'git worktree list' and 'git status', then retry."
fi
ok "Worktree ready."

cd "$WORKTREE_DIR"

# ─── pnpm via corepack ──────────────────────────────────────────────────

# v2 pins `packageManager: pnpm@10.x` in its package.json. Corepack (ships
# with Node 20+) honors that field when enabled, so we don't need to
# install pnpm globally.
step "Enabling pnpm via corepack…"
if ! corepack enable pnpm >/dev/null 2>&1; then
  # corepack is installed but may need a permissions prompt — surface any
  # error visibly instead of swallowing it.
  corepack enable pnpm || \
    die "corepack enable pnpm failed." "Run 'sudo corepack enable pnpm' manually and retry this script."
fi
ok "pnpm $(pnpm --version 2>/dev/null || echo '(version unknown)')"

# ─── install deps ───────────────────────────────────────────────────────

step "Installing v2 dependencies (pnpm install --frozen-lockfile)…"
if ! pnpm install --frozen-lockfile 2>&1 | sed 's/^/    /'; then
  die "pnpm install failed in the worktree." "See output above."
fi
ok "Dependencies installed."

# ─── hand off to the TS driver ──────────────────────────────────────────

printf '\n  %s\n\n' "$(dim 'Handing off to the migration driver…')"

# exec so Ctrl-C propagates directly to the driver and we don't waste a
# PID just holding the slot.
exec pnpm --silent run migrate:v1-to-v2 -- --v1-root "$V1_ROOT"
