// Loading the user's config together with shared files pulled from GitHub.
// Used by the service worker, the popup and the settings page.
//
// Storage layout:
//   sync  "config"  the user's own settings, including config.sources (no secrets)
//   local "shared"  { [sourceId]: { data, etag, syncedAt, okAt, error } }  the last fetched copy of each file
//                   (syncedAt: the last attempt; okAt: the last one that worked)
//   local "tokens"  { [sourceId]: token }  GitHub tokens; kept on this device, never synced or exported

import { DEFAULT_CONFIG, normalizeConfig, parseSharedFile, resolveConfig } from "./core.js";

export const CONFIG_KEY = "config";
const SHARED_KEY = "shared";
const TOKENS_KEY = "tokens";
export const GITHUB_PERMISSION = { origins: ["https://api.github.com/*"] };

export async function loadLocalConfig() {
  const stored = await chrome.storage.sync.get(CONFIG_KEY);
  return normalizeConfig(stored[CONFIG_KEY] || structuredClone(DEFAULT_CONFIG));
}

export async function loadCache() {
  return (await chrome.storage.local.get(SHARED_KEY))[SHARED_KEY] || {};
}

/** One layer per configured source, in order, using the last copy fetched. */
export function layersFor(config, cache) {
  return config.sources.map((source) => ({ source, data: cache[source.id]?.data || null }));
}

/** The config the address bar and popup use: the user's own settings plus every shared layer. */
export async function loadEffectiveConfig() {
  const [config, cache] = await Promise.all([loadLocalConfig(), loadCache()]);
  return resolveConfig(config, layersFor(config, cache));
}

export async function loadTokens() {
  return (await chrome.storage.local.get(TOKENS_KEY))[TOKENS_KEY] || {};
}

export async function setToken(sourceId, token) {
  const tokens = await loadTokens();
  if (token) tokens[sourceId] = token;
  else delete tokens[sourceId];
  await chrome.storage.local.set({ [TOKENS_KEY]: tokens });
}

/** Drop the cached file and token of sources that no longer exist. */
export async function forgetRemovedSources(config) {
  const ids = new Set(config.sources.map((s) => s.id));
  const [cache, tokens] = await Promise.all([loadCache(), loadTokens()]);
  for (const id of Object.keys(cache)) if (!ids.has(id)) delete cache[id];
  for (const id of Object.keys(tokens)) if (!ids.has(id)) delete tokens[id];
  await chrome.storage.local.set({ [SHARED_KEY]: cache, [TOKENS_KEY]: tokens });
}

function contentsUrl({ repo, branch, path }) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : "";
  return `https://api.github.com/repos/${repo}/contents/${encodedPath}${ref}`;
}

async function describeFailure(response, hasToken) {
  if (response.status === 404) {
    return hasToken
      ? "File not found. Check the repository, branch and path, and that the token can read this repository."
      : "File not found. Check the repository, branch and path. For a private repository, add an access token.";
  }
  if (response.status === 401) return "GitHub rejected the access token. It may have expired.";
  if (response.status === 403 || response.status === 429) {
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      const when = reset ? ` Try again after ${new Date(reset).toLocaleTimeString()}.` : "";
      return `GitHub's rate limit was reached.${when}${hasToken ? "" : " Adding an access token raises the limit."}`;
    }
    return "GitHub refused access. Check that the token can read this repository.";
  }
  return `GitHub returned ${response.status} ${response.statusText}.`.trim();
}

/** Fetch one source and update its cached copy. A failed sync keeps the previous copy. */
export async function syncSource(source) {
  const [cache, tokens] = await Promise.all([loadCache(), loadTokens()]);
  const previous = cache[source.id] || {};
  const token = tokens[source.id];
  // okAt is when it last worked. Copies cached before it existed only have syncedAt, which was a
  // good sync if no error was recorded with it.
  const okAt = previous.okAt ?? (previous.data && !previous.error ? previous.syncedAt : undefined);
  const entry = { ...previous, syncedAt: Date.now(), ...(okAt ? { okAt } : {}), error: null };

  try {
    if (!(await chrome.permissions.contains(GITHUB_PERMISSION))) {
      throw new Error("Allow access to GitHub (api.github.com) to sync this file.");
    }
    const headers = { Accept: "application/vnd.github.raw+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (previous.etag && previous.data) headers["If-None-Match"] = previous.etag;

    const response = await fetch(contentsUrl(source), { headers, cache: "no-store" });
    if (response.status !== 304) {
      if (!response.ok) throw new Error(await describeFailure(response, Boolean(token)));
      entry.data = parseSharedFile(await response.text());
      entry.etag = response.headers.get("etag");
    }
    entry.okAt = entry.syncedAt; // a 304 means the copy we have is still the latest, so that counts too
  } catch (err) {
    entry.error = err.message || String(err);
  }

  // Re-read before writing so syncs of different sources don't overwrite each other.
  const latest = await loadCache();
  latest[source.id] = entry;
  await chrome.storage.local.set({ [SHARED_KEY]: latest });
  return entry;
}

export async function syncAll() {
  const config = await loadLocalConfig();
  for (const source of config.sources) await syncSource(source);
}
