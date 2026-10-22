// Pure logic shared by the service worker, the options page and the tests.
// No chrome.* calls in here.

// New installs start empty; the settings page walks the user through setting up.
export const DEFAULT_CONFIG = {
  openIn: "currentTab", // currentTab | newForegroundTab | newBackgroundTab
  groupTabs: false, // put opened links in a tab group per environment
  groups: [],
};

// Environment groups keep unrelated setups apart, e.g. "PAM" and "Payments": each group has its
// own variables, environments and links. There's always at least one; with only one, its name
// isn't shown anywhere outside the settings page.
export const DEFAULT_GROUP = { id: "default", name: "Default" };

/** True when the user has nothing set up yet, neither their own nor from a shared file. */
export function isEmptyConfig(config) {
  return config.groups.every((g) => !g.environments.length && !g.links.length && !g.variableNames.length);
}

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Fill in a config loaded from storage so older/partial configs still work. A config from before
 * groups existed, with environments and links at the top level, becomes a single group.
 */
export function normalizeConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const rawGroups = Array.isArray(cfg.groups) ? cfg.groups : [{ ...DEFAULT_GROUP, ...cfg }];
  const groups = [];
  rawGroups.forEach((g, i) => {
    const group = normalizeGroup(g, i);
    while (groups.some((other) => other.id === group.id)) group.id += "-2"; // ids must be unique
    groups.push(group);
  });
  if (!groups.length) groups.push(normalizeGroup(DEFAULT_GROUP));
  return {
    openIn: cfg.openIn || DEFAULT_CONFIG.openIn,
    groupTabs: cfg.groupTabs === true,
    groups,
    sources: (cfg.sources || []).map(normalizeSource).filter((src) => src.repo),
  };
}

// ---- Settings files (Export / Import) ---------------------------------------------

/**
 * The version of the exported settings file. Bump it for a change that older versions of the
 * extension can't read, and teach normalizeConfig to upgrade files from before it.
 *   1  everything at the top level (no "formatVersion"; before environment groups)
 *   2  "groups", each with its own variables, environments and links
 */
export const SETTINGS_FORMAT = 2;

/** The file Export saves: the user's settings, marked with the format they're in. */
export function exportSettings(config) {
  return { formatVersion: SETTINGS_FORMAT, ...config };
}

/**
 * Read an exported settings file, from any version up to this one. Throws with a readable
 * message for one that isn't a settings file, or that a newer version of the extension wrote.
 */
export function importSettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected a JSON object");
  const version = raw.formatVersion ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new Error(`"formatVersion" should be a whole number, not ${JSON.stringify(version)}`);
  if (version > SETTINGS_FORMAT) {
    throw new Error(`this file is in format ${version}, from a newer version of Environment Links. Update the extension, then import it again.`);
  }
  const { formatVersion, ...settings } = raw;
  return normalizeConfig(settings);
}

/** One environment group: its name plus the variables, environments and links in it. */
export function normalizeGroup(raw, index = 0) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const name = String(cfg.name || "").trim() || (index ? `Group ${index + 1}` : DEFAULT_GROUP.name);
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
    id: String(cfg.id || slug(name) || `group${index + 1}`),
    name,
    variableNames,
    globals,
    environments,
    links: normalizeLinks(cfg.links),
    // The order environments are listed in, by id. It covers shared environments too, so they
    // can be reordered alongside the user's own. Ids not listed keep their place at the end.
    environmentOrder: [...new Set((Array.isArray(cfg.environmentOrder) ? cfg.environmentOrder : []).map(String))],
    // The same for variable columns, covering shared variables too.
    variableOrder: [...new Set((Array.isArray(cfg.variableOrder) ? cfg.variableOrder : []).map(String))],
  };
}

function normalizeLinks(links) {
  return (Array.isArray(links) ? links : []).map((link) => {
    // Environments the link doesn't apply to, by id: it isn't listed for them anywhere.
    const excluded = [...new Set((Array.isArray(link?.excluded) ? link.excluded : []).map(String))];
    return {
      key: String(link?.key || "").trim(),
      template: String(link?.template || ""),
      overrides: { ...(link?.overrides || {}) },
      ...(excluded.length ? { excluded } : {}),
    };
  });
}

