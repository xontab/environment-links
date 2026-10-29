import {
  DEFAULT_CONFIG, search, describe, environmentForUrl, syncProblems, describeSyncProblems, mergeSameUrl, syncSeverity, SYNC_COLORS,
} from "./core.js";
import { openLink } from "./open.js";
import { CONFIG_KEY, loadEffectiveConfig, loadLocalConfig, loadCache, syncAll } from "./shared.js";

const MAX_SUGGESTIONS = 9;
const SYNC_ALARM = "sync-shared-links";
const SYNC_EVERY_MINUTES = 60;

// The effective config, read once and kept in memory, so the address bar can answer a keystroke
// straight away instead of waiting for storage. When the settings or a shared file change it's
// read again; until that's done the copy in memory is used.
let config = null;
let configLoad = null;
function loadConfig() {
  configLoad ??= loadEffectiveConfig()
    .then((loaded) => (config = loaded))
    .catch((err) => {
      configLoad = null; // try again next time
      throw err;
    });
  return configLoad;
}

function scheduleSync() {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_EVERY_MINUTES });
}

// A "!" on the toolbar icon while any Shared links file fails to sync: red when one needs fixing,
// orange when they're all likely to clear up by themselves (like no network). Its tooltip says which.
async function showSyncProblems() {
  const [config, cache] = await Promise.all([loadLocalConfig(), loadCache()]);
  const problems = syncProblems(config, cache);
  const severity = syncSeverity(problems); // orange while every failure is likely to clear up by itself
  await Promise.all([
    chrome.action.setBadgeText({ text: problems.length ? "!" : "" }),
    chrome.action.setBadgeBackgroundColor({ color: SYNC_COLORS[severity] || SYNC_COLORS.error }),
    chrome.action.setTitle({ title: problems.length ? `Environment Links\n${describeSyncProblems(problems)}` : "Environment Links" }),
  ]);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "local" && changes.shared) || (area === "sync" && changes[CONFIG_KEY])) {
    configLoad = null;
    loadConfig().catch(() => {}); // read it afresh now, so it's ready for the next keystroke
    showSyncProblems();
  }
});
showSyncProblems(); // each time the service worker starts

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

const HINT = "Type a link or environment, e.g. <match>backoffice</match>, <match>prod</match> or <match>backoffice prod</match> [/path]";

chrome.omnibox.onInputStarted.addListener(() => {
  chrome.omnibox.setDefaultSuggestion({ description: HINT });
  loadConfig().catch(() => {}); // usually in memory already; if not, start reading now
});

/**
 * Answer one keystroke: the first match is the first row (what Enter opens), the rest follow.
 * The rows are sent only once Chrome has stored the first row. Chrome draws the first row from the
 * stored default suggestion, so sending the rows first could show them under the previous
 * keystroke's first row.
 */
async function answer(text, config, suggest, input) {
  // One row per URL: Chrome would quietly drop a second row with the same URL ("DEV | STAGE" instead).
  const rows = mergeSameUrl(search(text, config)).slice(0, MAX_SUGGESTIONS);
  // Name the link, and its group, when the rows don't all share them.
  const multipleLinks = new Set(rows.map((r) => r.link.key)).size > 1;
  const multipleGroups = new Set(rows.map((r) => r.group)).size > 1;
  const [first, ...rest] = rows;
  const description = first ? describe(first, multipleLinks, multipleGroups)
    : text.trim() ? "No matching link. Press Enter to open settings." : HINT;
  await chrome.omnibox.setDefaultSuggestion({ description });
  if (input !== latestInput) return; // more has been typed meanwhile
  suggest(rest.map((r) => ({ content: r.url, description: describe(r, multipleLinks, multipleGroups), deletable: false })));
}

// Each keystroke is answered at once from the config in memory. Only before it has been read does a
// keystroke wait, and then only the latest one answers: an earlier one finishing later would
// otherwise replace its rows with those for the shorter text.
let latestInput = 0;

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  const input = ++latestInput;
  if (config) return answer(text, config, suggest, input);
  const loaded = await loadConfig();
  if (input === latestInput) await answer(text, loaded, suggest, input);
});

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  const config = await loadConfig();
  let url = text.trim();
  let env = null;
  let group = null;

  // Suggestions carry the URL as their content; the default suggestion carries the typed text.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const [first] = search(text, config);
    if (!first) {
      chrome.runtime.openOptionsPage();
      return;
    }
    ({ url, env, group } = first);
  } else {
    ({ env, group } = environmentForUrl(config, url) || {}); // for grouping the tab by environment
  }

  // Respect modifier keys (Alt/Cmd+Enter); otherwise use the configured default.
  const target = disposition === "currentTab" ? config.openIn : disposition;
  await openLink(url, target, env, config, group);
});
