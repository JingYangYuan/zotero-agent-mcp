#!/bin/bash
# One-time setup: obtain a persistent Zotero local-API write key for the e2e suites.
#
# Zotero 10's local API allows unauthenticated reads, but writes (e.g. creating the
# e2e collections for the set_item_collections tests) require a local API key and a
# matching Zotero-Server-ID header. This script triggers Zotero's authorization
# prompt — **click "Always Allow" (始终允许)** in the Zotero window — and caches the
# returned key in tools/.localapi-key (gitignored). The suites pick it up on every
# later run; no further interaction needed.
#
# Usage: tools/authorize_localapi.sh
set -euo pipefail
TOOLDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APIBASE="http://127.0.0.1:23119/api/users/0"

SERVER_ID=$(curl -s -m 10 -D - -o /dev/null "$APIBASE/collections" | grep -i "^Zotero-Server-ID:" | tr -d '\r' | awk '{print $2}')
if [ -z "$SERVER_ID" ]; then
  echo "ERROR: Zotero is not reachable at 127.0.0.1:23119 (running? plugin enabled?)"
  exit 1
fi

echo "A Zotero dialog will now ask about access for 'zotero-agent-mcp-e2e' —"
echo "**click 'Always Allow' / 始终允许** so future test runs need no interaction."
RESP=$(curl -s -m 180 -X POST -H "Zotero-Server-ID: $SERVER_ID" -H "Content-Type: application/json" \
  -d '{"appName":"zotero-agent-mcp-e2e"}' "http://127.0.0.1:23119/api/local/authorize")

PY="$(command -v python3 || command -v python)"
KEY=$(echo "$RESP" | PYTHONUTF8=1 "$PY" -c "import sys,json;d=json.load(sys.stdin);print(d.get('key',''))" 2>/dev/null || true)
if [ -z "$KEY" ]; then
  echo "ERROR: no key returned. Raw response: $RESP"
  echo "(If Zotero shows {\"denied\":true}, the prompt was dismissed — rerun and pick 'Always Allow'.)"
  exit 1
fi

umask 077
printf '%s' "$KEY" > "$TOOLDIR/.localapi-key"
echo "OK: persistent local-API key cached to $TOOLDIR/.localapi-key"
