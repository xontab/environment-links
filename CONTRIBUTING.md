# Contributing

Thanks for helping. The extension is plain JavaScript modules with no dependencies and no build step: load the folder with **Load unpacked** in `chrome://extensions`, edit, and click reload. You only need Node.js 20 or later for the tests and scripts.

```bash
npm test
```

## How the code fits together

| File | What it does |
| --- | --- |
| `src/core.js` | Templates, search, normalising settings, and merging shared files. No `chrome.*` calls, so it's fully unit-tested. Put logic here when you can. |
| `src/shared.js` | Loads settings plus the shared files from GitHub, fetches and caches them, stores tokens. |
| `src/background.js` | Address-bar suggestions and the hourly sync alarm. |
| `src/popup.*` | The toolbar list. |
| `src/options.*` | The settings page. |

### Two configs: the user's own and the effective one

- `config` is what the user set, saved in `chrome.storage.sync` under `"config"`. It's the only thing the settings page ever saves.
- `resolveConfig(config, layers)` lays shared files underneath it to produce the **effective** config, which the address bar, popup and previews use. It's never saved.
- Editing a shared environment creates the user's own entry with the same `id`. Shared items are never changed in place.
- Variable precedence, lowest first: shared default, own default, shared environment value, own environment value.
- Own links win over shared links with the same name (case-insensitive). With several sources, the first one wins.
- `environmentOrder` is one list of ids covering own and shared environments, so any row can be moved.

### Storage

- `chrome.storage.sync` → `config`. Chrome limits one synced item to about 8 KB.
- `chrome.storage.local` → `shared` (the last good copy of each shared file, with its ETag) and `tokens` (GitHub tokens). Tokens must never go into `sync` or the JSON export.
- `localStorage` → only `tutorial-hidden`, which is a convenience. Wrap any use in `try`.

### Things that look changeable but aren't

- **The address-bar keyword** (`e`) only comes from `manifest.json`. Change it with `npm run keyword -- <word>` and reload the extension; it can't be a setting.
- **Address-bar suggestion text** is XML. Always pass user text through `escapeXml` (`describe()` does this).
- **Opening tabs** with `chrome.tabs.update/create` doesn't need the `tabs` permission. Don't add it.
- **GitHub access** is an *optional* host permission (`api.github.com`). `chrome.permissions.request()` only shows its prompt during a click, so call it before any `await` in the handler.

## Before you open a pull request

- `npm test` passes. Add tests to `test/core.test.js` for logic, or `test/shared.test.js` for sync behaviour (it uses a fake `chrome` and `fetch`).
- Check UI changes in **light and dark** mode. Colours come from the CSS variables in `options.css` (the popup loads it too). Derive new shades from `--accent` with `color-mix()` rather than hard-coding them.
- In the popup, selecting a row must not change its size. Rows reserve a transparent border for this.
- If you change the popup or settings page, re-render the store images (below) and look at them.

## Permissions and the store listing

Adding a permission, a network request or any kind of stored user data changes the Chrome Web Store privacy answers. Update `store/LISTING.md` in the same change, covering the permission justification, data usage and privacy policy, and mention it in the pull request. `store/description.txt` is pasted into the store as plain text, so don't use Markdown in it.

## Store images

```bash
python3 scripts/build-assets.py
```

This renders the icons and every image in `store/` from `store/source/` with headless Google Chrome:

- The settings page and popup screenshots use the real pages, run against a fake `chrome` API with sample data from the script. Add `?shared` to the page URL for a synced shared file (screenshot 5), or `#id` to scroll to a section.
- The tutorial is forced closed so it doesn't cover the screenshots.
- Headless Chrome won't make a window narrower than about 500px, so small images are rendered larger and cropped by the script.
- The popup is 400px wide. Frame it at exactly that width or the screenshot gets a blank strip.
- The store allows at most 5 screenshots, at 1280×800.

## Releases and signing

