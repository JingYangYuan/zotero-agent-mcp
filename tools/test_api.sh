#!/bin/bash
# HTTP API test suite for Zotero-Agent-MCP.
# Usage: tools/test_api.sh <token>
set -u
TOKEN="${1:?usage: test_api.sh <token>}"
BASE="http://127.0.0.1:23119/zotero-agent-mcp"
AUTH="Authorization: Bearer $TOKEN"
PASS=0; FAIL=0

check() { # check <name> <expected_status> <curl args...>
  local name="$1"; shift
  local expect="$1"; shift
  local out status
  out=$(curl -s -m 30 -w $'\n%{http_code}' "$@")
  status=$(echo "$out" | tail -1)
  local body
  body=$(echo "$out" | sed '$d')
  if [ "$status" = "$expect" ]; then
    PASS=$((PASS+1)); echo "PASS  [$status] $name"
  else
    FAIL=$((FAIL+1)); echo "FAIL  [$status != $expect] $name"; echo "$body" | head -c 400; echo
  fi
  LAST_BODY="$body"
}

jqget() { echo "$1" | /usr/bin/python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$2" 2>/dev/null; }

echo "== auth negatives =="
check "ping public"                 200 "$BASE/ping"
check "search no token -> 401"      401 "$BASE/search?q=test"
check "search bad token -> 401"     401 -H "Authorization: Bearer WRONG" "$BASE/search?q=test"
check "libraries no token -> 401"   401 "$BASE/libraries"

echo "== read scope =="
check "libraries"                   200 -H "$AUTH" "$BASE/libraries"
check "collections user"            200 -H "$AUTH" "$BASE/collections"
check "search"                      200 -H "$AUTH" "$BASE/search?q=the&limit=3"
check "search missing q -> 400"     400 -H "$AUTH" "$BASE/search"
check "search bad library -> 400"   400 -H "$AUTH" "$BASE/search?q=a&library=zzz"
check "recent"                      200 -H "$AUTH" "$BASE/items/recent?limit=3"
check "unknown route -> 404"        404 -H "$AUTH" "$BASE/nope"

KEY=$(curl -s -H "$AUTH" "$BASE/items/recent?limit=1" | /usr/bin/python3 -c "import sys,json;print(json.load(sys.stdin)['items'][0]['key'])")
echo "test item key: $KEY"

check "item detail"                 200 -H "$AUTH" "$BASE/item/$KEY"
check "item bad key -> 400"         400 -H "$AUTH" "$BASE/item/XX"
check "item not found -> 404"       404 -H "$AUTH" "$BASE/item/ZZZZZZZZ"
check "children"                    200 -H "$AUTH" "$BASE/item/$KEY/children"

echo "== fulltext scope =="
check "fulltext (auto best PDF)"    200 -H "$AUTH" "$BASE/item/$KEY/fulltext?maxChars=5000"
check "fulltext offset"             200 -H "$AUTH" "$BASE/item/$KEY/fulltext?offset=10&maxChars=500"

echo "== annotations scope =="
check "annotations"                 200 -H "$AUTH" "$BASE/item/$KEY/annotations"

echo "== export scope =="
check "cite apa bibliography"       200 -H "$AUTH" "$BASE/item/$KEY/cite?format=bibliography&style=apa"
check "cite bibtex"                 200 -H "$AUTH" "$BASE/item/$KEY/cite?format=bibtex"
check "cite unknown style -> 400"   400 -H "$AUTH" "$BASE/item/$KEY/cite?style=nope-style"

echo "== write scope (default ON) =="
check "tag add -> 200"              200 -X POST -H "$AUTH" -H "Content-Type: application/json" -d "{\"itemKey\":\"$KEY\",\"tag\":\"zotero-agent-mcp-e2e\",\"action\":\"add\"}" "$BASE/tag"
check "tag remove -> 200"           200 -X POST -H "$AUTH" -H "Content-Type: application/json" -d "{\"itemKey\":\"$KEY\",\"tag\":\"zotero-agent-mcp-e2e\",\"action\":\"remove\"}" "$BASE/tag"
check "tag bad action -> 400"       400 -X POST -H "$AUTH" -H "Content-Type: application/json" -d "{\"itemKey\":\"$KEY\",\"tag\":\"x\",\"action\":\"nope\"}" "$BASE/tag"
if [ "${RUN_NOTE_TEST:-0}" = "1" ]; then
  check "note create -> 200"        200 -X POST -H "$AUTH" -H "Content-Type: application/json" -d "{\"itemKey\":\"$KEY\",\"html\":\"suite note\"}" "$BASE/note"
fi

echo "== files scope (default ON) =="
check "file download -> 200"        200 -H "$AUTH" "$BASE/item/$KEY/file"

echo "== local file import (write) =="
if [ "${CREATE_ITEM_TEST:-0}" = "1" ]; then
  printf '%%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%%%EOF\n' > /tmp/zotero-agent-mcp-test.pdf
  check "create item from file -> 200" 200 -X POST -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"path\":\"/tmp/zotero-agent-mcp-test.pdf\",\"title\":\"API Suite Import\",\"tags\":[\"zotero-agent-mcp-e2e\"],\"itemType\":\"document\"}" "$BASE/item"
  rm -f /tmp/zotero-agent-mcp-test.pdf
else
  check "create item missing path -> 400" 400 -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' "$BASE/item"
  check "create item bad path -> 404" 404 -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{"path":"/tmp/definitely-not-here-1234.pdf"}' "$BASE/item"
fi

echo
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