/** True when a link is marked as not applicable to an environment. */
export const isExcluded = (link, env) => Boolean(link.excluded?.includes(env.id));

// ---- Shared links from GitHub ---------------------------------------------

export const DEFAULT_SHARED_PATH = "environment-links.json";

/** A GitHub file to pull shared links from. An empty branch means the repo's default branch. */
export function normalizeSource(src) {
  const repo = String(src?.repo || "").trim().replace(/^\/+|\/+$/g, "");
  const branch = String(src?.branch || "").trim();
  const path = String(src?.path || DEFAULT_SHARED_PATH).trim().replace(/^\/+/, "") || DEFAULT_SHARED_PATH;
  const group = String(src?.group || ""); // the environment group it feeds; empty means the first
  return { id: String(src?.id || slug(`${repo}-${branch}-${path}`)), repo, branch, path, ...(group ? { group } : {}) };
}

/** The group a source feeds: the one it names, or the first group if that one's gone. */
export function sourceGroupId(config, source) {
  return config.groups.some((g) => g.id === source.group) ? source.group : config.groups[0]?.id;
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
  const cfg = normalizeGroup(raw);
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
 * The effective config: each group combined with the shared layers whose source feeds it.
 * Returns the config with every group replaced by its resolved version (see resolveGroup).
 */
export function resolveConfig(config, layers = []) {
  return {
    ...config,
    groups: config.groups.map((group) =>
      resolveGroup(group, layers.filter(({ source }) => sourceGroupId(config, source) === group.id))),
  };
}

/**
 * Combine one of the user's groups with shared layers (one per source, in order).
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
export function resolveGroup(local, layers = []) {
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
  for (const group of config.groups) {
    for (const link of group.links) {
      for (const r of expandLink(link, group)) {
        if (!r.url || r.missing.length) continue;
        const base = r.url.replace(/\/+$/, "");
        if ((url === base || url.startsWith(base + "/") || url.startsWith(base + "?")) && (!best || base.length > best.length)) {
          best = { env: r.env, group, length: base.length };
        }
      }
    }
  }
  return best ? { env: best.env, group: best.group } : null;
}

/** A tab group's title: the environment's name, after its group's when there are several ("PAM · DEV"). */
export function tabGroupTitle(config, group, env) {
  return config.groups.length > 1 && group ? `${group.name} · ${env.name}` : env.name;
}

/**
 * A variable name as the settings page allows it: capitals, digits and underscores, not starting
 * with a digit ("api host" -> "API_HOST"). Shared files may still use any valid name.
 */
export function toVariableName(text) {
  return String(text || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^(?=\d)/, "_");
}

/** Change {{from}} to {{to}} in a link's template and overrides. */
export function renameInLink(link, from, to) {
  const re = new RegExp(`\\{\\{\\s*${from}\\s*\\}\\}`, "g"); // names are \w only, so no escaping needed
  link.template = link.template.replace(re, `{{${to}}}`);
  for (const [id, text] of Object.entries(link.overrides || {})) link.overrides[id] = text.replace(re, `{{${to}}}`);
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
 * Build the contents of a shared file from some of one group's links. Environments and
 * defaults are included only for the variables those links use, unless includeValues is false.
 */
export function buildSharedFile(group, keys, { includeValues = true } = {}) {
  const wanted = new Set(keys);
  const links = group.links
    .filter((l) => l.key && wanted.has(l.key))
    .map(({ key, template, overrides, excluded }) => ({
      key,
      template,
      ...(Object.keys(overrides).length ? { overrides } : {}),
      ...(excluded?.length ? { excluded } : {}),
    }));
  const used = new Set(links.flatMap((l) => [...variablesUsed(l)]));
  const pick = (vars) => Object.fromEntries(Object.entries(vars).filter(([k]) => used.has(k)));
  const file = { links };
  if (includeValues) {
    file.variableNames = group.variableNames.filter((n) => used.has(n));
    file.globals = pick(group.globals);
    file.environments = group.environments.map(({ id, name, variables }) => ({ id, name, variables: pick(variables) }));
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
  // Values filled into the user or password ("{{USER}}:{{PASS}}@host") are encoded, so one with
  // "@", ":", "/" or "#" in it can't end that part early. Found in the template, before any value is in.
  const credentials = template.match(TEMPLATE_CREDENTIALS_RE);
  const credentialsEnd = credentials ? credentials[0].length : -1;
  const out = template.replace(VAR_RE, (whole, name, offset) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      return offset < credentialsEnd ? encodeUserinfo(String(vars[name])) : String(vars[name]);
    }
    missing.push(name);
    return whole;
  });
  return { url: encodeCredentials(withScheme(out.trim())), missing };
}

export function withScheme(url) {
  if (!url) return url;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

// ---- Credentials in a URL (basic auth) ---------------------------------------------

// "https://user:password@host/...": everything between the scheme and the last "@" before the
// path is the user and password. Chrome sends them as basic auth when it opens the page.
const CREDENTIALS_RE = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)@/i;
// The same in a template, where the scheme is optional (https:// is added later).
const TEMPLATE_CREDENTIALS_RE = /^\s*(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]*@/i;

const safeDecode = (text) => { try { return decodeURIComponent(text); } catch { return text; } };
// Everything but letters, digits and - _ . ! ~ * ' ( ), as the address bar does: a bare "\" counts
// as "/" in an https URL and "<" or "]" make it invalid. A {{VARIABLE}} with no value yet stays readable.
const encodeUserinfo = (text) => String(text)
  .split(/(\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\})/)
  .map((part, i) => (i % 2 ? part : encodeURIComponent(safeDecode(part))))
  .join("");