- Bump the version for every store upload, following [semantic versioning](https://semver.org). The command updates `manifest.json` and `package.json` together and doesn't commit:

  ```bash
  npm run bump -- patch
  ```

  - **patch** (1.1.0 → 1.1.1): fixes and small visual changes.
  - **minor** (1.1.0 → 1.2.0): new features that keep existing settings and shared files working.
  - **major** (1.1.0 → 2.0.0): anything that breaks saved settings, exported or shared files, or the address-bar shortcut, or that adds a permission users must approve again.
  - You can also give an exact version (`npm run bump -- 1.4.0`). It must be higher than the current one, because the store rejects anything else, and it can't have a suffix like `-beta`, because Chrome only accepts numbers.
- `npm run package` builds the zip for the store.
- Pushing a new version to `main` publishes it (see below), so only bump when you mean to release.
- `npm run crx` builds a signed `.crx` with the key at `~/.environment-links/environment-links.pem`. **Never put a `.pem` inside the project.** Chrome warns about it and would ship it inside the extension. `.gitignore` excludes `*.pem`, `*.crx` and `dist/` as a backstop.
- The key fixes the extension ID (`moojonbkkhlihbdeffiojklpkiingpnm`). Every `.crx` release has to use the same key.

## Publishing from GitHub

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) publishes automatically. When `manifest.json` changes on `main` and there's no `v<version>` tag yet, it:

1. runs the tests and checks that `manifest.json` and `package.json` have the same version
2. builds the zip
3. uploads it to the Chrome Web Store and submits it for review
4. tags the commit `v<version>` and creates a GitHub release with the zip attached

The store publishes the version once review passes, with the item's existing visibility. You can also run the workflow from the **Actions** tab, and untick **Submit for review** to upload only. The upload and publish logic is in [`scripts/publish-chrome-web-store.sh`](scripts/publish-chrome-web-store.sh), which uses Chrome Web Store API v2.

A release looks like this:

```bash
npm run bump -- minor
git commit -am "Release 1.2.0"
git push
```

### One-time setup

1. **Publish the first version by hand.** Upload the zip in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) and fill in the Store listing and Privacy tabs from `store/LISTING.md`. The API can only update an item that already exists, and Google requires 2-step verification on the account. Then tag that version so the workflow doesn't try to publish it again:

   ```bash
   git tag v1.1.0
   git push origin v1.1.0
   ```
2. **Note two IDs.** The **publisher ID** is under Publisher > Settings, and the **extension ID** is on the item's page.
3. **Create OAuth credentials** in the [Google Cloud Console](https://console.cloud.google.com/):
   - Enable the **Chrome Web Store API**.
   - Configure the OAuth consent screen, then **publish the app to "In production"**. While it's in "Testing", Google expires refresh tokens after 7 days and the workflow starts failing.
   - Create an OAuth client of type **Web application**, with `https://developers.google.com/oauthplayground` as an authorised redirect URI.
4. **Get a refresh token** in the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground):
   - Under the settings gear, choose "Use your own OAuth credentials" and enter the client ID and secret.
   - Authorise the scope `https://www.googleapis.com/auth/chromewebstore`, signed in as the account that owns the item.
   - Exchange the code for tokens and copy the refresh token.
5. **Add them to the GitHub repository** under Settings > Secrets and variables > Actions:

   | Kind | Name | Value |
   | --- | --- | --- |
   | Variable | `CWS_PUBLISHER_ID` | the publisher ID |
   | Variable | `CWS_EXTENSION_ID` | the extension ID |
   | Secret | `CWS_CLIENT_ID` | the OAuth client ID |
   | Secret | `CWS_CLIENT_SECRET` | the OAuth client secret |
   | Secret | `CWS_REFRESH_TOKEN` | the refresh token |

6. **Optional:** the job runs in the `chrome-web-store` environment. Add required reviewers to it (Settings > Environments) if you want to approve each release before it's submitted.

If a run fails, the error in the log says why: an expired token, a version that isn't higher than the store's, or a failed review check. Fix it, then re-run the workflow. Nothing is tagged until the submission succeeds, so a re-run tries again.

