import { test } from "node:test";
import assert from "node:assert/strict";
import { bump, normalize } from "../scripts/bump-version.js";

test("bumps patch, minor and major", () => {
  assert.equal(bump("1.1.0", "patch"), "1.1.1");
  assert.equal(bump("1.1.7", "minor"), "1.2.0");
  assert.equal(bump("1.4.2", "major"), "2.0.0");
  assert.equal(bump("1.1", "patch"), "1.1.1"); // Chrome-style short versions are padded
});

test("accepts an explicit higher version only", () => {
  assert.equal(bump("1.1.0", "1.3.0"), "1.3.0");
  assert.throws(() => bump("1.1.0", "1.1.0"), /isn't higher/);
  assert.throws(() => bump("1.1.0", "1.0.9"), /isn't higher/);
});

test("rejects versions Chrome can't use", () => {
  assert.throws(() => bump("1.1.0", "1.2.0-beta"), /isn't a version/);
  assert.throws(() => normalize("01.2.3"), /isn't a version/);
  assert.throws(() => bump("1.1.0", "minorr"), /isn't a version/);
});
