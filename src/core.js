// Pure logic shared by the service worker, the options page and the tests.
// No chrome.* calls in here.

export const DEFAULT_CONFIG = {
  openIn: "currentTab", // currentTab | newForegroundTab | newBackgroundTab
  variableNames: ["ENVIRONMENT", "DOMAIN"],
  globals: { DOMAIN: "example.com" },
  environments: [
    { id: "dev", name: "DEV", variables: { ENVIRONMENT: "dev" } },
    { id: "staging", name: "STAGING", variables: { ENVIRONMENT: "staging" } },
    { id: "preprod", name: "PREPROD", variables: { ENVIRONMENT: "preprod" } },
    { id: "production", name: "PRODUCTION", variables: {} },
  ],
  links: [
    {
      key: "backoffice",
      template: "backoffice.{{ENVIRONMENT}}.{{DOMAIN}}",
      overrides: { production: "backoffice.{{DOMAIN}}" },
    },
  ],
};

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
    variableNames,
    globals,
    environments,
    links: (cfg.links || []).map((link) => ({
      key: (link.key || "").trim(),
      template: link.template || "",
      overrides: { ...(link.overrides || {}) },
    })),
  };
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
