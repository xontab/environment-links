# Chrome Web Store: Privacy practices tab

The answers for the **Privacy** tab of the Developer Dashboard, in the order the form asks for them. Copy each quoted block into its field as plain text. Each text field allows up to 1,000 characters.

Keep this file in step with `manifest.json`: adding a permission, a network request or stored user data changes these answers, and [`PRIVACY.md`](../PRIVACY.md) with them.

## Single purpose

> Environment Links opens the same web page in different deployment environments, such as development, staging, pre-production and production. The user sets up their environments, variables for each environment (for example ENVIRONMENT=dev, DOMAIN=example.com) and link templates (for example backoffice.{{ENVIRONMENT}}.{{DOMAIN}}). Typing the "e" keyword and a link name in the address bar, or opening the toolbar popup, lists that link for every environment, and the extension opens the one the user picks. Teams can optionally keep a shared set of these links in a JSON file in a GitHub repository, which the extension reads so everyone gets the same links. The extension does nothing else: it doesn't change web pages, read browsing activity or run on websites.

## Permission justification

### storage

> Saves the user's own settings: environment names, variables for each environment, link templates, per-environment URL overrides and display preferences. These are saved with chrome.storage.sync so they persist and follow the user's Chrome profile through Chrome sync. On the device only (chrome.storage.local), it also keeps the last copy of any shared links file the user subscribed to, so links keep working offline, and an optional GitHub access token for a private repository. Nothing is sent to the developer.

### alarms

> Refreshes the shared links files the user has subscribed to once an hour, so changes a team makes in its GitHub repository reach every member without them opening the settings page. If the user hasn't added a shared file, the alarm does nothing.

### Host permission: https://api.github.com/*

This is an optional host permission. Chrome asks the user for it the first time they add a shared links file.

> Reads the JSON file of shared links that the user chose, from the GitHub repository they entered, using GitHub's contents API. Only that file is requested, only from api.github.com, and nothing is written to GitHub. The permission is optional: Chrome asks the user for it the first time they add a shared links file, and the extension never requests it otherwise.

## Are you using remote code?

**No, I am not using remote code.**

The shared links file is JSON data that the extension parses and checks. It is never run as code. All scripts are included in the package.

## Data usage

**What user data do you plan to collect from users now or in the future?** Tick only:

- [x] **Authentication information.** A user can enter a GitHub access token for a private repository. It's stored only on their device and sent only to api.github.com, to read the file they chose.

Leave everything else unticked:

| Category | Why it doesn't apply |
| --- | --- |
| Personally identifiable information | none collected |
| Health information | none collected |
| Financial and payment information | none collected |
| Personal communications | none collected |
| Location | none collected |
| Web history | can't read tabs or history; it only opens the link the user picks |
| User activity | only sees text typed after the `e` keyword, used on the device to match links, never logged or sent |
| Website content | link templates are the user's own settings, not content taken from websites |

**Certifications.** Tick all three:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

## Privacy policy URL

```
https://github.com/xontab/environment-links/blob/main/PRIVACY.md
```
