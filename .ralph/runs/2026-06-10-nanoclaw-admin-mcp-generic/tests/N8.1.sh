#!/usr/bin/env bash
# acceptance_checks_sha: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

STEP="N8.1"
FAIL=0

fail() { echo "FAIL: $1"; FAIL=1; }

# 1. No pan-mcp/PAN_MCP strings in README.md
if git grep -q "pan-mcp\|PAN_MCP" -- README.md 2>/dev/null; then
  fail "README.md still contains pan-mcp or PAN_MCP strings"
fi

# 2. No pan-mcp/PAN_MCP strings in .env.example
if git grep -q "pan-mcp\|PAN_MCP" -- .env.example 2>/dev/null; then
  fail ".env.example still contains pan-mcp or PAN_MCP strings"
fi

# 3. No pan-mcp/PAN_MCP strings anywhere outside .ralph/ and .git/
if git grep -rn "pan-mcp\|PAN_MCP" -- ':(exclude).ralph/' ':(exclude).git/' 2>/dev/null | grep -q .; then
  echo "Remaining pan-mcp/PAN_MCP hits outside .ralph/:"
  git grep -rn "pan-mcp\|PAN_MCP" -- ':(exclude).ralph/' ':(exclude).git/' 2>/dev/null
  fail "pan-mcp or PAN_MCP strings found outside .ralph/"
fi

# 4. tsc build exits 0
TSC="node_modules/.bin/tsc"
[ -x "$TSC" ] || TSC="$(command -v tsc 2>/dev/null || true)"
if ! "$TSC" 2>&1; then
  fail "tsc build failed"
fi

# 5. format:check (prettier) exits 0
PRETTIER="node_modules/.bin/prettier"
[ -x "$PRETTIER" ] || PRETTIER="$(command -v prettier 2>/dev/null || true)"
if ! "$PRETTIER" --check "src/**/*.ts" 2>&1; then
  fail "prettier format:check failed"
fi

# 6. tsc --noEmit exits 0
if ! "$TSC" --noEmit 2>&1; then
  fail "tsc --noEmit failed"
fi

# 7. vitest run exits 0
VITEST="node_modules/.bin/vitest"
[ -x "$VITEST" ] || VITEST="$(command -v vitest 2>/dev/null || true)"
if ! "$VITEST" run 2>&1 | tail -5; then
  fail "vitest run failed"
fi

[ "$FAIL" -eq 0 ] || exit 1
echo "RALPH-ACCEPTANCE-PASS $STEP"
exit 0
