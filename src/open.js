// Opening a link, from the address bar or the toolbar list, and optionally grouping its tab
// with others from the same environment.

import { tabGroupColor, tabGroupTitle } from "./core.js";

// Naming and colouring groups needs the "tabGroups" permission. It's optional: Chrome asks for
// it when the user turns grouping on, so nobody else gets an install warning.
export const GROUP_PERMISSION = { permissions: ["tabGroups"] };

/**
 * Open url in the current tab, a new tab or a background tab, then, if grouping is on, move the
 * tab into a group named after env in its window (creating the group the first time).
 */
export async function openLink(url, target, env, config, group) {
  let tab;
  if (target === "currentTab") {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = active ? await chrome.tabs.update(active.id, { url }) : await chrome.tabs.create({ url });
  } else {
    tab = await chrome.tabs.create({ url, active: target === "newForegroundTab" });
  }
  if (group?.groupTabs && env && tab) { // a setting of each environment group
    try {
      await groupTab(tab, env, config, group);
    } catch (err) {
      // Grouping is a convenience; the link has already opened, so a failure here isn't fatal.
      console.warn("Couldn't group the tab:", err);
    }
  }
  return tab;
}

async function groupTab(tab, env, config, group) {
  if (!chrome.tabGroups || !(await chrome.permissions.contains(GROUP_PERMISSION))) return;
  const title = tabGroupTitle(config, group, env);
  const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
  const existing = groups.find((g) => g.title === title);
  if (existing) {
    if (tab.groupId !== existing.id) await chrome.tabs.group({ groupId: existing.id, tabIds: [tab.id] });
    return;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
  const index = Math.max(0, (group?.environments || []).findIndex((e) => e.id === env.id));
  await chrome.tabGroups.update(groupId, { title, color: tabGroupColor(env.name, index) });
}
