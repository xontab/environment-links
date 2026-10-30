import {
  DEFAULT_CONFIG, normalizeConfig, search, displayUrl, hasCredentials, syncProblems, describeSyncProblems, mergeSameUrl,
  syncSeverity,
} from "./core.js";
import { loadEffectiveConfig, loadCache, syncSource } from "./shared.js";
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
  const hasLinks = config.groups.some((g) => g.links.length);
  const [title, hint] = !hasLinks
    ? ["No links yet", "Add your first link in Settings."]
    : ["No matching links", "Try another name, or check the environment you typed."];
  return el("li", { className: "empty-state" },
    icon,
    el("strong", {}, title),
    query && hasLinks ? el("span", { className: "query" }, `Nothing matches “${query}”`) : "",
    el("span", { className: "hint" }, hint)
  );
}

/** Plain click follows the "open in" setting; Cmd/Ctrl/middle-click opens in the background, Shift in a new tab. */
async function open(url, event, env, group) {
  let target = config.openIn;
  if (event?.metaKey || event?.ctrlKey || event?.button === 1) target = "newBackgroundTab";
  else if (event?.shiftKey) target = "newForegroundTab";

  // Wait for the tab (and its group) before closing: closing the popup stops this script.
  await openLink(url, target, env, config, group);
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
  const envs = node.closest(".envs");
  if (envs) keepInView(envs, node);
}

// ---- A link's environments: one row that scrolls sideways ----

const EDGE = 28; // the faded strip at a side with more environments, kept clear of the selection

/** Fade the sides that have more environments past them. */
function markEdges(envs) {
  const max = envs.scrollWidth - envs.clientWidth;
  for (const node of [envs, envs.parentElement]) { // the wrapper shows the arrows
    node.classList.toggle("more-left", envs.scrollLeft > 1);
    node.classList.toggle("more-right", envs.scrollLeft < max - 1);
  }
}

/** Scroll the row so the chosen environment isn't hidden under a faded edge. */
function keepInView(envs, chip) {
  const left = chip.offsetLeft - envs.offsetLeft;
  const right = left + chip.offsetWidth;
  if (left - EDGE < envs.scrollLeft) envs.scrollLeft = Math.max(0, left - EDGE);
  else if (right + EDGE > envs.scrollLeft + envs.clientWidth) envs.scrollLeft = right + EDGE - envs.clientWidth;
  markEdges(envs);
}

const HOVER_SPEED = 5; // pixels per tick while the pointer rests on a faded edge

