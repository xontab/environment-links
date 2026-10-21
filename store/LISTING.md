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
| Description | Paste [`description.txt`](description.txt) (about 5,100 of the 16,000 characters) |
| Summary | From the manifest: "Jump from the address bar to the same link across every environment." (69 of 132 characters) |
| Category | Developer Tools |
| Language | English |
| Homepage URL | https://xontab.com/ |
| Support URL | https://github.com/xontab/environment-links/issues |
| Store icon | [`store-icon-128.png`](store-icon-128.png): 128×128, 96px artwork with 16px transparent padding |
| Screenshots | [`screenshot-1.png`](screenshot-1.png), [`screenshot-2.png`](screenshot-2.png), [`screenshot-4.png`](screenshot-4.png), [`screenshot-3.png`](screenshot-3.png), [`screenshot-5.png`](screenshot-5.png): 1280×800, in that order (5 is the store maximum) |
| Small promo tile | [`promo-small.png`](promo-small.png): 440×280 |
| Marquee promo tile | [`promo-marquee.png`](promo-marquee.png): 1400×560 (optional) |

## Privacy practices tab

All the answers (single purpose, permission justifications, remote code, data usage and certifications) are in [`PRIVACY-PRACTICES.md`](PRIVACY-PRACTICES.md).

**Privacy policy URL:** needed because a data type is declared. The policy is [`PRIVACY.md`](../PRIVACY.md) in this repository. Use its GitHub page, which renders it as a formatted page:

```
https://github.com/xontab/environment-links/blob/main/PRIVACY.md
```

The raw file works too, but shows as plain Markdown text: `https://raw.githubusercontent.com/xontab/environment-links/main/PRIVACY.md`. When the extension's data handling changes, update `PRIVACY.md` and its "Last updated" date in the same change.

## Rebuilding the images

The icons and store images are rendered from `store/source/` with headless Chrome:

```bash
python3 scripts/build-assets.py
```
