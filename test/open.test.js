import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// A small fake of the tabs and tabGroups APIs, enough for openLink.
let tabs, groups, granted, nextId;
globalThis.chrome = {
  permissions: { contains: async () => granted },
  tabs: {
    query: async () => tabs.filter((t) => t.active),
    update: async (id, { url }) => Object.assign(tabs.find((t) => t.id === id), { url }),
    create: async ({ url, active }) => {
      const tab = { id: nextId++, url, active: !!active, windowId: 1, groupId: -1 };
      tabs.push(tab);
      return tab;
    },
    group: async ({ tabIds, groupId, createProperties }) => {
      const id = groupId ?? (groups.push({ id: nextId++, windowId: createProperties.windowId, title: "", color: "grey" }), groups.at(-1).id);
      tabs.filter((t) => tabIds.includes(t.id)).forEach((t) => (t.groupId = id));
      return id;
    },
  },
  tabGroups: {
    query: async ({ windowId }) => groups.filter((g) => g.windowId === windowId),
    update: async (id, props) => Object.assign(groups.find((g) => g.id === id), props),
  },
};

const { openLink } = await import("../src/open.js");

const env = (id, name) => ({ id, name });
const config = { groupTabs: true, environments: [env("dev", "DEV"), env("production", "PRODUCTION")] };

beforeEach(() => {
  tabs = [{ id: 1, url: "about:blank", active: true, windowId: 1, groupId: -1 }];
  groups = [];
  granted = true;
  nextId = 100;
});

test("creates a coloured group named after the environment, then reuses it", async () => {
  const first = await openLink("https://a.prod", "newForegroundTab", env("production", "PRODUCTION"), config);
  assert.equal(groups.length, 1);
  assert.deepEqual({ title: groups[0].title, color: groups[0].color }, { title: "PRODUCTION", color: "red" });
  assert.equal(first.groupId, groups[0].id);

  const second = await openLink("https://b.prod", "newBackgroundTab", env("production", "PRODUCTION"), config);
  assert.equal(groups.length, 1); // same group
  assert.equal(second.groupId, groups[0].id);

  await openLink("https://a.dev", "newForegroundTab", env("dev", "DEV"), config);
  assert.deepEqual(groups.map((g) => `${g.title}:${g.color}`), ["PRODUCTION:red", "DEV:green"]);
});

test("the current tab is updated in place and moved into the group", async () => {
  const tab = await openLink("https://a.dev", "currentTab", env("dev", "DEV"), config);
  assert.equal(tab.id, 1);
  assert.equal(tabs.length, 1);
  assert.equal(tab.url, "https://a.dev");
  assert.equal(tab.groupId, groups[0].id);
});

test("no grouping when the setting is off, the permission is missing, or the environment is unknown", async () => {
  await openLink("https://x", "newForegroundTab", env("dev", "DEV"), { ...config, groupTabs: false });
  granted = false;
  await openLink("https://y", "newForegroundTab", env("dev", "DEV"), config);
  granted = true;
  await openLink("https://z", "newForegroundTab", null, config);
  assert.equal(groups.length, 0);
  assert.equal(tabs.length, 4); // the links still opened
});
