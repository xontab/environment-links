#!/usr/bin/env bash
# Upload a zip to the Chrome Web Store and submit it for review (Chrome Web Store API v2).
#
#   scripts/publish-chrome-web-store.sh environment-links.zip
#
# Needs these environment variables (see CONTRIBUTING.md, "Publishing from GitHub"):
#   CWS_PUBLISHER_ID   Developer Dashboard > Publisher > Settings
#   CWS_EXTENSION_ID   the item's ID in the store
#   CWS_ACCESS_TOKEN   an access token for the service account, with the
#                      https://www.googleapis.com/auth/chromewebstore scope. In GitHub
#                      Actions it comes from Workload Identity Federation; locally, from
#                      gcloud auth print-access-token --impersonate-service-account=…
# Optional:
#   CWS_PUBLISH=false  upload only; submit for review from the dashboard yourself
set -euo pipefail

ZIP="${1:?Usage: $0 <package.zip>}"
for var in CWS_PUBLISHER_ID CWS_EXTENSION_ID CWS_ACCESS_TOKEN; do
  [ -n "${!var:-}" ] || { echo "Missing $var" >&2; exit 1; }
done
[ -f "$ZIP" ] || { echo "No such file: $ZIP" >&2; exit 1; }

API="https://chromewebstore.googleapis.com"
ITEM="publishers/$CWS_PUBLISHER_ID/items/$CWS_EXTENSION_ID"

fail() { echo "::error::$1" >&2; [ -n "${2:-}" ] && echo "$2" >&2; exit 1; }

auth=(-H "Authorization: Bearer $CWS_ACCESS_TOKEN")

# 1. Upload the package. A 401/403 here usually means the service account isn't added
#    to the publisher in the Developer Dashboard, or the token lacks the scope.
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
if [ "$state" != "SUCCEEDED" ]; then
  case "$(jq -r '.error.status // empty' <<<"$upload" 2>/dev/null)" in
    PERMISSION_DENIED|UNAUTHENTICATED)
      fail "The Chrome Web Store refused the service account. Check it's added under Account in the Developer Dashboard, and that CWS_PUBLISHER_ID and CWS_EXTENSION_ID are right." "$upload" ;;
  esac
  fail "Upload didn't succeed (state: ${state:-none})." "$upload"
fi
crx_version="$(jq -r '.crxVersion // empty' <<<"$upload")"
echo "Uploaded${crx_version:+ version $crx_version}."

if [ "${CWS_PUBLISH:-true}" != "true" ]; then
  echo "CWS_PUBLISH is not true: uploaded only. Submit it for review from the Developer Dashboard."
  exit 0
fi

# 2. Submit for review. The store publishes it once review passes, with the item's existing visibility.
publish="$(curl -sS -X POST "${auth[@]}" -H "Content-Type: application/json" -d '{}' "$API/v2/$ITEM:publish")"
pstate="$(jq -r '.state // empty' <<<"$publish")"
[ -n "$pstate" ] || fail "Publishing failed." "$publish"
echo "Submitted for review (state: $pstate)."
jq -r '.warningInfo // empty' <<<"$publish"
