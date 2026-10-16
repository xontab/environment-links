# Chrome Web Store listing

Everything the developer dashboard asks for, in the order it asks.

## Package

```bash
npm run package
```

Upload `environment-links.zip`. It contains only `manifest.json`, `src/` and `icons/`.

## Store listing tab

| Field | Value |
| --- | --- |
| Description | Paste [`description.txt`](description.txt) (about 3,800 of the 16,000 characters) |
| Summary | From the manifest: "Jump from the address bar to the same link across every environment." (69 of 132 characters) |
| Category | Developer Tools |
| Language | English |
| Store icon | [`store-icon-128.png`](store-icon-128.png): 128×128, 96px artwork with 16px transparent padding |
| Screenshots | [`screenshot-1.png`](screenshot-1.png), [`screenshot-2.png`](screenshot-2.png), [`screenshot-4.png`](screenshot-4.png), [`screenshot-3.png`](screenshot-3.png): 1280×800 |
| Small promo tile | [`promo-small.png`](promo-small.png): 440×280 |
| Marquee promo tile | [`promo-marquee.png`](promo-marquee.png): 1400×560 (optional) |

## Privacy practices tab

**Single purpose**

> Lets the user open a configured link in one of several environments (such as dev, staging and production), either by typing a short keyword in the address bar or by picking it from a list in the toolbar popup. Each link is built from a URL template and variables the user sets for each environment.

**Permission justification: `storage`**

> Saves the user's environments, variables and link templates, and syncs them across the user's Chrome profile.

**Remote code:** No, I am not using remote code.

**Data usage:** tick nothing. The extension collects no user data, and settings stay in `chrome.storage.sync`. Then tick all three certifications (not sold to third parties, not used for unrelated purposes, not used for creditworthiness).

**Privacy policy URL:** not required when no data is collected. If you want one, host the text below (for example as a GitHub gist or a page in the repo) and link to it.

> Environment Links does not collect, store, transmit or share any personal or usage data. The environments, variables and links you configure are saved with Chrome's storage API in your own Chrome profile and synced only by Chrome's own sync, if you have it turned on. The extension makes no network requests of its own.

## Rebuilding the images

The icons and store images are rendered from `store/source/` with headless Chrome:

```bash
python3 scripts/build-assets.py
```
