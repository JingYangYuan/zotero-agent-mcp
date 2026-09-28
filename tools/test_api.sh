#!/bin/bash
# HTTP API test suite for Zotero-Agent-MCP.
# Usage: tools/test_api.sh <token>
# Env gates: RUN_NOTE_TEST=1, CREATE_ITEM_TEST=1, SET_COLLECTIONS_TEST=1
set -u
TOKEN="${1:?usage: test_api.sh <token>}"
BASE="http://127.0.0.1:23119/zotero-agent-mcp"
AUTH="Authorization: Bearer $TOKEN"
PASS=0; FAIL=0

# Windows-friendly python detection; PYTHONUTF8 forces UTF-8 stdio for CJK asserts
PY="$(command -v python3 || command -v python)"
export PYTHONUTF8=1
TOOLDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# One-time local-API write key for collection seeding (see tools/authorize_localapi.sh)
LOCALKEY=""
if [ -f "$TOOLDIR/.localapi-key" ]; then
  LOCALKEY=$(tr -d ' \r\n' < "$TOOLDIR/.localapi-key")
fi

# Minimal but well-formed PDF WITH a text layer, so items created by the suite
# are fulltext-readable (a bare %PDF stub has no extractable text)
make_test_pdf() {
  node - "$1" <<'EOF'
const fs = require("fs");
const p = process.argv[2];
const stream = "BT /F1 24 Tf 72 720 Td (zotero-agent-mcp fulltext probe) Tj ET";
const objs = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
let out = "%PDF-1.4\n";
const offsets = [];
for (let i = 1; i <= objs.length; i++) {
  offsets[i] = out.length;
  out += `${i} 0 obj\n${objs[i - 1]}\nendobj\n`;
}
const xref = out.length;
out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
for (let i = 1; i <= objs.length; i++) out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(p, out, "latin1");
EOF
}

# like check(), but accepts a status regex (e.g. "200|404|415")
check_re() {
  local name="$1"; shift
  local expect_re="$1"; shift
  local out status body
  out=$(curl -s -m 30 -w $'\n%{http_code}' "$@")
  status=$(echo "$out" | tail -1)
  body=$(echo "$out" | sed '$d')
  if [[ "$status" =~ ^($expect_re)$ ]]; then
    PASS=$((PASS+1)); echo "PASS  [$status] $name"
  else
    FAIL=$((FAIL+1)); echo "FAIL  [$status !~ $expect_re] $name"; echo "$body" | head -c 400; echo
  fi
  LAST_BODY="$body"
}

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

KEY=$(curl -s -H "$AUTH" "$BASE/items/recent?limit=1" | "$PY" -c "import sys,json;print(json.load(sys.stdin)['items'][0]['key'])")
echo "test item key: $KEY"

check "item detail"                 200 -H "$AUTH" "$BASE/item/$KEY"
check "item bad key -> 400"         400 -H "$AUTH" "$BASE/item/XX"
check "item not found -> 404"       404 -H "$AUTH" "$BASE/item/ZZZZZZZZ"
check "children"                    200 -H "$AUTH" "$BASE/item/$KEY/children"

