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
  assert.deepEqual(cfg.groups[0].variableNames, ["A", "B"]);
  assert.equal(cfg.groups[0].environments[0].id, "dev");
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
  assert.deepEqual(eff.groups[0].links.map((l) => `${l.key}${l.source ? "@" + l.source : ""}`), ["backoffice", "grafana@acme/links"]);
  assert.equal(eff.groups[0].sharedLinks.find((l) => l.key === "backoffice").shadowed, true);
});

test("variable precedence: shared default < own default < shared env < own env", () => {
  const eff = resolveConfig(config, [layer(team)]);
  const env = (id) => eff.groups[0].environments.find((e) => e.id === id);
  assert.equal(env("staging").variables.DOMAIN, "example.com"); // own default beats shared default
  assert.equal(env("staging").variables.REGION, "eu"); // only the shared default has it
  assert.equal(env("dev").variables.DOMAIN, "dev.team.io"); // shared env value beats own default
  assert.equal(env("dev").name, "DEV"); // own name wins
  assert.equal(env("qa").source, "acme/links"); // environment only in the shared file is added
  assert.deepEqual(eff.groups[0].environments.map((e) => e.id), ["dev", "staging", "preprod", "production", "qa"]);

  const own = normalizeConfig({ ...EXAMPLE, environments: [{ id: "dev", name: "DEV", variables: { DOMAIN: "mine.dev" } }] });
  assert.equal(resolveConfig(own, [layer(team)]).groups[0].environments[0].variables.DOMAIN, "mine.dev");
  assert.equal(resolveConfig(own, [layer(team)]).groups[0].environments[0].inherited.DOMAIN, "dev.team.io");
});

test("shared links render through search like any other", () => {
  const eff = resolveConfig(config, [layer(team)]);
  assert.deepEqual(search("graf qa", eff).map((r) => r.url), ["https://grafana.qa.example.com"]); // own default DOMAIN wins
});

test("earlier sources win over later ones", () => {
  const other = parseSharedFile(JSON.stringify({ links: [{ key: "grafana", template: "other.io" }] }));
  const eff = resolveConfig(config, [layer(team), layer(other, "other/links")]);
  assert.equal(eff.groups[0].links.find((l) => l.key === "grafana").source, "acme/links");
  assert.equal(resolveConfig(config, [layer(null)]).groups[0].links.length, 1); // never synced yet
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
  const file = buildSharedFile(cfg.groups[0], ["backoffice"]);
  assert.deepEqual(file.links.map((l) => l.key), ["backoffice"]);
  assert.deepEqual(file.globals, { DOMAIN: "example.com" });
  assert.deepEqual(file.variableNames, ["ENVIRONMENT", "DOMAIN"]);
  assert.equal(file.environments[0].variables.ENVIRONMENT, "dev");
  assert.deepEqual(Object.keys(buildSharedFile(cfg.groups[0], ["backoffice"], { includeValues: false })), ["links"]);
  // Round trip: the exported file is a valid shared file.
  assert.equal(parseSharedFile(JSON.stringify(file)).links[0].template, "backoffice.{{ENVIRONMENT}}.{{DOMAIN}}");
});

test("a saved environment order applies to own and shared environments alike", () => {
  const ordered = normalizeConfig({ ...EXAMPLE, environmentOrder: ["qa", "production", "dev"] });
  const ids = resolveConfig(ordered, [layer(team)]).groups[0].environments.map((e) => e.id);
  // Listed ids first, in that order; the rest keep their usual place after them.
  assert.deepEqual(ids, ["qa", "production", "dev", "staging", "preprod"]);
  assert.deepEqual(search("back", resolveConfig(ordered, [layer(team)])).map((r) => r.env.id).slice(0, 2), ["qa", "production"]);
  assert.deepEqual(normalizeConfig({ environmentOrder: ["a", "a", 3] }).groups[0].environmentOrder, ["a", "3"]);
});

test("a saved variable order applies to own and shared variables", () => {
  const shared = parseSharedFile(JSON.stringify({ variableNames: ["REGION"], globals: { REGION: "eu" }, links: [{ key: "x", template: "x" }] }));
  const plain = resolveConfig(config, [layer(shared)]).groups[0].variableNames;
  assert.deepEqual(plain, ["ENVIRONMENT", "DOMAIN", "REGION"]);
  const ordered = normalizeConfig({ ...EXAMPLE, variableOrder: ["REGION", "DOMAIN"] });
  assert.deepEqual(resolveConfig(ordered, [layer(shared)]).groups[0].variableNames, ["REGION", "DOMAIN", "ENVIRONMENT"]);
});

