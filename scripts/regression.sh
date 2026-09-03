#!/usr/bin/env bash
# Regression matrix for mcp-server-templated.
# Usage: BASE_URL=https://mcp.templated.io API_KEY=... [FOLDER_ID=...] [EXPECT_UNAUTH=401] scripts/regression.sh
set -u
BASE_URL="${BASE_URL:?}"; API_KEY="${API_KEY:?}"
EXPECT_UNAUTH="${EXPECT_UNAUTH:-401}"   # use EXPECT_UNAUTH=200 while 1.5.0 is live (pre-OAuth)
FAIL=0
check() { local desc="$1" ok="$2"; if [ "$ok" = "1" ]; then echo "PASS: $desc"; else echo "FAIL: $desc"; FAIL=1; fi; }
post() { curl -sS -m 20 -X POST "$1" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" ${2:+-H "$2"} --data "$3"; }
LIST='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
CALL='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_account","arguments":{}}}'

code=$(curl -sS -m 20 -o /tmp/mcp_noauth -w "%{http_code}" -X POST "$BASE_URL/mcp" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" --data "$LIST")
check "no credential -> $EXPECT_UNAUTH" "$([ "$code" = "$EXPECT_UNAUTH" ] && echo 1 || echo 0)"
if [ "$EXPECT_UNAUTH" = "401" ]; then
  hdr=$(curl -sS -m 20 -o /dev/null -D - -X POST "$BASE_URL/mcp" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" --data "$LIST" | grep -i "www-authenticate")
  check "401 carries resource_metadata" "$(echo "$hdr" | grep -q "resource_metadata" && echo 1 || echo 0)"
  prm=$(curl -sS -m 20 "$BASE_URL/.well-known/oauth-protected-resource/mcp")
  check "PRM has resource + authorization_servers" "$(echo "$prm" | grep -q '"authorization_servers"' && echo 1 || echo 0)"
  bad=$(curl -sS -m 20 -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/mcp" -H "Authorization: Bearer definitely-invalid-key" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" --data "$CALL")
  check "invalid bearer -> 401" "$([ "$bad" = "401" ] && echo 1 || echo 0)"
fi
out=$(post "$BASE_URL/mcp?apiKey=$API_KEY" "" "$LIST")
check "apiKey query: tools/list has create_render" "$(echo "$out" | grep -q create_render && echo 1 || echo 0)"
out=$(post "$BASE_URL/mcp" "Authorization: Bearer $API_KEY" "$CALL")
check "bearer: get_account returns apiQuota" "$(echo "$out" | grep -q apiQuota && echo 1 || echo 0)"
if [ -n "${FOLDER_ID:-}" ]; then
  out=$(post "$BASE_URL/mcp?apiKey=$API_KEY&folderId=$FOLDER_ID" "" "$LIST")
  check "folder scoping hides list_folders" "$(echo "$out" | grep -q '"list_folders"' && echo 0 || echo 1)"
fi
exit $FAIL
