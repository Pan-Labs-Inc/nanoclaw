#!/usr/bin/env bash
# acceptance_checks_sha: 85919a3fe6f6ed0280677308ff5270771992baf085ec7a02c574b61fa040c7cf
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

PASS=1

# n5-redact-wired
grep -q 'redactPlatformId' 'src/admin-mcp.ts' || { echo "FAIL n5-redact-wired: redactPlatformId not in src/admin-mcp.ts"; PASS=0; }

# n5-prefix-env
grep -q 'NANOCLAW_ADMIN_MCP_GROUP_PREFIXES' '.env.example' || { echo "FAIL n5-prefix-env: NANOCLAW_ADMIN_MCP_GROUP_PREFIXES not in .env.example"; PASS=0; }

# n5-prefix-wired
grep -q 'NANOCLAW_ADMIN_MCP_GROUP_PREFIXES' 'src/admin-mcp.ts' || { echo "FAIL n5-prefix-wired: NANOCLAW_ADMIN_MCP_GROUP_PREFIXES not in src/admin-mcp.ts"; PASS=0; }

# n5-readme-rotation
grep -qi 'rotat' README.md || { echo "FAIL n5-readme-rotation: no rotation content in README.md"; PASS=0; }

# n5-token-env
grep -q 'NANOCLAW_ADMIN_MCP_TOKEN' '.env.example' || { echo "FAIL n5-token-env: NANOCLAW_ADMIN_MCP_TOKEN not in .env.example"; PASS=0; }

# n5-proven-red
grep -q 'N5 redaction proven red' '.ralph/runs/2026-06-10-nanoclaw-admin-mcp-generic/PROGRESS.md' || { echo "FAIL n5-proven-red: N5 redaction proven red not in PROGRESS.md"; PASS=0; }

# n5-focused
npx vitest run src/admin-mcp.test.ts || { echo "FAIL n5-focused: vitest focused run failed"; PASS=0; }

# n5-suite
npx vitest run || { echo "FAIL n5-suite: full vitest suite failed"; PASS=0; }

if [ "$PASS" -eq 1 ]; then
  echo "RALPH-ACCEPTANCE-PASS N5.2"
  exit 0
fi
exit 1
