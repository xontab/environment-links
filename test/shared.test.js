import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// A minimal stand-in for the chrome.* APIs shared.js uses.
const stores = { sync: {}, local: {} };
let granted = true;
const area = (store) => ({
  get: async (key) => ({ [key]: structuredClone(store[key]) }),
  set: async (items) => Object.assign(store, structuredClone(items)),
});
globalThis.chrome = {
  storage: { sync: area(stores.sync), local: area(stores.local) },
  permissions: { contains: async () => granted },
};

const { loadEffectiveConfig, syncSource, syncAll, setToken, forgetRemovedSources } = await import("../src/shared.js");

const FILE = { links: [{ key: "grafana", template: "grafana.{{ENVIRONMENT}}.example.com" }] };
const source = { id: "acme", repo: "acme/links", branch: "main", path: "team/links.json" };
let requests;
let reply;

beforeEach(() => {
  for (const store of Object.values(stores)) for (const k of Object.keys(store)) delete store[k];
  stores.sync.config = { environments: [{ id: "dev", name: "DEV", variables: { ENVIRONMENT: "dev" } }], links: [], sources: [source] };
  granted = true;
  requests = [];
  reply = () => new Response(JSON.stringify(FILE), { status: 200, headers: { etag: '"v1"' } });
  globalThis.fetch = async (url, init) => {
    requests.push({ url, headers: init.headers });
    return reply(url, init);
  };
});

test("syncs a file and serves its links through the effective config", async () => {
  await syncAll();
  assert.equal(requests[0].url, "https://api.github.com/repos/acme/links/contents/team/links.json?ref=main");
  assert.equal(requests[0].headers.Accept, "application/vnd.github.raw+json");
  assert.equal(requests[0].headers.Authorization, undefined);
  const eff = await loadEffectiveConfig();
  assert.deepEqual(eff.groups[0].links.map((l) => [l.key, l.source]), [["grafana", "acme/links"]]);
});

test("sends the saved token and the ETag, and keeps the copy on 304", async () => {
  await setToken("acme", "tok");
  await syncSource(source);
  reply = () => new Response(null, { status: 304 });
  const entry = await syncSource(source);
  assert.equal(requests[1].headers.Authorization, "Bearer tok");
  assert.equal(requests[1].headers["If-None-Match"], '"v1"');
  assert.equal(entry.error, null);
  assert.equal(entry.data.links[0].key, "grafana");
  assert.equal(JSON.stringify(stores.sync).includes("tok"), false); // tokens never go to sync storage
});

test("a failed sync reports why and keeps the last good copy", async () => {
  await syncSource(source);
  reply = () => new Response("{}", { status: 404, statusText: "Not Found" });
  const entry = await syncSource(source);
  assert.match(entry.error, /File not found/);
  assert.equal(entry.data.links.length, 1);

  reply = () => new Response("not json", { status: 200 });
  assert.match((await syncSource(source)).error, /valid JSON/);
  reply = () => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
  assert.match((await syncSource(source)).error, /rate limit.*access token/);
});

test("remembers when a file last synced, through failures and unchanged replies", async () => {
  const good = await syncSource(source);
  assert.equal(good.okAt, good.syncedAt);
  reply = () => new Response("{}", { status: 500, statusText: "Server Error" });
  const failed = await syncSource(source);
  assert.equal(failed.okAt, good.okAt); // the failure doesn't move it
  assert.ok(failed.syncedAt >= good.syncedAt);
  reply = () => new Response(null, { status: 304 });
  const unchanged = await syncSource(source);
  assert.equal(unchanged.okAt, unchanged.syncedAt); // still the latest copy, so it counts

  // A copy cached before okAt existed: its syncedAt was a good sync if it had no error.
  stores.local.shared = { acme: { data: good.data, etag: '"v1"', syncedAt: 1000, error: null } };
  reply = () => new Response("{}", { status: 500, statusText: "Server Error" });
  assert.equal((await syncSource(source)).okAt, 1000);
});

test("without GitHub access it doesn't fetch", async () => {
  granted = false;
  const entry = await syncSource(source);
  assert.equal(requests.length, 0);
  assert.match(entry.error, /Allow access to GitHub/);
});

test("removing a source forgets its cached file and token", async () => {
  await setToken("acme", "tok");
  await syncSource(source);
  await forgetRemovedSources({ sources: [] });
  assert.deepEqual(stores.local.shared, {});
  assert.deepEqual(stores.local.tokens, {});
});
