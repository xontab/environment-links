# Environment Links

A Chrome extension that opens the same link in any of your environments from the address bar.

```
e backoffice
  DEV - backoffice.dev.example.com
  STAGING - backoffice.staging.example.com
  PREPROD - backoffice.preprod.example.com
  PRODUCTION - backoffice.example.com
```

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. The settings page opens with an example setup.

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
- **Import / export**: copy the configuration as JSON to share it with teammates.

Settings live in `chrome.storage.sync`, so they follow your Chrome profile across machines (Chrome caps a synced item at about 8 KB, which is a few hundred links).

## Develop

```bash
npm test
```

```bash
npm run package
```

`src/core.js` holds the template and search logic and has no Chrome dependencies; `src/background.js` wires it to the omnibox and `src/options.*` is the settings page.
