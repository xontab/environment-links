// Pure logic shared by the service worker, the options page and the tests.
// No chrome.* calls in here.

// New installs start empty; the settings page walks the user through setting up.
export const DEFAULT_CONFIG = {
  openIn: "currentTab", // currentTab | newForegroundTab | newBackgroundTab
  groupTabs: false, // put opened links in a tab group per environment
  variableNames: [],
  globals: {},
  environments: [],
  links: [],
};

/** True when the user has nothing set up yet, neither their own nor from a shared file. */
export function isEmptyConfig(config) {
  return !config.environments.length && !config.links.length && !config.variableNames.length;
}

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Fill in a config loaded from storage so older/partial configs still work. */
export function normalizeConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const globals = { ...(cfg.globals || {}) };
  const environments = (cfg.environments || []).map((env, i) => ({
    id: String(env.id || slug(env.name) || `env${i}`),
    name: String(env.name || env.id || `ENV ${i + 1}`),
    variables: { ...(env.variables || {}) },
  }));
  // Keep the declared order, then any variable only found in the values.
  const variableNames = [
    ...new Set([
      ...(cfg.variableNames || []),
      ...Object.keys(globals),
      ...environments.flatMap((e) => Object.keys(e.variables)),
    ]),
  ].filter(Boolean);
  return {
    openIn: cfg.openIn || DEFAULT_CONFIG.openIn,
    groupTabs: cfg.groupTabs === true,
    variableNames,
    globals,
    environments,
    links: normalizeLinks(cfg.links),
    sources: (cfg.sources || []).map(normalizeSource).filter((src) => src.repo),
    // The order environments are listed in, by id. It covers shared environments too, so they
    // can be reordered alongside the user's own. Ids not listed keep their place at the end.
    environmentOrder: [...new Set((Array.isArray(cfg.environmentOrder) ? cfg.environmentOrder : []).map(String))],
    // The same for variable columns, covering shared variables too.
    variableOrder: [...new Set((Array.isArray(cfg.variableOrder) ? cfg.variableOrder : []).map(String))],
  };
}

function normalizeLinks(links) {
  return (Array.isArray(links) ? links : []).map((link) => ({
    key: String(link?.key || "").trim(),
    template: String(link?.template || ""),
    overrides: { ...(link?.overrides || {}) },
  }));
}

// ---- Shared links from GitHub ---------------------------------------------

export const DEFAULT_SHARED_PATH = "environment-links.json";

/** A GitHub file to pull shared links from. An empty branch means the repo's default branch. */
export function normalizeSource(src) {
  const repo = String(src?.repo || "").trim().replace(/^\/+|\/+$/g, "");
  const branch = String(src?.branch || "").trim();
  const path = String(src?.path || DEFAULT_SHARED_PATH).trim().replace(/^\/+/, "") || DEFAULT_SHARED_PATH;
  return { id: String(src?.id || slug(`${repo}-${branch}-${path}`)), repo, branch, path };
}

/**
 * Accepts "owner/repo", a repo URL, or a link to the file itself, e.g.
 * https://github.com/acme/links/blob/main/team/environment-links.json
 * Returns { repo, branch, path } (branch/path only when the URL contains them) or null.
 */
export function parseGitHubLocation(text) {
  const input = String(text || "").trim();
  const short = input.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (short) return { repo: `${short[1]}/${short[2]}` };
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null;
  const [owner, name, kind, branch, ...rest] = url.pathname.split("/").filter(Boolean);
  if (!owner || !name) return null;
  const location = { repo: `${owner}/${name.replace(/\.git$/, "")}` };
  if ((kind === "blob" || kind === "tree") && branch) {
    location.branch = branch;
    if (rest.length) location.path = rest.join("/");
  }
  return location;
}

/** Validate and normalise the text of a shared file. Throws with a readable message. */
export function parseSharedFile(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`The file isn't valid JSON (${err.message}).`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The file must contain a JSON object.");
  const cfg = normalizeConfig(raw);
  if (!cfg.links.length && !cfg.environments.length) {
    throw new Error('The file has no "links" or "environments".');
  }
  return {
    variableNames: cfg.variableNames,
    globals: cfg.globals,
    environments: cfg.environments,
    links: cfg.links.filter((l) => l.key),
  };
}