// ---- Tab groups ---------------------------------------------------------------------------

import { tabGroupColor, environmentForUrl } from "../src/core.js";

test("tab group colours follow environment names", () => {
  assert.deepEqual(["DEV", "QA", "STAGING", "PREPROD", "PRODUCTION"].map((n) => tabGroupColor(n)),
    ["green", "purple", "yellow", "orange", "red"]);
  assert.notEqual(tabGroupColor("Sandbox", 0), tabGroupColor("Demo", 1));
});

test("finds the environment of a URL, including one with a path added", () => {
  assert.equal(environmentForUrl(config, "https://backoffice.staging.example.com").env.id, "staging");
  assert.equal(environmentForUrl(config, "https://backoffice.example.com/players/1").env.id, "production");
  assert.equal(environmentForUrl(config, "https://backoffice.example.com.evil.io"), null);
  assert.equal(environmentForUrl(config, "https://elsewhere.io"), null);
  assert.equal(normalizeConfig({}).groups[0].groupTabs, false);
  // The setting is per group now; the old global one turns it on for every group that doesn't say.
  assert.equal(normalizeConfig({ groupTabs: true }).groups[0].groupTabs, true);
  const both = normalizeConfig({ groupTabs: true, groups: [{ name: "A" }, { name: "B", groupTabs: false }] });
  assert.deepEqual(both.groups.map((g) => g.groupTabs), [true, false]);
  assert.equal("groupTabs" in both, false);
});

// ---- Environment groups -------------------------------------------------------------------

import { tabGroupTitle, sourceGroupId } from "../src/core.js";

// Two groups for different purposes, each with its own variables, environments and links.
const GROUPS = normalizeConfig({
  groups: [
    {
      id: "pam", name: "PAM", variableNames: ["ENV"],
      environments: [{ id: "dev", name: "DEV", variables: { ENV: "dev" } }, { id: "prod", name: "PRODUCTION", variables: { ENV: "prod" } }],
      links: [{ key: "backoffice", template: "bo.{{ENV}}.pam.com" }],
    },
    {
      id: "payments", name: "Payments", globals: { HOST: "pay.com" },
      environments: [{ id: "qa", name: "QA", variables: { ENV: "qa" } }, { id: "live", name: "LIVE", variables: { ENV: "live" } }],
      links: [{ key: "backoffice", template: "bo.{{ENV}}.{{HOST}}" }, { key: "wallet", template: "wallet.{{ENV}}.{{HOST}}" }],
    },
  ],
  sources: [{ repo: "acme/pay", group: "payments" }, { repo: "acme/any" }],
});

test("a config from before groups becomes one group, keeping everything", () => {
  assert.deepEqual(config.groups.map((g) => [g.id, g.name, g.environments.length, g.links.length]), [["default", "Default", 4, 1]]);
  assert.equal(config.openIn, "currentTab");
  assert.equal(normalizeConfig({}).groups.length, 1); // there's always a group to add things to
  assert.deepEqual(normalizeConfig({ groups: [{ name: "A" }, { name: "a" }] }).groups.map((g) => g.id), ["a", "a-2"]);
});

test("a link expands only to its own group's environments", () => {
  const found = (q) => search(q, GROUPS).map((r) => `${r.group.name}/${r.env.name}=${r.url}`);
  assert.deepEqual(found("wallet"), ["Payments/QA=https://wallet.qa.pay.com", "Payments/LIVE=https://wallet.live.pay.com"]);
  assert.equal(found("backoffice").length, 4);
});

test("typing a group's name narrows to that group, alongside environment filters", () => {
  assert.deepEqual(search("backoffice payments", GROUPS).map((r) => r.url), ["https://bo.qa.pay.com", "https://bo.live.pay.com"]);
  assert.deepEqual(search("backoffice pay live", GROUPS).map((r) => r.url), ["https://bo.live.pay.com"]);
  assert.deepEqual(search("backoffice prod", GROUPS).map((r) => r.url), ["https://bo.prod.pam.com"]);
});

