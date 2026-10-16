#!/usr/bin/env bash
# Build dist/environment-links.crx, signed with the key kept OUTSIDE this folder.
#
#   npm run crx
#   KEY=/path/to/key.pem npm run crx
#
# The key fixes the extension's ID, so every release must be signed with the same one.
# It must never live inside the project: Chrome warns about (and would ship) a .pem
# found in an extension folder. Without an existing key, a new one is created at $KEY.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="${KEY:-$HOME/.environment-links/environment-links.pem}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

case "$KEY" in "$ROOT"/*) echo "Keep the key outside the project: $KEY" >&2; exit 1 ;; esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/environment-links" "$ROOT/dist"
cp -R "$ROOT/manifest.json" "$ROOT/src" "$ROOT/icons" "$WORK/environment-links/"
find "$WORK/environment-links" -name .DS_Store -delete

ARGS=(--headless --no-message-box --user-data-dir="$WORK/profile" --pack-extension="$WORK/environment-links")
if [ -f "$KEY" ]; then
  ARGS+=(--pack-extension-key="$KEY")
fi
"$CHROME" "${ARGS[@]}" >/dev/null 2>&1

if [ ! -f "$KEY" ]; then
  mkdir -p "$(dirname "$KEY")"
  mv "$WORK/environment-links.pem" "$KEY"
  chmod 600 "$KEY"
  echo "Created a new signing key at $KEY. Back it up."
fi
mv "$WORK/environment-links.crx" "$ROOT/dist/environment-links.crx"
ID="$(openssl rsa -in "$KEY" -pubout -outform DER 2>/dev/null | shasum -a 256 | head -c 32 | tr '0-9a-f' 'a-p')"
echo "Built dist/environment-links.crx (extension ID $ID)"
