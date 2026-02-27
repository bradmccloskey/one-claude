#!/bin/bash
# register-remote — Register a Claude Code remote control URL with the orchestrator.
#
# Usage:
#   register-remote <url> [label]
#
# Examples:
#   register-remote "https://claude.ai/code?bridge=abc123" "crypto-trader"
#   register-remote "https://claude.ai/code?bridge=abc123"
#
# The URL will appear on the orchestrator dashboard at orch.mccloskey-api.com
# and auto-expire after 24 hours.
#
# Installation (add to ~/.zshrc):
#   source ~/projects/infra/project-orchestrator/scripts/register-remote.sh

ORCH_URL="${ORCH_URL:-http://localhost:8051}"

register-remote() {
  local url="$1"
  local label="${2:-}"

  if [ -z "$url" ]; then
    echo "Usage: register-remote <url> [label]"
    echo "  url   — Claude Code remote control URL (https://claude.ai/code?bridge=...)"
    echo "  label — Optional label for the session"
    return 1
  fi

  # Build JSON payload
  local json
  if [ -n "$label" ]; then
    json="{\"url\":\"${url}\",\"label\":\"${label}\"}"
  else
    json="{\"url\":\"${url}\"}"
  fi

  local response
  response=$(curl -s -w "\n%{http_code}" -X POST "${ORCH_URL}/api/remote-sessions" \
    -H "Content-Type: application/json" \
    -d "$json" 2>&1)

  local http_code
  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | head -n -1)

  if [ "$http_code" = "201" ]; then
    echo "Registered remote session"
    echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  Label: {d[\"label\"]}'); print(f'  ID:    {d[\"id\"]}'); print(f'  URL:   {d[\"url\"]}')" 2>/dev/null || echo "$body"
  else
    echo "Failed to register (HTTP $http_code)"
    echo "$body"
    return 1
  fi
}

# Also provide a list command
list-remotes() {
  local response
  response=$(curl -s "${ORCH_URL}/api/remote-sessions" 2>&1)
  echo "$response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
registered = d.get('registered', [])
if not registered:
    print('No remote sessions registered')
else:
    for r in registered:
        alive = 'alive' if r.get('alive') else 'ended' if r.get('alive') is False else '?'
        print(f'  [{alive}] {r[\"label\"]:20s} {r[\"url\"]}')
" 2>/dev/null || echo "$response"
}

# Unregister by ID
unregister-remote() {
  local id="$1"
  if [ -z "$id" ]; then
    echo "Usage: unregister-remote <id>"
    return 1
  fi
  curl -s -X DELETE "${ORCH_URL}/api/remote-sessions/${id}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('Removed' if d.get('ok') else d.get('error','Unknown error'))" 2>/dev/null
}
