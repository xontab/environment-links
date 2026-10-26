import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// A stand-in for the chrome.* APIs background.js uses, where storage can be told to answer
// slowly, to check what the address bar ends up showing when keys are typed quickly.
const listeners = {};
const on = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
const stores = { sync: {}, local: {} };
let delays = [];
const area = (store) => ({
  get: async (key) => {
    const ms = delays.shift() ?? 0;
    if (ms) await new Promise((r) => setTimeout(r, ms));
    return { [key]: structuredClone(store[key]) };
  },
  set: async (items) => Object.assign(store, structuredClone(items)),
});
let defaults = [];
let order = []; // what reached Chrome, in order
let storeDelay = 0; // how long Chrome takes to store the first row
globalThis.chrome = {
  runtime: { onInstalled: on("installed"), onStartup: on("startup"), openOptionsPage() {} },
  alarms: { create() {}, onAlarm: on("alarm") },
  omnibox: {
    onInputStarted: on("started"), onInputChanged: on("changed"), onInputEntered: on("entered"),
    setDefaultSuggestion: async (s) => {
      if (storeDelay) await new Promise((r) => setTimeout(r, storeDelay));
      defaults.push(s.description);
      order.push("first row");
    },
  },
  storage: { sync: area(stores.sync), local: area(stores.local), onChanged: on("storage") },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  permissions: { contains: async () => false },
};

const CONFIG = {
  variableNames: ["ENV"],
  environments: ["dev", "staging", "preprod", "production"].map((id) => ({ id, name: id.toUpperCase(), variables: { ENV: id } })),
  links: [{ key: "backoffice", template: "bo.{{ENV}}.io" }, { key: "grafana", template: "grafana.{{ENV}}.io" }],
};
stores.sync.config = CONFIG;
await import("../src/background.js");
await new Promise((r) => setTimeout(r, 20)); // let start-up work settle

/** Type each text in turn, like keystrokes, and return the rows the address bar lists at the end. */
async function type(...texts) {
  const shown = [];
  await Promise.all(texts.map((text) => listeners.changed(text, (rows) => shown.push(rows))));
  const rows = shown.at(-1);
  return { default: defaults.at(-1), urls: rows.map((r) => r.content), descriptions: rows.map((r) => r.description) };
}

beforeEach(() => {
  delays = [];
  defaults = [];
  order = [];
  storeDelay = 0;
});

test("the rows are sent only once Chrome has stored the first row", async () => {
  storeDelay = 30;
  const shown = [];
  await listeners.changed("backoffice", (rows) => { order.push("rows"); shown.push(rows); });
  assert.deepEqual(order, ["first row", "rows"]);
  // A keystroke while the first row is being stored: the earlier one sends nothing.
  order = [];
  await Promise.all(["backoffice p", "backoffice pre"].map((text) => listeners.changed(text, () => order.push(`rows for ${text}`))));
  assert.deepEqual(order, ["first row", "first row", "rows for backoffice pre"]);
  assert.equal(defaults.at(-1), "<match>PREPROD</match> - <url>bo.preprod.io</url>");
});

test("the address bar lists the latest text's matches, even when an earlier keystroke is slower", async () => {
  // A slow load for the first keystroke used to answer last and replace the later one's rows.
  delays = [60, 60, 0, 0];
  const shown = await type("back", "backoffice pre");
  assert.equal(shown.default, "<match>PREPROD</match> - <url>bo.preprod.io</url>");
  assert.deepEqual(shown.urls, []); // only PREPROD matches "pre", and it's the first row
});

test("the first match is the first row, and the rest follow", async () => {
  const shown = await type("backoffice");
  assert.equal(shown.default, "<match>DEV</match> - <url>bo.dev.io</url>");
  assert.deepEqual(shown.urls, ["https://bo.staging.io", "https://bo.preprod.io", "https://bo.production.io"]);
  assert.equal((await type("nothing matches this")).default, "No matching link. Press Enter to open settings.");
});

test("environments that open the same URL share a row, so none goes missing", async () => {
  // Chrome drops a row whose URL another row already has; here DEV and STAGE are one ArgoCD.
  stores.sync.config = { ...CONFIG, links: [{ key: "argocd", template: "argocd.example.io", overrides: { production: "argocd.prod.io" } }] };
  listeners.storage({ config: { newValue: stores.sync.config } }, "sync");
  await new Promise((r) => setTimeout(r, 10));
  const shown = await type("argo");
  assert.equal(shown.default, "<match>DEV \u00a0|\u00a0 STAGING \u00a0|\u00a0 PREPROD</match> - <url>argocd.example.io</url>");
  assert.deepEqual(shown.urls, ["https://argocd.prod.io"]);
  stores.sync.config = CONFIG;
  listeners.storage({ config: { newValue: CONFIG } }, "sync");
  await new Promise((r) => setTimeout(r, 10));
});

test("the first row and the rest always come from the same search", async () => {
  // Like the screenshot: "c" matches links in two groups, so its rows name the link; "cd" only
  // matches ArgoCD in one group, so they don't. The first row must not be left over from "c".
  stores.sync.config = {
    groups: [
      { id: "pam", name: "Elantil PAM", variableNames: ["E"],
        environments: ["DEV", "STAGE", "PROD"].map((n) => ({ id: n.toLowerCase(), name: n, variables: { E: n.toLowerCase() } })),
        links: [{ key: "ArgoCD", template: "argocd.{{E}}.io" }, { key: "Confluence", template: "wiki.{{E}}.io" }] },
      { id: "ops", name: "Ops", environments: [{ id: "live", name: "LIVE" }], links: [{ key: "cloud", template: "c.io" }] },
    ],
  };
  listeners.storage({ config: { newValue: stores.sync.config } }, "sync");
  await new Promise((r) => setTimeout(r, 10));
  const shown = await type("c", "cd");
  // One link in one group, so no row names it: the first row isn't left over from "c", where all would.
  assert.equal(shown.default, "<match>DEV</match> - <url>argocd.dev.io</url>");
  assert.deepEqual(shown.descriptions, [
    "<match>STAGE</match> - <url>argocd.stage.io</url>",
    "<match>PROD</match> - <url>argocd.prod.io</url>",
  ]);
  stores.sync.config = CONFIG;
  listeners.storage({ config: { newValue: CONFIG } }, "sync");
  await new Promise((r) => setTimeout(r, 10));
});

test("settings are read once and kept until they change", async () => {
  await type("back");
  delays = [500, 500]; // a read now would be slow; a kept copy answers at once
  const started = Date.now();
  await type("graf");
  assert.ok(Date.now() - started < 200);
  // A change to the settings is picked up.
  delays = [];
  stores.sync.config = { ...CONFIG, links: [{ key: "kibana", template: "k.{{ENV}}.io" }] };
  listeners.storage({ config: { newValue: stores.sync.config } }, "sync");
  await new Promise((r) => setTimeout(r, 10)); // it's read again in the background
  assert.equal((await type("kib")).default, "<match>DEV</match> - <url>k.dev.io</url>");
});