test("the group shows in suggestions and tab group titles when there are several", () => {
  const [result] = search("wallet qa", GROUPS);
  assert.match(describe(result, false, true), /^<dim>Payments<\/dim> <match>QA<\/match>/);
  assert.equal(tabGroupTitle(GROUPS, result.group, result.env), "QA · Payments");
  assert.equal(tabGroupTitle(config, config.groups[0], config.groups[0].environments[0]), "DEV");
  assert.equal(environmentForUrl(GROUPS, "https://wallet.live.pay.com/x").group.id, "payments");
});

test("each shared source feeds one group; one without a group feeds the first", () => {
  assert.deepEqual(GROUPS.sources.map((src) => sourceGroupId(GROUPS, src)), ["payments", "pam"]);
  const pay = parseSharedFile(JSON.stringify({ links: [{ key: "refunds", template: "refunds.{{ENV}}.{{HOST}}" }] }));
  const eff = resolveConfig(GROUPS, [{ source: GROUPS.sources[0], data: pay }]);
  assert.deepEqual(eff.groups.map((g) => g.links.map((l) => l.key)), [["backoffice"], ["backoffice", "wallet", "refunds"]]);
  assert.deepEqual(search("refunds", eff).map((r) => r.env.name), ["QA", "LIVE"]);
});

// ---- Environments a link doesn't apply to ---------------------------------------------------

import { isExcluded } from "../src/core.js";

test("a link can be marked as not applicable to some environments", () => {
  const cfg = normalizeConfig({ ...EXAMPLE, links: [{ ...EXAMPLE.links[0], excluded: ["preprod", "preprod", "staging"] }] });
  const [link] = cfg.groups[0].links;
  assert.deepEqual(link.excluded, ["preprod", "staging"]);
  assert.deepEqual(search("backoffice", cfg).map((r) => r.env.name), ["DEV", "PRODUCTION"]);
  assert.equal(search("backoffice stag", cfg).length, 0);
  assert.equal(environmentForUrl(cfg, "https://backoffice.staging.example.com"), null);
  assert.equal(isExcluded(link, { id: "dev" }), false);
  assert.equal("excluded" in config.groups[0].links[0], false); // not stored when there are none
});

test("shared files keep the environments a link doesn't apply to", () => {
  const cfg = normalizeConfig({ ...EXAMPLE, links: [{ ...EXAMPLE.links[0], excluded: ["production"] }] });
  const file = buildSharedFile(cfg.groups[0], ["backoffice"]);
  assert.deepEqual(file.links[0].excluded, ["production"]);
  assert.deepEqual(parseSharedFile(JSON.stringify(file)).links[0].excluded, ["production"]);
});

// ---- Variable names typed in the settings page ------------------------------------------------

import { toVariableName, renameInLink } from "../src/core.js";

test("variable names from the settings page are capitals only", () => {
  assert.equal(toVariableName(" api host "), "API_HOST");
  assert.equal(toVariableName("region-2"), "REGION_2");
  assert.equal(toVariableName("9lives"), "_9LIVES");
});

test("renaming a variable inside a link changes its template and overrides", () => {
  const link = { key: "x", template: "x.{{d}}.{{ d }}/{{dd}}", overrides: { prod: "{{d}}.io" } };
  renameInLink(link, "d", "D");
  assert.equal(link.template, "x.{{D}}.{{D}}/{{dd}}");
  assert.deepEqual(link.overrides, { prod: "{{D}}.io" });
});

// ---- Settings files ------------------------------------------------------------------------------

import { SETTINGS_FORMAT, exportSettings, importSettings } from "../src/core.js";

test("exported settings say which format they're in, and import back the same", () => {
  const file = JSON.parse(JSON.stringify(exportSettings(GROUPS)));
  assert.equal(file.formatVersion, SETTINGS_FORMAT);
  assert.deepEqual(importSettings(file), GROUPS);
  assert.equal("formatVersion" in importSettings(file), false); // not kept in the settings themselves
});