/**
 * Combine the user's own config with shared layers (one per source, in order).
 * Shared values sit underneath the user's: their own links, environment names and
 * variable values always win. Precedence for a variable, lowest first:
 *   shared default < own default < shared environment value < own environment value
 *
 * The result works anywhere a normal config does, plus:
 *   env.source / link.source  set on items that only come from a shared file
 *   env.inherited             the values an environment gets without its own (for placeholders)
 *   sharedGlobals             shared defaults (placeholders for the Default row)
 *   sharedLinks               every shared link, with `shadowed` when an own link has its name
 */
export function resolveConfig(local, layers = []) {
  const sharedGlobals = {};
  const sharedEnvs = new Map();
  const sharedLinks = [];
  const seenKeys = new Set(local.links.map((l) => l.key.toLowerCase()).filter(Boolean));
  const sharedKeys = new Set();

  for (const { source, data } of layers) {
    if (!data) continue;
    for (const [k, v] of Object.entries(data.globals || {})) if (!(k in sharedGlobals)) sharedGlobals[k] = v;
    for (const env of data.environments || []) {
      const entry = sharedEnvs.get(env.id) || { id: env.id, name: env.name, source: source.repo, variables: {} };
      for (const [k, v] of Object.entries(env.variables || {})) if (!(k in entry.variables)) entry.variables[k] = v;
      sharedEnvs.set(env.id, entry);
    }
    for (const link of data.links || []) {
      const key = link.key.toLowerCase();
      if (sharedKeys.has(key)) continue; // an earlier source already provides it
      sharedKeys.add(key);
      sharedLinks.push({ ...link, source: source.repo, shadowed: seenKeys.has(key) });
    }
  }

  const globals = { ...sharedGlobals, ...local.globals };
  const build = (id, name, own, source) => {
    const inherited = { ...globals, ...(sharedEnvs.get(id)?.variables || {}) };
    return { id, name, variables: { ...inherited, ...own }, inherited, ...(source ? { source } : {}) };
  };
  const localIds = new Set(local.environments.map((e) => e.id));
  const environments = sortByOrder([
    ...local.environments.map((e) => build(e.id, e.name, e.variables)),
    ...[...sharedEnvs.values()].filter((e) => !localIds.has(e.id)).map((e) => build(e.id, e.name, {}, e.source)),
  ], local.environmentOrder || []);

  const variableNames = sortByOrder(
    [...new Set([...local.variableNames, ...layers.flatMap(({ data }) => data?.variableNames || [])])].map((id) => ({ id })),
    local.variableOrder || []
  ).map((v) => v.id);

  return {
    ...local,
    variableNames,
    globals,
    environments,
    links: [...local.links, ...sharedLinks.filter((l) => !l.shadowed)],
    sharedGlobals,
    sharedLinks,
  };
}

/** Put environments in the saved order; any not in it follow, in their current order. */
function sortByOrder(environments, order) {
  if (!order.length) return environments;
  const rank = new Map(order.map((id, i) => [id, i]));
  return environments
    .map((env, i) => ({ env, i, r: rank.has(env.id) ? rank.get(env.id) : Infinity }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.env);
}

// ---- Tab groups --------------------------------------------------------------

/** Chrome's tab group colours, in the order used for environments whose names don't suggest one. */
const GROUP_FALLBACK = ["blue", "cyan", "pink", "grey"];

/**
 * The tab group colour for an environment, from its name: production red, pre-production orange,
 * staging yellow, test purple, development green. Anything else cycles through the rest.
 */
export function tabGroupColor(name, index = 0) {
  const n = String(name || "").toLowerCase();
  if (/pre-?prod|uat|pre-?live/.test(n)) return "orange";
  if (/prod|prd|\blive\b/.test(n)) return "red";
  if (/stag|stg/.test(n)) return "yellow";
  if (/\b(qa|tst|sit)\b|test/.test(n)) return "purple";
  if (/dev|local/.test(n)) return "green";
  return GROUP_FALLBACK[index % GROUP_FALLBACK.length];
}

/**
 * The environment a URL belongs to, for address-bar suggestions, which only carry the URL.
 * A URL with a path appended still matches its link; the longest match wins.
 */
export function environmentForUrl(config, url) {
  let best = null;
  for (const link of config.links) {
    for (const r of expandLink(link, config)) {
      if (!r.url || r.missing.length) continue;
      const base = r.url.replace(/\/+$/, "");
      if ((url === base || url.startsWith(base + "/") || url.startsWith(base + "?")) && (!best || base.length > best.length)) {
        best = { env: r.env, length: base.length };
      }
    }
  }
  return best?.env || null;
}

/** Variable names a link uses in its template or overrides. */
export function variablesUsed(link) {
  const names = new Set();
  for (const text of [link.template, ...Object.values(link.overrides || {})]) {
    for (const [, name] of String(text).matchAll(VAR_RE)) names.add(name);
  }
  return names;
}

/**
 * Build the contents of a shared file from some of the user's links. Environments and
 * defaults are included only for the variables those links use, unless includeValues is false.
 */
export function buildSharedFile(config, keys, { includeValues = true } = {}) {
  const wanted = new Set(keys);
  const links = config.links
    .filter((l) => l.key && wanted.has(l.key))
    .map(({ key, template, overrides }) => ({
      key,
      template,
      ...(Object.keys(overrides).length ? { overrides } : {}),
    }));
  const used = new Set(links.flatMap((l) => [...variablesUsed(l)]));
  const pick = (vars) => Object.fromEntries(Object.entries(vars).filter(([k]) => used.has(k)));
  const file = { links };
  if (includeValues) {
    file.variableNames = config.variableNames.filter((n) => used.has(n));
    file.globals = pick(config.globals);
    file.environments = config.environments.map(({ id, name, variables }) => ({ id, name, variables: pick(variables) }));
  }
  return file;
}

export function slug(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Render a template for one environment. Environment variables win over globals.
 * Returns { url, missing } where missing lists variables with no value defined.
 */
export function render(template, env, globals = {}) {
  const vars = { ...globals, ...(env?.variables || {}) };
  const missing = [];
  const out = template.replace(VAR_RE, (whole, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name]);
    missing.push(name);
    return whole;
  });
  return { url: withScheme(out.trim()), missing };
}

