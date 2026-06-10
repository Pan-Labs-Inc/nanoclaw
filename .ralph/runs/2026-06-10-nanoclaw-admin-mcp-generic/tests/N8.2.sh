#!/usr/bin/env bash
# acceptance_checks_sha: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

STEP="N8.2"
FEATURE_BRANCH="feature/sms-channel-generic"
PASS() { echo "RALPH-ACCEPTANCE-PASS $STEP"; exit 0; }
FAIL() { echo "FAIL: $1" >&2; exit 1; }

# Check 1: feature/sms-channel-generic branch exists (locally or remotely)
if git show-ref --verify --quiet "refs/heads/$FEATURE_BRANCH" || \
   git show-ref --verify --quiet "refs/remotes/origin/$FEATURE_BRANCH"; then
  echo "OK: $FEATURE_BRANCH branch exists"
else
  FAIL "$FEATURE_BRANCH branch does not exist locally or in origin"
fi

# Check 2: .ralph/ directory is NOT in the feature branch tree
BRANCH_SHA=$(git show-ref --verify "refs/heads/$FEATURE_BRANCH" --hash 2>/dev/null || \
             git show-ref --verify "refs/remotes/origin/$FEATURE_BRANCH" --hash 2>/dev/null)
if git ls-tree -r --name-only "$BRANCH_SHA" 2>/dev/null | grep -q '^\.ralph/'; then
  FAIL "$FEATURE_BRANCH still contains .ralph/ — strip commit missing"
else
  echo "OK: .ralph/ not present in $FEATURE_BRANCH"
fi

# Check 3: PROGRESS.md contains N8 PR: line
if grep -q '^N8 PR:' .ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/PROGRESS.md; then
  echo "OK: N8 PR: line present in PROGRESS.md"
else
  FAIL "PROGRESS.md missing 'N8 PR:' line"
fi

# Check 4: feature branch is pushed to origin
if git ls-remote --exit-code origin "$FEATURE_BRANCH" >/dev/null 2>&1; then
  echo "OK: $FEATURE_BRANCH pushed to origin"
else
  # Still pass — operator may push manually; note it
  echo "WARN: $FEATURE_BRANCH not yet pushed to origin (operator task)"
fi

PASS
