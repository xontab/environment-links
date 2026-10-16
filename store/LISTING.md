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
| Description | Paste [`description.txt`](description.txt) (about 4,600 of the 16,000 characters) |
| Summary | From the manifest: "Jump from the address bar to the same link across every environment." (69 of 132 characters) |
| Category | Developer Tools |
| Language | English |
| Store icon | [`store-icon-128.png`](store-icon-128.png): 128×128, 96px artwork with 16px transparent padding |
| Screenshots | [`screenshot-1.png`](screenshot-1.png), [`screenshot-2.png`](screenshot-2.png), [`screenshot-4.png`](screenshot-4.png), [`screenshot-3.png`](screenshot-3.png), [`screenshot-5.png`](screenshot-5.png): 1280×800, in that order (5 is the store maximum) |
| Small promo tile | [`promo-small.png`](promo-small.png): 440×280 |
| Marquee promo tile | [`promo-marquee.png`](promo-marquee.png): 1400×560 (optional) |

## Privacy practices tab

**Single purpose**

> Lets the user open a configured link in one of several environments (such as dev, staging and production), either by typing a short keyword in the address bar or by picking it from a list in the toolbar popup. Each link is built from a URL template and variables the user sets for each environment. Teams can optionally keep a shared set of these links in a JSON file in a GitHub repository, which the extension reads so everyone gets the same links.

**Permission justification: `storage`**

> Saves the user's environments, variables and link templates, and syncs them across the user's Chrome profile with Chrome sync. Also keeps, on this device only, the last copy of any shared links file the user subscribed to and an optional GitHub access token for private repositories.

**Permission justification: `alarms`**

> Refreshes the shared links files the user has subscribed to once an hour, so changes a team makes in GitHub reach everyone without opening the settings page.

**Permission justification: host permission `https://api.github.com/*`** (optional, requested only when the user adds a shared file)

> Reads the JSON file of shared links that the user chose, from the GitHub repository they entered, using GitHub's contents API. Only that file is requested, only from api.github.com, and nothing is written to GitHub. The permission is optional and Chrome asks the user for it the first time they add a shared file.

**Remote code:** No, I am not using remote code. (The shared file is JSON data, never code.)

**Data usage:** tick **Authentication information** only. A user can paste a GitHub access token for a private repository; it's stored on their device and sent only to api.github.com to read the file they chose. Nothing else is collected: the extension doesn't read pages, history or browsing activity. Then tick all three certifications.

**Privacy policy URL:** needed now that a data type is declared. Host the text below (for example as a GitHub gist or a page in the repo) and paste its link.

> **Environment Links privacy policy**
>
> Environment Links does not collect, sell or share personal data, and it has no servers of its own.
>
> The environments, variables and links you configure are saved with Chrome's storage API in your Chrome profile, and synced between your computers by Chrome sync if you have it turned on.
>
> If you subscribe to a shared links file, the extension requests that file from api.github.com (GitHub's API) when Chrome starts, once an hour, and when you click "Sync now". GitHub receives these requests under its own privacy statement. A copy of the file is kept on your device.
>
> If you enter a GitHub access token for a private repository, it is stored only on your device (it is not synced or included in exports) and is sent only to api.github.com to read the file you chose. Removing the shared file or clicking "Forget token" deletes it.
>
> The extension does not read the pages you visit or your browsing history, and it does not use analytics.

## Rebuilding the images

The icons and store images are rendered from `store/source/` with headless Chrome:

```bash
python3 scripts/build-assets.py
```
