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
- `npm run crx` builds a signed `.crx` with the key at `~/.environment-links/environment-links.pem`. **Never put a `.pem` inside the project.** Chrome warns about it and would ship it inside the extension. `.gitignore` excludes `*.pem`, `*.crx` and `dist/` as a backstop.
- The key fixes the extension ID (`moojonbkkhlihbdeffiojklpkiingpnm`). Every `.crx` release has to use the same key.