/**
 * Percent-encode the user and password, so a password with "@", ":" or "#" in it doesn't break
 * the URL. Already-encoded ones are left as they are.
 */
export function encodeCredentials(url) {
  const match = url.match(CREDENTIALS_RE);
  if (!match) return url;
  const [whole, scheme, info] = match;
  const colon = info.indexOf(":"); // the user can't contain ":", so the first one starts the password
  const userinfo = colon < 0 ? encodeUserinfo(info)
    : `${encodeUserinfo(info.slice(0, colon))}:${encodeUserinfo(info.slice(colon + 1))}`;
  return `${scheme}${userinfo}@${url.slice(whole.length)}`;
}

export const hasCredentials = (url) => CREDENTIALS_RE.test(String(url || ""));

/** A URL for showing: without "https://", and with any password hidden ("admin:••••@host"). */
export function displayUrl(url) {
  return url
    .replace(CREDENTIALS_RE, (whole, scheme, info) => {
      const colon = info.indexOf(":");
      return `${scheme}${colon < 0 ? info : `${info.slice(0, colon)}:••••`}@`;
    })
    .replace(/^https:\/\//i, "");
}

/** Render a link for every environment in its group it applies to (respecting per-environment overrides). */
export function expandLink(link, group) {
  return group.environments.filter((env) => !isExcluded(link, env)).map((env) => {
    const override = link.overrides?.[env.id];
    const template = override && override.trim() ? override : link.template;
    return { env, link, group, ...render(template, env, group.globals) };
  });
}

/**
 * Parse omnibox text: "<link> [env or group filters...] [/extra/path]".
 *   "backoffice"              -> all environments
 *   "backoffice dev prod"     -> DEV and PRODUCTION only
 *   "backoffice stag /users"  -> STAGING, with /users appended
 *   "backoffice payments qa"  -> QA in the Payments group (see search)
 */
export function parseQuery(text) {
  const tokens = String(text || "").trim().split(/\s+/).filter(Boolean);
  const [term = "", ...rest] = tokens;
  const path = rest.filter((t) => t.startsWith("/")).join("");
  const envFilters = rest.filter((t) => !t.startsWith("/")).map((t) => t.toLowerCase());
  return { term: term.toLowerCase(), envFilters, path };
}

const startsAny = (names, filters) => filters.some((f) => names.some((n) => n.startsWith(f)));

// Environment names are matched ignoring case, spaces and dashes ("preprod" finds "Pre-Prod"), at
// the start of the name or of any word in it ("preprod" finds "EU PREPROD"). If some environment's
// whole name is the word, only those match, so "prod" picks "Prod" and not "Pre-Prod" too.
const squash = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, "");
const envNames = (env) => [env.name, env.id];
const isEnvNamed = (env, word) => envNames(env).some((n) => squash(n) === squash(word));
const envStartsWith = (env, word) => envNames(env).some((n) =>
  squash(n).startsWith(squash(word)) || n.toLowerCase().split(/[^a-z0-9]+/).some((w) => w && w.startsWith(squash(word))));

