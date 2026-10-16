# Environment Links

A Chrome extension that opens the same link in any of your environments (dev, staging, preprod, production and so on), from the address bar or the toolbar.

![Typing "e backoffice" in the address bar lists the backoffice URL for every environment](store/screenshot-1.png)

You write each link once as a template, such as `backoffice.{{ENVIRONMENT}}.{{DOMAIN}}`, and set the variables for each environment. Then:

```
e backoffice
  DEV - backoffice.dev.example.com
  STAGING - backoffice.staging.example.com
  PREPROD - backoffice.preprod.example.com
  PRODUCTION - backoffice.example.com
```

## Features

- **Address bar:** type `e`, a space and a link name to get it in every environment, filter by environment, or append a path.
- **Toolbar list:** every link with a button per environment, with a filter box and arrow-key navigation.
- **One template per link:** variables per environment, a Default row for shared values, and per-environment overrides.
- **Team sharing:** pull a shared set of links, environments and variables from a JSON file in a GitHub repository. Your own settings still win.
- **Portable:** settings sync through your Chrome profile, and you can export and import them as a JSON file.
- **Private:** no analytics and no servers. The only network requests go to GitHub, for shared files you add.

## Install

```bash
git clone https://github.com/xontab/environment-links.git
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the cloned `environment-links` folder.
3. The settings page opens with an example setup and a short tutorial.

## Use

Chrome only hands address-bar input to an extension after its keyword, so type the shortcut `e`, then `Space` or `Tab`, then:

| You type                         | You get                                   |
| -------------------------------- | ----------------------------------------- |
| `backoffice`                     | the link in every environment             |
| `backoffice prod`                | only environments starting with `prod`    |
| `backoffice dev stag`            | DEV and STAGING                           |
| `backoffice stag /players/123`   | STAGING, with `/players/123` appended     |
| `back`                           | every link whose name contains `back`     |

`Enter` opens the top suggestion; arrow down to pick another. `Alt+Enter` opens it in a new tab.

## Toolbar button

Click the extension's toolbar icon for a list of every link with a button per environment. Type in the box to filter (`back prod` works the same as in the address bar). `↑`/`↓` move between links, `←`/`→` between environments, and `Enter` opens the selected one.

A plain click follows the "open in" setting, `Cmd`/`Ctrl`-click or middle-click opens a background tab, and `Shift`-click a new tab. **Settings** at the bottom of the list opens the settings page.

## Change the shortcut

The shortcut defaults to `e`. Chrome only reads it from `manifest.json`, so it can't be changed from the settings page. To change it:

```bash
npm run keyword -- go
```

Then click reload on the extension in `chrome://extensions`.

## Configure

- **Variables**: a grid with one row per environment and one column per variable, so it grows downwards as you add environments. The **Default** row applies to any environment that leaves its cell blank, so `DOMAIN` only has to be set once.
- **Links**: a name (what you type) and a template such as `backoffice.{{ENVIRONMENT}}.{{DOMAIN}}`. `https://` is added when no scheme is given. Expand a link to preview each environment's URL and to override it for one environment, e.g. production as `backoffice.{{DOMAIN}}`.
- **Import / Export**: **Export to file** saves your settings as a JSON file (without access tokens). Load it back with **Import from file**, or paste its JSON into the box and click **Import from text**.

## Share links with your team

Put a JSON file in a GitHub repository, then add it under **Shared links** in settings with `owner/repo`, or paste the file's github.com link. To build the file, open **Create a shared file from your links**, pick the links to share and commit the JSON as `environment-links.json`.

The file uses the same format as the export. Every field is optional, but it needs `links` or `environments`:

```json
{
  "links": [
    { "key": "grafana", "template": "grafana.{{ENVIRONMENT}}.{{DOMAIN}}", "overrides": { "production": "grafana.{{DOMAIN}}" } }
  ],
  "variableNames": ["ENVIRONMENT", "DOMAIN"],
  "globals": { "DOMAIN": "example.com" },
  "environments": [
    { "id": "dev", "name": "DEV", "variables": { "ENVIRONMENT": "dev" } },
    { "id": "production", "name": "PRODUCTION", "variables": {} }
  ]
}
```

How shared files combine with your own settings:

- Your own links come first. A shared link with the same name as one of yours is ignored. Use **Customise** to copy a shared link and change it.
- Environments match on `id`. Shared environments you don't have are added to the end, marked "shared".
- For each variable, the lowest-priority value is listed first: shared default, your default, shared environment value, your environment value. Blank cells in the grid show the value they'll use.
- With several files, the first in the list wins.

Files are fetched through GitHub's API (`api.github.com`) when Chrome starts, every hour, and with **Sync now**. Chrome asks for access to GitHub the first time you add a file. For a private repository, add a fine-grained token with read-only **Contents** access to that repository. Tokens stay on that computer: they aren't synced or exported. If a sync fails, the last good copy is kept and the error is shown.

Settings live in `chrome.storage.sync`, so they follow your Chrome profile across machines (Chrome caps a synced item at about 8 KB, which is a few hundred links).

## Develop

There are no dependencies to install. You only need Node.js 20 or later, for the tests and scripts.

Run the unit tests:

```bash
npm test
```

Build `environment-links.zip` for the Chrome Web Store, or to share for "Load unpacked":

```bash
npm run package
```

Build a signed `.crx`:

```bash
npm run crx
```

Re-render the icons and store images from `store/source/` (needs Google Chrome):

```bash
python3 scripts/build-assets.py
```

`npm run crx` builds a signed `dist/environment-links.crx`. The signing key lives at `~/.environment-links/environment-links.pem`, outside the project, so it never ends up in the extension. Set `KEY=` to use another path. Back it up: every release must be signed with the same key to keep the extension ID.

`src/core.js` holds the template, search and shared-file merge logic and has no Chrome dependencies. `src/shared.js` fetches shared files from GitHub and caches them, `src/background.js` wires everything to the omnibox and the hourly sync, `src/popup.*` is the toolbar list and `src/options.*` the settings page.

## License

[MIT](LICENSE)
