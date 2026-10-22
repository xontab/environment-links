# Privacy policy for Environment Links

Last updated: 22 October 2026

Environment Links is a Chrome extension by xonTAB. It opens the same link in different environments (such as dev, staging and production) from Chrome's address bar or toolbar. This policy explains what data the extension handles and where it goes.

## Summary

- Environment Links does not collect, sell or share your personal data.
- It has no servers of its own and uses no analytics or tracking.
- The only network requests it makes are to GitHub, and only for shared links files that you choose to add.

## What the extension stores

**Your settings.** The environments, variables, links and preferences you set up are saved with Chrome's storage API in your Chrome profile. If you have Chrome sync turned on, Chrome copies them to your other computers. That's done by Google as part of Chrome sync, not by the extension, and xonTAB never receives them. This includes any user name or password you put in a link or a variable for basic auth (`user:password@host`), and they're also in any file you export.

**Shared links files.** If you add a shared links file from a GitHub repository, the extension keeps the most recent copy of it on your device, so your links keep working if GitHub can't be reached.

**GitHub access tokens.** If you enter a GitHub access token for a private repository, it's stored only on that device. It isn't synced to your other computers and isn't included when you export your settings. You can delete it at any time with **Forget token**, or by removing the shared file.

**Display preferences.** Whether you've hidden the tutorial on the settings page is remembered in the browser.

## Network requests

The extension contacts **api.github.com** (GitHub's API) only if you add a shared links file, and only to read that file. This happens when Chrome starts, about once an hour, and when you click **Sync now**. If you entered an access token for that file, it's sent with these requests so GitHub can check you're allowed to read it. GitHub handles these requests under the [GitHub Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).

Chrome asks your permission before the extension can contact GitHub at all.

No other data leaves your device. Links in the extension to the xonTAB website, other xonTAB apps, the source code on GitHub and the Chrome Web Store only open those sites in a new tab when you click them.

## What the extension doesn't do

- It doesn't read the pages you visit, your browsing history or your tabs.
- If you turn on tab groups in the settings, it reads the names of the tab groups in the current window to find the one for the environment, and moves the tab it opened into it. Chrome asks your permission first, and this stays on your device.
- It only sees what you type in the address bar after its shortcut (`e` and a space), and uses that only on your device to find matching links.
- It doesn't use analytics, advertising or tracking of any kind.
- It doesn't sell or transfer data to anyone, or use it for any purpose other than opening your links.

## Removing your data

Uninstalling the extension removes the data it stored on that device, including any access tokens and cached shared files. Settings saved through Chrome sync are held by Google in your Google Account. You can delete them with **Clear data** at [chrome.google.com/sync](https://chrome.google.com/sync), which clears all of your Chrome sync data.

## Changes

If this policy changes, the new version will be published here with a new "Last updated" date. The full history is in this repository's commit log.

## Contact

Questions or concerns: open an issue at [github.com/xontab/environment-links/issues](https://github.com/xontab/environment-links/issues), or contact xonTAB through [xontab.com](https://xontab.com/).