echo "== fulltext scope =="
# The item under test depends on library contents: accept 200, or the clean
# no-attachment / no-text-layer errors (a text-bearing assertion runs below
# against the suite's own PDF when CREATE_ITEM_TEST=1)
check_re "fulltext (auto best PDF)"  "200|404|415" -H "$AUTH" "$BASE/item/$KEY/fulltext?maxChars=5000"
check_re "fulltext offset"           "200|404|415" -H "$AUTH" "$BASE/item/$KEY/fulltext?offset=10&maxChars=500"

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
  # Zotero is a native process and cannot see MSYS /tmp — hand it a real Windows path
  TMP_PDF="${TMPDIR:-/tmp}/zotero-agent-mcp-test.pdf"
  TMP_PDF_WIN=$(cygpath -m "$TMP_PDF" 2>/dev/null || echo "$TMP_PDF")
  make_test_pdf "$TMP_PDF"
  check "create item from file -> 200" 200 -X POST -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"path\":\"$TMP_PDF_WIN\",\"title\":\"API Suite Import\",\"tags\":[\"zotero-agent-mcp-e2e\"],\"itemType\":\"document\"}" "$BASE/item"
  # v0.4.0: full metadata — fields map (invalid names skipped) + creators (Chinese single-field and Western two-field)
  check "create item fields+creators -> 200" 200 -X POST -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"path\":\"$TMP_PDF_WIN\",\"title\":\"API Suite Metadata\",\"itemType\":\"journalArticle\",\"fields\":{\"date\":\"2024\",\"publicationTitle\":\"测试期刊\",\"abstractNote\":\"abstract text\",\"DOI\":\"10.1234/test\",\"bogusField\":\"x\"},\"creators\":[{\"name\":\"张三\"},{\"firstName\":\"John\",\"lastName\":\"Smith\"}],\"tags\":[\"zotero-agent-mcp-e2e\"]}" "$BASE/item"
  if echo "$LAST_BODY" | "$PY" -c "import sys,json;d=json.load(sys.stdin);assert d.get('skippedFields')==['bogusField'],d" 2>/dev/null; then
    PASS=$((PASS+1)); echo "PASS  invalid field reported in skippedFields"
  else
    FAIL=$((FAIL+1)); echo "FAIL  invalid field reported in skippedFields"; echo "$LAST_BODY" | head -c 400; echo
  fi
  MKEY=$(echo "$LAST_BODY" | "$PY" -c "import sys,json;print(json.load(sys.stdin).get('itemKey',''))" 2>/dev/null)
  check "metadata item detail -> 200" 200 -H "$AUTH" "$BASE/item/$MKEY"
  if echo "$LAST_BODY" | "$PY" -c "import sys,json;d=json.load(sys.stdin);cs=d.get('creators',[]);assert d.get('date')=='2024' and d.get('publicationTitle')=='测试期刊' and cs and cs[0].get('name')=='张三' and any(c.get('lastName')=='Smith' for c in cs) and 'bogusField' not in d,d" 2>/dev/null; then
    PASS=$((PASS+1)); echo "PASS  metadata roundtrip (fields+creators)"
  else
    FAIL=$((FAIL+1)); echo "FAIL  metadata roundtrip (fields+creators)"; echo "$LAST_BODY" | head -c 400; echo
  fi
  check "created item fulltext -> 200" 200 -H "$AUTH" "$BASE/item/$MKEY/fulltext?maxChars=2000"
  if echo "$LAST_BODY" | "$PY" -c "import sys,json;d=json.load(sys.stdin);assert 'fulltext probe' in d.get('content',''),d" 2>/dev/null; then
    PASS=$((PASS+1)); echo "PASS  created item fulltext carries probe text"
  else
    FAIL=$((FAIL+1)); echo "FAIL  created item fulltext carries probe text"; echo "$LAST_BODY" | head -c 400; echo
  fi
  rm -f "$TMP_PDF"
else
  check "create item missing path -> 400" 400 -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' "$BASE/item"
  check "create item bad path -> 404" 404 -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{"path":"/tmp/definitely-not-here-1234.pdf"}' "$BASE/item"
fi

