import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, normalizeConfig, search, describe, render, parseQuery } from "../src/core.js";

const config = normalizeConfig(DEFAULT_CONFIG);
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
    ...DEFAULT_CONFIG,
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