/** For each filter word, whether an environment matches it: by its whole name if any is, else by its start. */
function envFilter(filters, environments) {
  if (!filters.length) return () => true;
  const tests = filters.map((f) => (environments.some((e) => isEnvNamed(e, f)) ? (e) => isEnvNamed(e, f) : (e) => envStartsWith(e, f)));
  return (env) => tests.some((test) => test(env));
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

/**
 * Ordered list of { env, link, group, url, missing } results for omnibox text, from every group.
 *
 * Words can come in any order. Link names come first: the first word that matches a link's name
 * picks the links, and the others narrow them by environment, or by group when one starts a group's
 * name. Environments are the second priority: with no word matching a link ("prod"), every link is
 * listed for the matching environments, and a single word that matches both ("dev") lists the links
 * it names first, then every link in the environments it names.
 */
export function search(text, config) {
  const { term, envFilters, path } = parseQuery(text);
  const words = [term, ...envFilters].filter(Boolean);
  const linkWord = words.find((w) => config.groups.some((g) => g.links.some((l) => l.key && score(l.key, w) !== null)));
  const filters = words.filter((w, i) => i !== words.indexOf(linkWord));
  const results = matchLinks(linkWord ?? "", filters, path, config);
  if (words.length !== 1 || !linkWord) return results;

  // One word that names links: environments it names come second, without repeating a result.
  const seen = new Set(results.map((r) => `${r.group.id}\u0000${r.link.key}\u0000${r.env.id}`));
  return [...results, ...matchLinks("", [linkWord], path, config)
    .filter((r) => !seen.has(`${r.group.id}\u0000${r.link.key}\u0000${r.env.id}`))];
}

/** Links whose name matches term (all of them for ""), in the environments and groups filters pick. */
function matchLinks(term, filters, path, config) {
  const groupNames = (g) => [g.name.toLowerCase(), g.id.toLowerCase()];
  const groupFilters = config.groups.length > 1
    ? filters.filter((f) => config.groups.some((g) => startsAny(groupNames(g), [f])))
    : [];
  const envFilters = filters.filter((f) => !groupFilters.includes(f));
  const groups = groupFilters.length ? config.groups.filter((g) => startsAny(groupNames(g), groupFilters)) : config.groups;

  const links = groups
    .flatMap((group, order) => group.links.filter((l) => l.key).map((l) => ({ l, group, order, s: score(l.key, term) })))
    .filter((x) => x.s !== null)
    .sort((a, b) => a.s - b.s || a.l.key.localeCompare(b.l.key) || a.order - b.order);

  const envMatches = envFilter(envFilters, groups.flatMap((g) => g.environments));
  return links.flatMap(({ l, group }) =>
    expandLink(l, group)
      .filter((r) => envMatches(r.env))
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

/** An address-bar suggestion. showGroup names the result's group, for when there are several. */
export function describe(result, showKey, showGroup = false) {
  const label = [showGroup ? result.group?.name : "", showKey ? result.link.key : ""].filter(Boolean).join(" · ");
  const prefix = label ? `<dim>${escapeXml(label)}</dim> ` : "";
  const warn = result.missing.length
    ? ` <dim>(missing: ${escapeXml(result.missing.join(", "))})</dim>`
    : "";
  return `${prefix}<match>${escapeXml(result.env.name)}</match> - <url>${escapeXml(
    displayUrl(result.url)
  )}</url>${warn}`;
}
