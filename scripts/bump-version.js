// Usage: npm run bump -- <patch|minor|major|x.y.z>
//
// Bumps the version in manifest.json and package.json together, using semantic
// versioning. Chrome only accepts plain numbers in the manifest, so pre-release
// suffixes such as 1.2.0-beta aren't allowed. It doesn't commit or tag anything.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** "1.1" and "1.1.0" are the same version; Chrome allows both, semver wants three parts. */
export function normalize(version) {
  const parts = String(version).split(".");
  while (parts.length < 3) parts.push("0");
  const full = parts.join(".");
  if (!SEMVER.test(full)) throw new Error(`"${version}" isn't a version like 1.2.3`);
  return full;
}

const compare = (a, b) => {
  const [x, y] = [a, b].map((v) => normalize(v).split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** The next version after `current`: patch, minor, major, or an explicit higher x.y.z. */
export function bump(current, part) {
  const [major, minor, patch] = normalize(current).split(".").map(Number);
  if (part === "patch") return `${major}.${minor}.${patch + 1}`;
  if (part === "minor") return `${major}.${minor + 1}.0`;
  if (part === "major") return `${major + 1}.0.0`;
  const next = normalize(part);
  if (compare(next, current) <= 0) {
    throw new Error(`${next} isn't higher than ${normalize(current)}. The Chrome Web Store only accepts higher versions.`);
  }
  return next;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const part = process.argv[2];
  if (!part) {
    console.error("Usage: npm run bump -- <patch|minor|major|x.y.z>");
    process.exit(1);
  }
  const root = new URL("../", import.meta.url);
  const files = ["manifest.json", "package.json"].map((name) => ({ name, url: new URL(name, root) }));
  const docs = files.map((f) => ({ ...f, json: JSON.parse(readFileSync(f.url, "utf8")) }));
  const current = docs[0].json.version;
  try {
    const next = bump(current, part);
    for (const doc of docs) {
      doc.json.version = next;
      writeFileSync(doc.url, JSON.stringify(doc.json, null, 2) + "\n");
    }
    console.log(`Version ${normalize(current)} → ${next} (manifest.json, package.json)`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
