import { DEFAULT_CONFIG, normalizeConfig, search, displayUrl } from "./core.js";
import { loadEffectiveConfig } from "./shared.js";
import { openLink } from "./open.js";

const list = document.querySelector("#list");
const filter = document.querySelector("#filter");
let config = normalizeConfig(DEFAULT_CONFIG);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// A magnifying glass with a cross: nothing found. Static markup, so innerHTML is safe here.
const NO_RESULTS_ICON = `<svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true" fill="none"
  stroke="currentColor" stroke-width="3" stroke-linecap="round">
  <circle cx="21" cy="21" r="13"/><path d="M31 31l10 10"/><path d="M16 16l10 10M26 16 16 26"/></svg>`;

function emptyState(query) {
  const icon = el("span", { className: "empty-icon" });
  icon.innerHTML = NO_RESULTS_ICON;
  const [title, hint] = !config.links.length
    ? ["No links yet", "Add your first link in Settings."]
    : ["No matching links", "Try another name, or check the environment you typed."];
  return el("li", { className: "empty-state" },
    icon,
    el("strong", {}, title),
    query && config.links.length ? el("span", { className: "query" }, `Nothing matches “${query}”`) : "",
    el("span", { className: "hint" }, hint)
  );
}

/** Plain click follows the "open in" setting; Cmd/Ctrl/middle-click opens in the background, Shift in a new tab. */
async function open(url, event, env) {
  let target = config.openIn;
  if (event?.metaKey || event?.ctrlKey || event?.button === 1) target = "newBackgroundTab";
  else if (event?.shiftKey) target = "newForegroundTab";

  // Wait for the tab (and its group) before closing: closing the popup stops this script.
  await openLink(url, target, env, config);
  if (target !== "newBackgroundTab") window.close();
}

// Keyboard selection: rows are links (plus Settings last), columns are environments.
// Focus stays in the filter box so typing keeps filtering while the arrows move the selection.
let rows = [];
let sel = { row: 0, col: 0 };
let wantCol = 0; // the environment column to return to after passing a shorter row, e.g. Settings

function item(node, activate, url = "") {
  node.addEventListener("click", (e) => { e.preventDefault(); activate(e); });
  node.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); activate(e); } });
  return { node, activate, url };
}

function select(row, col) {
  if (!rows.length) return;
  sel.row = Math.max(0, Math.min(row, rows.length - 1));
  sel.col = Math.max(0, Math.min(col, rows[sel.row].length - 1));
  rows.flat().forEach(({ node }) => node.classList.remove("selected"));
  list.querySelectorAll("li.selected-row").forEach((li) => {
    li.classList.remove("selected-row");
    li.querySelector(".target")?.replaceChildren();
  });
  const { node, url } = rows[sel.row][sel.col];
  node.classList.add("selected");
  // Highlight the whole row and spell out where Enter will go.
  const li = node.closest("li");
  li.classList.add("selected-row");
  if (url) li.querySelector(".target")?.replaceChildren("Enter opens ", el("span", { className: "url" }, displayUrl(url)));
  li.scrollIntoView({ block: "nearest" });
}

function render() {
  const results = search(filter.value, config);
  const byLink = new Map();
  for (const r of results) {
    if (!byLink.has(r.link)) byLink.set(r.link, []);
    byLink.get(r.link).push(r);
  }

  rows = [];
  list.replaceChildren();
  if (!byLink.size) {
    list.append(emptyState(filter.value.trim()));
  }

  for (const [link, envs] of byLink) {
    const chips = envs.map((r) =>
      item(
        el("a", {
          href: r.url,
          title: r.missing.length ? `${displayUrl(r.url)}\nMissing: ${r.missing.join(", ")}` : displayUrl(r.url),
          className: r.missing.length ? "warn" : "",
        }, r.env.name),
        (e) => open(r.url, e, r.env),
        r.url
      )
    );
    rows.push(chips);
    list.append(
      el("li", {},
        el("div", { className: "link-name" }, el("span", { className: "key" }, link.key, link.source ? el("span", { className: "tag", title: `Shared from ${link.source}` }, "shared") : ""), el("small", { title: link.template }, link.template)),
        el("div", { className: "envs" }, ...chips.map((c) => c.node)),
        el("div", { className: "target", "aria-live": "polite" })
      )
    );
  }

  const settings = item(el("a", { href: "#", className: "settings" }, "Settings"), () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
  rows.push([settings]);
  list.append(
    el("li", { className: "settings-row" },
      el("span", { className: "muted" }, shortcutHint || "Edit environments, variables and links"),
      settings.node
    )
  );

  wantCol = 0;
  select(0, 0);
}

filter.addEventListener("input", render);
filter.addEventListener("keydown", (e) => {
  const moves = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] };
  if (e.key in moves) {
    e.preventDefault();
    const [dr, dc] = moves[e.key];
    // Moving between links keeps the same environment column where it exists.
    if (dr) select(sel.row + dr, wantCol);
    else {
      select(sel.row, sel.col + dc);
      wantCol = sel.col;
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    rows[sel.row]?.[sel.col]?.activate(e);
  }
});

// "Open this list with ⌘⇧E", when a shortcut is set, so people discover it.
let shortcutHint = "";

(async () => {
  try {
    const commands = await chrome.commands.getAll();
    const shortcut = commands.find((c) => c.name === "_execute_action")?.shortcut;
    if (shortcut) shortcutHint = `Open this list with ${shortcut}`;
  } catch {}
  config = await loadEffectiveConfig();
  render();
})();
