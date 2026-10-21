#!/usr/bin/env bash
# Work out which parts of the Chrome Web Store listing need updating by hand for this release.
# The store's API can upload and submit a package, but can't edit the listing, so anything
# found here has to be changed in the Developer Dashboard.
#
#   scripts/store-listing-checklist.sh [previous-ref]
#
# previous-ref defaults to the latest v* tag. With no earlier release, everything is listed.
#
# Prints a Markdown checklist on stdout. When GITHUB_OUTPUT is set it also writes
#   listing_changed=true|false   whether anything needs a dashboard edit
#   attachments=<files>          space-separated files to attach to the release
set -euo pipefail

prev="${1:-$(git describe --tags --abbrev=0 --match 'v*' HEAD 2>/dev/null || true)}"

# Files that matter, and whether each changed since the previous release.
if [ -n "$prev" ]; then
  changed="$(git diff --name-only "$prev" HEAD -- store PRIVACY.md manifest.json)"
  since="since $prev"
else
  changed="$(git ls-files store PRIVACY.md manifest.json)"
  since=""
fi
has() { grep -qxF "$1" <<<"$changed"; }

permissions() { jq -c '{permissions, optional_host_permissions, host_permissions} | with_entries(select(.value != null))'; }
perm_now="$(permissions <manifest.json)"
perm_before="$( [ -n "$prev" ] && git show "$prev:manifest.json" 2>/dev/null | permissions || echo '{}')"

items=()
attach=()

if has store/description.txt; then
  items+=("**Store listing › Description:** paste \`store/description.txt\` (attached) over the current text.")
  attach+=(store/description.txt)
fi

# The store shows screenshots in this order (see store/LISTING.md).
order=(1 2 4 3 5)
shots=()
for i in "${!order[@]}"; do
  n="${order[$i]}"
  if has "store/screenshot-$n.png"; then
    shots+=("screenshot-$n.png (position $((i + 1)))")
    attach+=("store/screenshot-$n.png")
  fi
done
if [ ${#shots[@]} -gt 0 ]; then
  items+=("**Store listing › Screenshots:** replace $(IFS=,; echo "${shots[*]}" | sed 's/,/, /g'). The order is screenshots 1, 2, 4, 3, 5.")
fi

promos=()
for f in promo-small promo-marquee; do
  if has "store/$f.png"; then promos+=("$f.png"); attach+=("store/$f.png"); fi
done
if [ ${#promos[@]} -gt 0 ]; then
  items+=("**Store listing › Promo tiles:** replace $(IFS=,; echo "${promos[*]}" | sed 's/,/, /g').")
fi

if has store/store-icon-128.png; then
  items+=("**Store listing › Store icon:** replace it with \`store-icon-128.png\` (attached).")
  attach+=(store/store-icon-128.png)
fi

if [ "$perm_now" != "$perm_before" ]; then
  items+=("**Privacy practices › Permission justification:** the permissions changed, so add or update a justification for each one from \`store/PRIVACY-PRACTICES.md\`.<br>Before: \`$perm_before\`<br>Now: \`$perm_now\`")
fi

if has store/PRIVACY-PRACTICES.md; then
  items+=("**Privacy practices:** update the answers that changed in \`store/PRIVACY-PRACTICES.md\` (attached).")
  attach+=(store/PRIVACY-PRACTICES.md)
fi

listing_changed=false
[ ${#items[@]} -gt 0 ] && listing_changed=true

echo "## Chrome Web Store listing"
echo
if [ "$listing_changed" = true ]; then
  if [ -n "$since" ]; then intro="The listing changed $since."; else intro="This is the first release, so every part of the listing needs filling in."; fi
  echo "$intro The store's API can't edit it, so **this version was uploaded but not submitted for review**. Make these changes in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), then click **Submit for review**:"
  echo
  for item in "${items[@]}"; do echo "- [ ] $item"; done
else
  echo "Nothing in the store listing changed${since:+ $since}, so this version was submitted for review automatically."
fi
if has PRIVACY.md; then
  echo
  echo "The privacy policy (\`PRIVACY.md\`) changed too. Its URL already serves the new version, so it needs no dashboard change."
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "listing_changed=$listing_changed"
    echo "attachments=${attach[*]:-}"
  } >>"$GITHUB_OUTPUT"
fi
