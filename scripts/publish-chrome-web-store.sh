#!/usr/bin/env bash
# Upload a zip to the Chrome Web Store and submit it for review (Chrome Web Store API v2).
#
#   scripts/publish-chrome-web-store.sh environment-links.zip
#
# Needs these environment variables (see CONTRIBUTING.md, "Publishing from GitHub"):
#   CWS_PUBLISHER_ID   Developer Dashboard > Publisher > Settings
#   CWS_EXTENSION_ID   the item's ID in the store
#   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN   OAuth client and refresh token
# Optional:
#   CWS_PUBLISH=false  upload only; submit for review from the dashboard yourself
set -euo pipefail

ZIP="${1:?Usage: $0 <package.zip>}"
for var in CWS_PUBLISHER_ID CWS_EXTENSION_ID CWS_CLIENT_ID CWS_CLIENT_SECRET CWS_REFRESH_TOKEN; do
  [ -n "${!var:-}" ] || { echo "Missing $var" >&2; exit 1; }
done
[ -f "$ZIP" ] || { echo "No such file: $ZIP" >&2; exit 1; }

API="https://chromewebstore.googleapis.com"
ITEM="publishers/$CWS_PUBLISHER_ID/items/$CWS_EXTENSION_ID"

fail() { echo "::error::$1" >&2; [ -n "${2:-}" ] && echo "$2" >&2; exit 1; }

# 1. Exchange the refresh token for a short-lived access token.
token_json="$(curl -sS -X POST https://oauth2.googleapis.com/token \
  --data-urlencode "client_id=$CWS_CLIENT_ID" \
  --data-urlencode "client_secret=$CWS_CLIENT_SECRET" \
  --data-urlencode "refresh_token=$CWS_REFRESH_TOKEN" \
  --data-urlencode "grant_type=refresh_token")"
ACCESS_TOKEN="$(jq -r '.access_token // empty' <<<"$token_json")"
[ -n "$ACCESS_TOKEN" ] || fail "Couldn't get an access token. Check the client ID, secret and refresh token." \
  "$(jq -c '{error, error_description}' <<<"$token_json" 2>/dev/null || true)"
[ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$ACCESS_TOKEN"
auth=(-H "Authorization: Bearer $ACCESS_TOKEN")

# 2. Upload the package.
echo "Uploading $ZIP to item $CWS_EXTENSION_ID…"
upload="$(curl -sS -X POST "${auth[@]}" -H "Content-Type: application/zip" \
  --data-binary "@$ZIP" "$API/upload/v2/$ITEM:upload")"
state="$(jq -r '.uploadState // empty' <<<"$upload")"

# Large packages finish processing in the background; poll until they settle.
for _ in $(seq 1 30); do
  case "$state" in IN_PROGRESS|UPLOAD_IN_PROGRESS) ;; *) break ;; esac
  sleep 5
  status="$(curl -sS "${auth[@]}" "$API/v2/$ITEM:fetchStatus")"
  state="$(jq -r '.lastAsyncUploadState // empty' <<<"$status")"
done
[ "$state" = "SUCCEEDED" ] || fail "Upload didn't succeed (state: ${state:-none})." "$upload"
crx_version="$(jq -r '.crxVersion // empty' <<<"$upload")"
echo "Uploaded${crx_version:+ version $crx_version}."

if [ "${CWS_PUBLISH:-true}" != "true" ]; then
  echo "CWS_PUBLISH is not true: uploaded only. Submit it for review from the Developer Dashboard."
  exit 0
fi

# 3. Submit for review. The store publishes it once review passes, with the item's existing visibility.
publish="$(curl -sS -X POST "${auth[@]}" -H "Content-Type: application/json" -d '{}' "$API/v2/$ITEM:publish")"
pstate="$(jq -r '.state // empty' <<<"$publish")"
[ -n "$pstate" ] || fail "Publishing failed." "$publish"
echo "Submitted for review (state: $pstate)."
jq -r '.warningInfo // empty' <<<"$publish"
