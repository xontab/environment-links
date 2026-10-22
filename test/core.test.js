import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, normalizeConfig, search, describe, render, parseQuery, isEmptyConfig } from "../src/core.js";

// A typical setup: four environments, a shared DOMAIN, and one link whose production URL differs.
const EXAMPLE = {
  openIn: "currentTab",
  variableNames: ["ENVIRONMENT", "DOMAIN"],
  globals: { DOMAIN: "example.com" },
  environments: [
    { id: "dev", name: "DEV", variables: { ENVIRONMENT: "dev" } },
    { id: "staging", name: "STAGING", variables: { ENVIRONMENT: "staging" } },
    { id: "preprod", name: "PREPROD", variables: { ENVIRONMENT: "preprod" } },
    { id: "production", name: "PRODUCTION", variables: {} },
  ],
  links: [
    { key: "backoffice", template: "backoffice.{{ENVIRONMENT}}.{{DOMAIN}}", overrides: { production: "backoffice.{{DOMAIN}}" } },
  ],
};
const config = normalizeConfig(EXAMPLE);

test("new installs start empty", () => {
  const fresh = normalizeConfig(DEFAULT_CONFIG);
  assert.equal(isEmptyConfig(fresh), true);
  assert.deepEqual(search("", fresh), []);
  assert.equal(isEmptyConfig(config), false);
});
const urls = (text) => search(text, config).map((r) => `${r.env.name} - ${r.url}`);

test("expands a link across every environment", () => {
  assert.deepEqual(urls("backoffice"), [
    "DEV - https://backoffice.dev.example.com",
    "STAGING - https://backoffice.staging.example.com",
    "PREPROD - https://backoffice.preprod.example.com",
    "PRODUCTION - https://backoffice.example.com",
  ]);
});

test("matches on prefix and substring, case-insensitively", () => {
  assert.equal(urls("BACK").length, 4);
  assert.equal(urls("office").length, 4);
  assert.equal(urls("nope").length, 0);
});

test("filters environments and appends a path", () => {
  assert.deepEqual(urls("backoffice stag prod /players/1"), [
    "STAGING - https://backoffice.staging.example.com/players/1",
    "PRODUCTION - https://backoffice.example.com/players/1",
  ]);
});

test("environment variables override globals and missing ones are reported", () => {
  const env = { variables: { DOMAIN: "other.io" } };
  assert.deepEqual(render("x.{{DOMAIN}}/{{ NOPE }}", env, { DOMAIN: "example.com" }), {
    url: "https://x.other.io/{{ NOPE }}",
    missing: ["NOPE"],
  });
  assert.equal(render("http://localhost:{{P}}", { variables: { P: 8080 } }).url, "http://localhost:8080");
});

test("exact key matches sort first", () => {
  const cfg = normalizeConfig({
    ...EXAMPLE,
    links: [{ key: "api-docs", template: "docs.{{DOMAIN}}" }, { key: "api", template: "api.{{DOMAIN}}" }],
  });
  assert.equal(search("api", cfg)[0].link.key, "api");
});

test("descriptions are XML-escaped", () => {
  const cfg = normalizeConfig({ environments: [{ name: "A&B" }], links: [{ key: "k", template: "x.com/?a=1&b=<2>" }] });
  assert.equal(describe(search("k", cfg)[0]), "<match>A&amp;B</match> - <url>x.com/?a=1&amp;b=&lt;2&gt;</url>");
});

test("normalizeConfig collects variable names from values", () => {
  const cfg = normalizeConfig({ globals: { A: 1 }, environments: [{ name: "Dev", variables: { B: 2 } }] });
  assert.deepEqual(cfg.variableNames, ["A", "B"]);
  assert.equal(cfg.environments[0].id, "dev");
  assert.deepEqual(parseQuery("  x  y "), { term: "x", envFilters: ["y"], path: "" });
});

// ---- Shared links -------------------------------------------------------------------------

import { resolveConfig, parseSharedFile, parseGitHubLocation, buildSharedFile, normalizeSource } from "../src/core.js";

const team = parseSharedFile(JSON.stringify({
  globals: { DOMAIN: "team.io", REGION: "eu" },
  environments: [
    { id: "dev", name: "Dev (team)", variables: { DOMAIN: "dev.team.io" } },
    { id: "qa", name: "QA", variables: { ENVIRONMENT: "qa" } },
  ],
  links: [
    { key: "grafana", template: "grafana.{{ENVIRONMENT}}.{{DOMAIN}}" },
    { key: "backoffice", template: "team-backoffice.{{DOMAIN}}" },
  ],
}));
const layer = (data, repo = "acme/links") => ({ source: normalizeSource({ repo }), data });

test("shared links are added after your own, and your own win on name clashes", () => {
  const eff = resolveConfig(config, [layer(team)]);
  assert.deepEqual(eff.links.map((l) => `${l.key}${l.source ? "@" + l.source : ""}`), ["backoffice", "grafana@acme/links"]);
  assert.equal(eff.sharedLinks.find((l) => l.key === "backoffice").shadowed, true);
});

test("variable precedence: shared default < own default < shared env < own env", () => {
  const eff = resolveConfig(config, [layer(team)]);
  const env = (id) => eff.environments.find((e) => e.id === id);
  assert.equal(env("staging").variables.DOMAIN, "example.com"); // own default beats shared default
  assert.equal(env("staging").variables.REGION, "eu"); // only the shared default has it
  assert.equal(env("dev").variables.DOMAIN, "dev.team.io"); // shared env value beats own default
  assert.equal(env("dev").name, "DEV"); // own name wins
  assert.equal(env("qa").source, "acme/links"); // environment only in the shared file is added
  assert.deepEqual(eff.environments.map((e) => e.id), ["dev", "staging", "preprod", "production", "qa"]);

  const own = normalizeConfig({ ...config, environments: [{ id: "dev", name: "DEV", variables: { DOMAIN: "mine.dev" } }] });
  assert.equal(resolveConfig(own, [layer(team)]).environments[0].variables.DOMAIN, "mine.dev");
  assert.equal(resolveConfig(own, [layer(team)]).environments[0].inherited.DOMAIN, "dev.team.io");
});