echo "== item collections (write, v0.4.1) =="
if [ "${SET_COLLECTIONS_TEST:-0}" = "1" ]; then
  # Idempotently ensure two e2e collections exist. Zotero 10's local API allows
  # unauthenticated reads, but writes need a persisted local key (one-time
  # "Always Allow" via tools/authorize_localapi.sh, cached in tools/.localapi-key)
  APIBASE="http://127.0.0.1:23119/api/users/0"
  SERVER_ID=$(curl -s -m 10 -D - -o /dev/null "$APIBASE/collections" | grep -i "^Zotero-Server-ID:" | tr -d '\r' | awk '{print $2}')
  COLL_HEADERS=(-H "Zotero-Server-ID: $SERVER_ID" -H "Zotero-API-Key: $LOCALKEY")
  ensure_coll() {
    local k
    k=$(curl -s -m 10 -H "Accept: application/json" "$APIBASE/collections" | "$PY" -c "import sys,json;print(next((c['key'] for c in json.load(sys.stdin) if c['data']['name']=='$1'),''))" 2>/dev/null)
    if [ -z "$k" ] && [ -n "$LOCALKEY" ]; then
      k=$(curl -s -m 10 -X POST "${COLL_HEADERS[@]}" -H "Content-Type: application/json" \
        -d "[{\"name\":\"$1\"}]" "$APIBASE/collections" | "$PY" -c "import sys,json;d=json.load(sys.stdin);print(d.get('success',{}).get('0',''))" 2>/dev/null)
    fi
    echo "$k"
  }
  COLL_A=$(ensure_coll zotero-agent-mcp-e2e-coll-a)
  COLL_B=$(ensure_coll zotero-agent-mcp-e2e-coll-b)
  if [ -z "$COLL_A" ] || [ -z "$COLL_B" ]; then
    echo "SKIP  collections cases — run tools/authorize_localapi.sh once (click 'Always Allow') to enable seeding"
  else
    echo "e2e collections: A=$COLL_A B=$COLL_B"
    # dedicated item so real library items' memberships are never touched
    TMP_PDF="${TMPDIR:-/tmp}/zotero-agent-mcp-test.pdf"
    TMP_PDF_WIN=$(cygpath -m "$TMP_PDF" 2>/dev/null || echo "$TMP_PDF")
    make_test_pdf "$TMP_PDF"
    check "collections: scratch item -> 200" 200 -X POST -H "$AUTH" -H "Content-Type: application/json" \
      -d "{\"path\":\"$TMP_PDF_WIN\",\"title\":\"API Suite Collections\",\"tags\":[\"zotero-agent-mcp-e2e\"]}" "$BASE/item"
    rm -f "$TMP_PDF"
    CKEY=$(echo "$LAST_BODY" | "$PY" -c "import sys,json;print(json.load(sys.stdin).get('itemKey',''))" 2>/dev/null)
    check "collections replace [A] -> 200" 200 -X POST -H "$AUTH" -H "Content-Type: application/json" \
      -d "{\"mode\":\"replace\",\"collections\":[\"$COLL_A\"]}" "$BASE/item/$CKEY/collections"
    if echo "$LAST_BODY" | "$PY" -c "import sys,json;d=json.load(sys.stdin);assert d['changed'] is True and [c['key'] for c in d['collections']]==['$COLL_A'],d" 2>/dev/null; then
      PASS=$((PASS+1)); echo "PASS  replace sets membership"
    else
      FAIL=$((FAIL+1)); echo "FAIL  replace sets membership"; echo "$LAST_BODY" | head -c 400; echo
    fi
    check "collections replace [A] again -> 200" 200 -X POST -H "$AUTH" -H "Content-Type: application/json" \
      -d "{\"mode\":\"replace\",\"collections\":[\"$COLL_A\"]}" "$BASE/item/$CKEY/collections"
    if echo "$LAST_BODY" | "$PY" -c "import sys,json;d=json.load(sys.stdin);assert d['changed'] is False,d" 2>/dev/null; then
      PASS=$((PASS+1)); echo "PASS  identical replace is a no-op (changed=false)"
    else
      FAIL=$((FAIL+1)); echo "FAIL  identical replace is a no-op"; echo "$LAST_BODY" | head -c 400; echo
    fi
    check "collections add [B by name] -> 200" 200 -X POST -H "$AUTH" -H "Content-Type: application/json" \
      -d "{\"mode\":\"add\",\"collections\":[\"zotero-agent-mcp-e2e-coll-b\"]}" "$BASE/item/$CKEY/collections"
    if echo "$LAST_BODY" | "$PY" -c "import sys,json;d=json.load(sys.stdin);ks=sorted(c['key'] for c in d['collections']);assert ks==sorted(['$COLL_A','$COLL_B']),d" 2>/dev/null; then
      PASS=$((PASS+1)); echo "PASS  add by exact name merges membership"
    else
      FAIL=$((FAIL+1)); echo "FAIL  add by exact name merges membership"; echo "$LAST_BODY" | head -c 400; echo
    fi
    check "collections remove [A] -> 200" 200 -X POST -H "$AUTH" -H "Content-Type: application/json" \
      -d "{\"mode\":\"remove\",\"collections\":[\"$COLL_A\"]}" "$BASE/item/$CKEY/collections"
    if echo "$LAST_BODY" | "$PY" -c "import sys,json;d=json.load(sys.stdin);assert [c['key'] for c in d['collections']]==['$COLL_B'],d" 2>/dev/null; then
      PASS=$((PASS+1)); echo "PASS  remove leaves other memberships"
    else
      FAIL=$((FAIL+1)); echo "FAIL  remove leaves other memberships"; echo "$LAST_BODY" | head -c 400; echo
    fi
    check "collections unknown -> 404" 404 -X POST -H "$AUTH" -H "Content-Type: application/json" \
      -d '{"mode":"add","collections":["NOPE"]}' "$BASE/item/$CKEY/collections"
    check "collections bad mode -> 400" 400 -X POST -H "$AUTH" -H "Content-Type: application/json" \
      -d '{"mode":"nope","collections":["x"]}' "$BASE/item/$CKEY/collections"
    check "collections empty add -> 400" 400 -X POST -H "$AUTH" -H "Content-Type: application/json" \
      -d '{"mode":"add","collections":[]}' "$BASE/item/$CKEY/collections"
  fi
else
  echo "SKIP  item collections cases (set SET_COLLECTIONS_TEST=1)"
fi

echo
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