function envsRow(chips) {
  const envs = el("div", { className: "envs" }, ...chips);
  const wrap = el("div", { className: "envs-wrap" },
    envs, el("span", { className: "edge-arrow left", ariaHidden: "true" }, "‹"),
    el("span", { className: "edge-arrow right", ariaHidden: "true" }, "›"));

  // Resting the pointer on a faded edge scrolls that way until the end, or until it moves off.
  let direction = 0;
  let timer = null;
  const hover = (dir) => {
    direction = dir;
    if (!dir) { clearInterval(timer); timer = null; return; }
    timer ??= setInterval(() => {
      const before = envs.scrollLeft;
      envs.scrollLeft += direction * HOVER_SPEED;
      markEdges(envs);
      if (envs.scrollLeft === before) hover(0); // reached the end
    }, 16);
  };
  envs.addEventListener("mousemove", (e) => {
    const { left, right } = envs.getBoundingClientRect();
    const more = (side) => envs.classList.contains(`more-${side}`);
    hover(e.clientX < left + EDGE && more("left") ? -1 : e.clientX > right - EDGE && more("right") ? 1 : 0);
  });
  envs.addEventListener("mouseleave", () => hover(0));
  envs.addEventListener("scroll", () => markEdges(envs), { passive: true });
  // A mouse wheel scrolls the row sideways while it can; at either end the list scrolls as usual.
  // Trackpads scroll it sideways by themselves.
  envs.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    const max = envs.scrollWidth - envs.clientWidth;
    const next = Math.max(0, Math.min(max, envs.scrollLeft + e.deltaY));
    if (next === envs.scrollLeft) return;
    e.preventDefault();
    envs.scrollLeft = next;
    markEdges(envs);
  }, { passive: false });
  return wrap;
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
  if (problems.length) list.append(syncBanner());
  if (!byLink.size) {
    list.append(emptyState(filter.value.trim()));
  }

  // With several groups, each group's links get a heading; the list is in search order otherwise.
  const showGroups = new Set(results.map((r) => r.group)).size > 1;
  const ordered = showGroups
    ? config.groups.flatMap((g) => [...byLink].filter(([, envs]) => envs[0].group.id === g.id))
    : [...byLink];
  let lastGroup = null;

  for (const [link, envs] of ordered) {
    if (showGroups && envs[0].group !== lastGroup) {
      lastGroup = envs[0].group;
      list.append(el("li", { className: "group-heading" }, lastGroup.name));
    }
    // Environments that open the same URL share a button ("DEV | STAGE"), like in the address bar.
    const chips = mergeSameUrl(envs).map((r) =>
      item(
        el("a", {
          href: hasCredentials(r.url) ? "#" : r.url, // clicks open it; an href would show the password on hover
          title: r.missing.length ? `${displayUrl(r.url)}\nMissing: ${r.missing.join(", ")}` : displayUrl(r.url),
          className: r.missing.length ? "warn" : "",
        }, r.env.name),
        (e) => open(r.url, e, r.envs[0], r.group), // a shared button groups its tab under the first
        r.url
      )
    );
    rows.push(chips);
    list.append(
      el("li", {},
        el("div", { className: "link-name" }, el("span", { className: "key" }, link.key, link.source ? el("span", { className: "tag", title: `Shared from ${link.source}` }, "shared") : ""), el("small", { title: link.template }, link.template)),
        envsRow(chips.map((c) => c.node)),
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

  list.querySelectorAll(".envs").forEach(markEdges); // now that they're laid out
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

// ---- Shared links that didn't sync ----

let problems = [];

/**
 * A red "!" banner at the top of the list, like the badge on the toolbar icon. Clicking it opens
 * the settings at the file that didn't sync. It's outside the arrow-key rows, so Enter still
 * opens the first link.
 */
function syncBanner() {
  const [first] = problems;
  // Orange when every failure is likely to clear up by itself, like the toolbar icon's badge.
  const temporary = syncSeverity(problems) === "warning";
  const failed = temporary ? "couldn't sync just now" : "didn't sync";
  const text = problems.length === 1
    ? `Shared links from ${first.source.repo} ${failed}.`
    : `${problems.length} Shared links files ${failed}.`;
  // A failure likely to clear up by itself (like no network) can be retried right here.
  const retry = problems.some((p) => p.temporary)
    ? el("button", { type: "button", className: "retry", title: "Try syncing again now" }, "Retry")
    : null;
  retry?.addEventListener("click", (e) => {
    e.stopPropagation(); // not the banner's own click, which opens the settings
    retrySync(retry);
  });
  const banner = el("li", { className: `sync-problem${temporary ? " temporary" : ""}`, title: describeSyncProblems(problems) },
    el("span", { className: "bang", ariaHidden: "true" }, "!"),
    el("span", { className: "text" }, text), // shortened with "…" if need be; Retry and Show stay in view
    ...(retry ? [retry] : []),
    el("a", { href: "#", className: "fix" }, "Show"));
  banner.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("src/options.html#sync-problem") });
    window.close();
  });
  return banner;
}

/** Sync the files that failed, then show the list again: without the note if they all worked. */
async function retrySync(button) {
  button.disabled = true;
  button.textContent = "Retrying…";
  for (const { source } of problems) await syncSource(source);
  const [effective, cache] = await Promise.all([loadEffectiveConfig(), loadCache()]);
  config = effective; // the files that synced may have new links
  problems = syncProblems(config, cache);
  render();
}

// "Open this list with ⌘⇧E", when a shortcut is set, so people discover it.
let shortcutHint = "";

(async () => {
  try {
    const commands = await chrome.commands.getAll();
    const shortcut = commands.find((c) => c.name === "_execute_action")?.shortcut;
    if (shortcut) shortcutHint = `Open this list with ${shortcut}`;
  } catch {}
  const [effective, cache] = await Promise.all([loadEffectiveConfig(), loadCache()]);
  config = effective;
  problems = syncProblems(config, cache);
  render();
})();