test("shared links render through search like any other", () => {
  const eff = resolveConfig(config, [layer(team)]);
  assert.deepEqual(search("graf qa", eff).map((r) => r.url), ["https://grafana.qa.example.com"]); // own default DOMAIN wins
});

test("earlier sources win over later ones", () => {
  const other = parseSharedFile(JSON.stringify({ links: [{ key: "grafana", template: "other.io" }] }));
  const eff = resolveConfig(config, [layer(team), layer(other, "other/links")]);
  assert.equal(eff.links.find((l) => l.key === "grafana").source, "acme/links");
  assert.equal(resolveConfig(config, [layer(null)]).links.length, 1); // never synced yet
});

test("parseSharedFile rejects bad files", () => {
  assert.throws(() => parseSharedFile("{nope"), /valid JSON/);
  assert.throws(() => parseSharedFile("[]"), /JSON object/);
  assert.throws(() => parseSharedFile("{}"), /no "links"/);
});

test("parseGitHubLocation accepts short names, repo URLs and file links", () => {
  assert.deepEqual(parseGitHubLocation("acme/team-links"), { repo: "acme/team-links" });
  assert.deepEqual(parseGitHubLocation("https://github.com/acme/team-links.git"), { repo: "acme/team-links" });
  assert.deepEqual(parseGitHubLocation("https://github.com/acme/team-links/blob/main/cfg/links.json"),
    { repo: "acme/team-links", branch: "main", path: "cfg/links.json" });
  assert.equal(parseGitHubLocation("https://gitlab.com/acme/x"), null);
  assert.equal(parseGitHubLocation("not a repo"), null);
});

test("buildSharedFile exports only the chosen links and the variables they use", () => {
  const cfg = normalizeConfig({
    ...EXAMPLE,
    globals: { DOMAIN: "example.com", SECRET_HOST: "me.local" },
    links: [...EXAMPLE.links, { key: "mine", template: "{{SECRET_HOST}}/x" }],
  });
  const file = buildSharedFile(cfg, ["backoffice"]);
  assert.deepEqual(file.links.map((l) => l.key), ["backoffice"]);
  assert.deepEqual(file.globals, { DOMAIN: "example.com" });
  assert.deepEqual(file.variableNames, ["ENVIRONMENT", "DOMAIN"]);
  assert.equal(file.environments[0].variables.ENVIRONMENT, "dev");
  assert.deepEqual(Object.keys(buildSharedFile(cfg, ["backoffice"], { includeValues: false })), ["links"]);
  // Round trip: the exported file is a valid shared file.
  assert.equal(parseSharedFile(JSON.stringify(file)).links[0].template, "backoffice.{{ENVIRONMENT}}.{{DOMAIN}}");
});

test("a saved environment order applies to own and shared environments alike", () => {
  const ordered = normalizeConfig({ ...config, environmentOrder: ["qa", "production", "dev"] });
  const ids = resolveConfig(ordered, [layer(team)]).environments.map((e) => e.id);
  // Listed ids first, in that order; the rest keep their usual place after them.
  assert.deepEqual(ids, ["qa", "production", "dev", "staging", "preprod"]);
  assert.deepEqual(search("back", resolveConfig(ordered, [layer(team)])).map((r) => r.env.id).slice(0, 2), ["qa", "production"]);
  assert.deepEqual(normalizeConfig({ environmentOrder: ["a", "a", 3] }).environmentOrder, ["a", "3"]);
});

test("a saved variable order applies to own and shared variables", () => {
  const shared = parseSharedFile(JSON.stringify({ variableNames: ["REGION"], globals: { REGION: "eu" }, links: [{ key: "x", template: "x" }] }));
  const plain = resolveConfig(config, [layer(shared)]).variableNames;
  assert.deepEqual(plain, ["ENVIRONMENT", "DOMAIN", "REGION"]);
  const ordered = normalizeConfig({ ...config, variableOrder: ["REGION", "DOMAIN"] });
  assert.deepEqual(resolveConfig(ordered, [layer(shared)]).variableNames, ["REGION", "DOMAIN", "ENVIRONMENT"]);
});

// ---- Tab groups ---------------------------------------------------------------------------

import { tabGroupColor, environmentForUrl } from "../src/core.js";

test("tab group colours follow environment names", () => {
  assert.deepEqual(["DEV", "QA", "STAGING", "PREPROD", "PRODUCTION"].map((n) => tabGroupColor(n)),
    ["green", "purple", "yellow", "orange", "red"]);
  assert.notEqual(tabGroupColor("Sandbox", 0), tabGroupColor("Demo", 1));
});

test("finds the environment of a URL, including one with a path added", () => {
  assert.equal(environmentForUrl(config, "https://backoffice.staging.example.com").id, "staging");
  assert.equal(environmentForUrl(config, "https://backoffice.example.com/players/1").id, "production");
  assert.equal(environmentForUrl(config, "https://backoffice.example.com.evil.io"), null);
  assert.equal(environmentForUrl(config, "https://elsewhere.io"), null);
  assert.equal(normalizeConfig({}).groupTabs, false);
  assert.equal(normalizeConfig({ groupTabs: true }).groupTabs, true);
});
