import { DEFAULT_CONFIG, normalizeConfig, search, displayUrl } from "./core.js";

const STORAGE_KEY = "config";
const list = document.querySelector("#list");
const filter = document.querySelector("#filter");
let config = normalizeConfig(DEFAULT_CONFIG);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** Plain click follows the "open in" setting; Cmd/Ctrl/middle-click opens in the background, Shift in a new tab. */
async function open(url, event) {
  let target = config.openIn;
  if (event?.metaKey || event?.ctrlKey || event?.button === 1) target = "newBackgroundTab";
  else if (event?.shiftKey) target = "newForegroundTab";

  if (target === "currentTab") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.update(tab.id, { url });
  } else {
    await chrome.tabs.create({ url, active: target === "newForegroundTab" });
  }
  if (target !== "newBackgroundTab") window.close();
}

// Keyboard selection: rows are links (plus Settings last), columns are environments.
// Focus stays in the filter box so typing keeps filtering while the arrows move the selection.
let rows = [];
let sel = { row: 0, col: 0 };
let wantCol = 0; // the environment column to return to after passing a shorter row, e.g. Settings

function item(node, activate) {
  node.addEventListener("click", (e) => { e.preventDefault(); activate(e); });
  node.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); activate(e); } });
  return { node, activate };
}

function select(row, col) {
  if (!rows.length) return;
  sel.row = Math.max(0, Math.min(row, rows.length - 1));
  sel.col = Math.max(0, Math.min(col, rows[sel.row].length - 1));
  rows.flat().forEach(({ node }) => node.classList.remove("selected"));
  const { node } = rows[sel.row][sel.col];
  node.classList.add("selected");
  node.scrollIntoView({ block: "nearest" });
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
    list.append(el("li", { className: "empty" }, config.links.length ? "No matching links." : "No links yet. Add some in settings."));
  }

  for (const [link, envs] of byLink) {
    const chips = envs.map((r) =>
      item(
        el("a", {
          href: r.url,
          title: r.missing.length ? `${displayUrl(r.url)}\nMissing: ${r.missing.join(", ")}` : displayUrl(r.url),
          className: r.missing.length ? "warn" : "",
        }, r.env.name),
        (e) => open(r.url, e)
      )
    );
    rows.push(chips);
    list.append(
      el("li", {},
        el("div", { className: "link-name" }, el("span", { className: "key" }, link.key), el("small", { title: link.template }, link.template)),
        el("div", { className: "envs" }, ...chips.map((c) => c.node))
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
      el("span", { className: "muted" }, "Edit environments, variables and links"),
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

(async () => {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  config = normalizeConfig(stored[STORAGE_KEY] || DEFAULT_CONFIG);
  render();
})();
