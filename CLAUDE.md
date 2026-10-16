@CONTRIBUTING.md

## Notes for AI assistants

- **Commits:** don't commit or push unless asked. The maintainer asks for each one.
- **Versions:** change them only with `npm run bump`, never by editing the files by hand, and only when asked or when preparing a release.
- **Testing UI changes:** the extension pages need a real origin, because they're ES modules, and the `chrome.*` APIs. Copy `src/` (and `icons/` beside it) to a scratch folder, inject a `<script>` stub of `chrome.storage.sync/local`, `chrome.permissions` and `chrome.tabs` before the module script, serve it with `python3 -m http.server`, and open it in a browser. `scripts/build-assets.py` has a complete stub to copy. Stub `fetch` for `api.github.com` instead of calling GitHub.
- **Stale CSS:** browsers cache the stylesheet between runs. Add a query string such as `options.css?v=2` when re-checking styles.
- **Downloads in tests:** check a download (for example Export) by intercepting `HTMLAnchorElement.prototype.click`. Don't actually download.
- **Keyboard behaviour:** test it with real key presses, not only dispatched events.
- **Check the result:** after changing the popup or settings page, run `python3 scripts/build-assets.py` and look at the changed images in `store/`.