test("files from before format versions are upgraded; newer formats are refused", () => {
  const old = importSettings(EXAMPLE); // format 1: no formatVersion, everything at the top level
  assert.deepEqual(old.groups.map((g) => [g.name, g.links.length]), [["Default", 1]]);
  assert.throws(() => importSettings({ formatVersion: SETTINGS_FORMAT + 1, groups: [] }), /newer version of Environment Links/);
  assert.throws(() => importSettings({ formatVersion: "2" }), /whole number/);
  assert.throws(() => importSettings([]), /JSON object/);
});

// ---- Basic auth in a URL --------------------------------------------------------------------

import { encodeCredentials, hasCredentials, displayUrl } from "../src/core.js";

test("a user and password in a template are kept, encoded where they'd break the URL", () => {
  const env = { variables: { USER: "admin", PASS: "p@ss:w#rd" } };
  assert.equal(render("{{USER}}:{{PASS}}@grafana.example.com/d", env).url, "https://admin:p%40ss%3Aw%23rd@grafana.example.com/d");
  assert.equal(encodeCredentials("https://admin:p%40ss@host"), "https://admin:p%40ss@host"); // already encoded
  assert.equal(encodeCredentials("https://token@host:8080/x"), "https://token@host:8080/x");
  assert.equal(encodeCredentials("https://host/users/@me"), "https://host/users/@me"); // an @ in the path isn't one
  assert.equal(render("{{USER}}:{{PASS}}@h", { variables: { USER: "a" } }).url, "https://a:{{PASS}}@h"); // missing stays readable
});

test("a password with any special characters opens as the address bar would", () => {
  const pass = String.raw`Ab<C9\D!5(E]9^n?Z:I<]`; // "\" ends the host in an https URL unless it's encoded
  const host = "d123.cloudfront.net";
  for (const url of [
    render(`https://admin:${encodeURIComponent(pass)}@${host}`, {}).url, // typed already encoded
    render("{{USER}}:{{PASS}}@" + host, { variables: { USER: "admin", PASS: pass } }).url, // from variables
    render("{{USER}}:{{PASS}}@" + host, { variables: { USER: "admin", PASS: encodeURIComponent(pass) } }).url,
  ]) {
    const parsed = new URL(url); // the same URL parser as Chrome's
    assert.equal(parsed.host, host);
    assert.equal(decodeURIComponent(parsed.password), pass);
    assert.equal(url, `https://admin:${encodeURIComponent(pass)}@${host}`);
  }
});

test("passwords are hidden wherever a URL is shown", () => {
  assert.equal(displayUrl("https://admin:p%40ss@grafana.example.com/d"), "admin:••••@grafana.example.com/d");
  assert.equal(displayUrl("https://token@host/x"), "token@host/x");
  assert.equal(displayUrl("http://u:p@localhost:8080"), "http://u:••••@localhost:8080");
  assert.equal(displayUrl("https://host/users/@me"), "host/users/@me");
  assert.equal(hasCredentials("https://u:p@h"), true);
  assert.equal(hasCredentials("https://h/@me"), false);
  const cfg = normalizeConfig({ environments: [{ name: "DEV", variables: { P: "secret" } }], links: [{ key: "k", template: "me:{{P}}@k.io" }] });
  assert.doesNotMatch(describe(search("k", cfg)[0]), /secret/);
});

// ---- Environments in the search ---------------------------------------------------------------

test("words can come in any order: link names first, environments second", () => {
  const found = (q, cfg = config) => search(q, cfg).map((r) => `${r.link.key}@${r.env.name}`);
  // Only an environment: every link there.
  assert.deepEqual(found("prod"), ["backoffice@PRODUCTION"]);
  assert.deepEqual(found("payments live", GROUPS), ["backoffice@LIVE", "wallet@LIVE"]);
  // The environment first, then the link.
  assert.deepEqual(found("stag backoffice"), ["backoffice@STAGING"]);
  assert.deepEqual(found("stag backoffice /users").length, 1);
  // A word that names a link and an environment: the link's matches, then the environment's.
  const both = normalizeConfig({ ...EXAMPLE, links: [...EXAMPLE.links, { key: "devtools", template: "tools.{{DOMAIN}}" }] });
  assert.deepEqual(found("dev", both), [
    "devtools@DEV", "devtools@STAGING", "devtools@PREPROD", "devtools@PRODUCTION", "backoffice@DEV",
  ]);
  assert.deepEqual(found("nope"), []); // names nothing at all
});

