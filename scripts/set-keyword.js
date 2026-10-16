// Usage: npm run keyword -- <shortcut>
// Chrome reads the address-bar keyword from manifest.json only, so it is changed here
// and the extension reloaded, rather than from the settings page.
import { readFileSync, writeFileSync } from "node:fs";

const keyword = process.argv[2]?.trim();
if (!keyword || /\s/.test(keyword)) {
  console.error("Usage: npm run keyword -- <shortcut>   (one word, no spaces)");
  process.exit(1);
}

const path = new URL("../manifest.json", import.meta.url);
const manifest = JSON.parse(readFileSync(path, "utf8"));
const previous = manifest.omnibox.keyword;
manifest.omnibox.keyword = keyword;
writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");

console.log(`Shortcut changed from "${previous}" to "${keyword}".`);
console.log("Reload the extension in chrome://extensions to apply it.");