export function withScheme(url) {
  if (!url) return url;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

export function displayUrl(url) {
  return url.replace(/^https:\/\//i, "");
}

/** Render a link for every environment (respecting per-environment overrides). */
export function expandLink(link, config) {
  return config.environments.map((env) => {
    const override = link.overrides?.[env.id];
    const template = override && override.trim() ? override : link.template;
    return { env, link, ...render(template, env, config.globals) };
  });
}

/**
 * Parse omnibox text: "<link> [env filters...] [/extra/path]".
 *   "backoffice"              -> all environments
 *   "backoffice dev prod"     -> DEV and PRODUCTION only
 *   "backoffice stag /users"  -> STAGING, with /users appended
 */
export function parseQuery(text) {
  const tokens = String(text || "").trim().split(/\s+/).filter(Boolean);
  const [term = "", ...rest] = tokens;
  const path = rest.filter((t) => t.startsWith("/")).join("");
  const envFilters = rest.filter((t) => !t.startsWith("/")).map((t) => t.toLowerCase());
  return { term: term.toLowerCase(), envFilters, path };
}

function envMatches(env, filters) {
  if (!filters.length) return true;
  const names = [env.name.toLowerCase(), env.id.toLowerCase()];
  return filters.some((f) => names.some((n) => n.startsWith(f)));
}

function appendPath(url, path) {
  if (!path) return url;
  return url.replace(/\/+$/, "") + path;
}

/** Score how well a link key matches the typed term; null means no match. */
function score(key, term) {
  const k = key.toLowerCase();
  if (!term) return 3;
  if (k === term) return 0;
  if (k.startsWith(term)) return 1;
  if (k.includes(term)) return 2;
  return null;
}

/** Ordered list of { env, link, url, missing } results for omnibox text. */
export function search(text, config) {
  const { term, envFilters, path } = parseQuery(text);
  const links = config.links
    .filter((l) => l.key)
    .map((l) => ({ l, s: score(l.key, term) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => a.s - b.s || a.l.key.localeCompare(b.l.key))
    .map((x) => x.l);

  return links.flatMap((link) =>
    expandLink(link, config)
      .filter((r) => envMatches(r.env, envFilters))
      .map((r) => ({ ...r, url: appendPath(r.url, path) }))
  );
}

/** Escape text for chrome.omnibox suggestion descriptions (XML). */
export function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function describe(result, showKey) {
  const prefix = showKey ? `<dim>${escapeXml(result.link.key)}</dim> ` : "";
  const warn = result.missing.length
    ? ` <dim>(missing: ${escapeXml(result.missing.join(", "))})</dim>`
    : "";
  return `${prefix}<match>${escapeXml(result.env.name)}</match> - <url>${escapeXml(
    displayUrl(result.url)
  )}</url>${warn}`;
}