test("a link name and an environment narrow to that link there, however the environment is written", () => {
  const envs = (names) => names.map((n, i) => ({ id: `e${i}`, name: n, variables: { E: n.toLowerCase() } }));
  const found = (q, names) => search(q, normalizeConfig({
    environments: envs(names), links: [{ key: "backoffice", template: "bo.{{E}}.io" }, { key: "grafana", template: "g.{{E}}.io" }],
  })).map((r) => `${r.link.key}@${r.env.name}`);
  assert.deepEqual(found("backoffice preprod", ["DEV", "PREPROD", "PRODUCTION"]), ["backoffice@PREPROD"]);
  assert.deepEqual(found("backoffice preprod", ["Dev", "Pre-Prod", "Prod"]), ["backoffice@Pre-Prod"]);
  assert.deepEqual(found("backoffice preprod", ["EU DEV", "EU PREPROD", "EU PROD"]), ["backoffice@EU PREPROD"]);
  assert.deepEqual(found("preprod backoffice", ["Dev", "Pre Prod", "Prod"]), ["backoffice@Pre Prod"]);
  // A whole name wins over the start of a word: "prod" is Prod, not Pre-Prod as well.
  assert.deepEqual(found("backoffice prod", ["Dev", "Pre-Prod", "Prod"]), ["backoffice@Prod"]);
  // Without one, the start of any word: "prod" finds PRODUCTION but not PREPROD.
  assert.deepEqual(found("backoffice prod", ["DEV", "PREPROD", "PRODUCTION"]), ["backoffice@PRODUCTION"]);
});

test("several words can match one link name, and the rest narrow it", () => {
  const cfg = normalizeConfig({ ...EXAMPLE, links: [
    { key: "api", template: "api.{{DOMAIN}}" },
    { key: "api-docs", template: "docs.{{DOMAIN}}" },
    { key: "Back Office", template: "bo.{{DOMAIN}}" },
  ] });
  const found = (q) => search(q, cfg).map((r) => `${r.link.key}@${r.env.name}`);
  assert.deepEqual(found("api doc"), ["api-docs@DEV", "api-docs@STAGING", "api-docs@PREPROD", "api-docs@PRODUCTION"]);
  assert.deepEqual(found("doc api prod"), ["api-docs@PRODUCTION"]);
  assert.deepEqual(found("back off stag"), ["Back Office@STAGING"]);
  assert.deepEqual(found("office back"), found("back office"));
  // "api" alone: the exact name first, then the one it starts.
  assert.deepEqual([...new Set(found("api").map((r) => r.split("@")[0]))], ["api", "api-docs"]);
  // The link matching more of the words comes first.
  assert.equal(found("api docs")[0], "api-docs@DEV");
  assert.deepEqual(found("api nope"), []); // "nope" is in no name and names no environment
});

// ---- Sync problems ---------------------------------------------------------------------------

import { syncProblems, describeSyncProblems, timeAgo } from "../src/core.js";

test("failed syncs are listed with the group each source feeds", () => {
  const [pay, any] = GROUPS.sources;
  const cache = { [pay.id]: { data: null, error: "GitHub says 404" }, [any.id]: { data: {}, error: null } };
  const problems = syncProblems(GROUPS, cache);
  assert.deepEqual(problems.map((p) => [p.source.repo, p.group.id, p.error]), [["acme/pay", "payments", "GitHub says 404"]]);
  assert.equal(describeSyncProblems(problems), "Shared links from acme/pay didn't sync: GitHub says 404");
  assert.deepEqual(syncProblems(GROUPS, {}), []); // never synced isn't an error
});

test("a failed sync says when the file last synced", () => {
  const now = Date.UTC(2026, 9, 23, 12);
  const [pay] = GROUPS.sources;
  const problems = syncProblems(GROUPS, { [pay.id]: { data: {}, error: "Offline", okAt: now - 3 * 3600e3 } });
  assert.equal(describeSyncProblems(problems, now), "Shared links from acme/pay didn't sync: Offline It last synced 3 h ago.");
  assert.equal(timeAgo(now - 20e3, now), "just now");
  assert.equal(timeAgo(now - 5 * 60e3, now), "5 min ago");
  assert.match(timeAgo(now - 3 * 86400e3, now), /^on /);
});
