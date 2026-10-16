import { DEFAULT_CONFIG, search, describe } from "./core.js";
import { CONFIG_KEY, loadEffectiveConfig, syncAll } from "./shared.js";

const MAX_SUGGESTIONS = 9;
const SYNC_ALARM = "sync-shared-links";
const SYNC_EVERY_MINUTES = 60;

const loadConfig = loadEffectiveConfig;

function scheduleSync() {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_EVERY_MINUTES });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  scheduleSync();
  syncAll();
  if (reason !== "install") return;
  const stored = await chrome.storage.sync.get(CONFIG_KEY);
  if (!stored[CONFIG_KEY]) await chrome.storage.sync.set({ [CONFIG_KEY]: DEFAULT_CONFIG });
  chrome.runtime.openOptionsPage();
});

// Shared files are refreshed when Chrome starts and every hour after that.
chrome.runtime.onStartup.addListener(() => {
  scheduleSync();
  syncAll();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncAll();
});

chrome.omnibox.onInputStarted.addListener(() => {
  chrome.omnibox.setDefaultSuggestion({
    description: "Type a link name, e.g. <match>backoffice</match> [env] [/path]",
  });
});

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  const config = await loadConfig();
  const results = search(text, config);
  const multipleLinks = new Set(results.map((r) => r.link.key)).size > 1;

  if (!results.length) {
    chrome.omnibox.setDefaultSuggestion({
      description: text.trim()
        ? "No matching link. Press Enter to open settings."
        : "Type a link name, e.g. <match>backoffice</match> [env] [/path]",
    });
    suggest([]);
    return;
  }

  // The first result becomes the default (what Enter opens); the rest are listed below it.
  const [first, ...rest] = results;
  chrome.omnibox.setDefaultSuggestion({ description: describe(first, multipleLinks) });
  suggest(
    rest.slice(0, MAX_SUGGESTIONS - 1).map((r) => ({
      content: r.url,
      description: describe(r, multipleLinks),
      deletable: false,
    }))
  );
});

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  const config = await loadConfig();
  let url = text.trim();

  // Suggestions carry the URL as their content; the default suggestion carries the typed text.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const [first] = search(text, config);
    if (!first) {
      chrome.runtime.openOptionsPage();
      return;
    }
    url = first.url;
  }

  // Respect modifier keys (Alt/Cmd+Enter); otherwise use the configured default.
  const target = disposition === "currentTab" ? config.openIn : disposition;
  if (target === "currentTab") chrome.tabs.update({ url });
  else chrome.tabs.create({ url, active: target === "newForegroundTab" });
});
