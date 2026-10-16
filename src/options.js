import { DEFAULT_CONFIG, normalizeConfig, expandLink, displayUrl, slug } from "./core.js";

const STORAGE_KEY = "config";
const $ = (sel) => document.querySelector(sel);

let config = normalizeConfig(DEFAULT_CONFIG);
const openLinks = new Set();
let saveTimer;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

function setStatus(text, kind = "") {
  const s = $("#status");
  s.textContent = text;
  s.className = `status ${kind}`;
}

function scheduleSave() {
  setStatus("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await chrome.storage.sync.set({ [STORAGE_KEY]: config });
      setStatus("Saved", "ok");
    } catch (err) {
      setStatus(`Not saved: ${err.message}`, "err");
    }
  }, 300);
}

/** Call after a value edit: saves and refreshes previews without rebuilding inputs (keeps focus). */
function changed() {
  scheduleSave();
  renderPreviews();
}

/** Call after a structural edit (add/remove/rename): rebuilds the UI. */
function restructured() {
  scheduleSave();
  render();
}

function uniqueEnvId(name) {
  const base = slug(name) || "env";
  let id = base;
  for (let i = 2; config.environments.some((e) => e.id === id); i++) id = `${base}-${i}`;
  return id;
}

// ---- Variables grid -------------------------------------------------------

function renderVars() {
  const table = $("#vars");
  table.replaceChildren();
  const iconButton = (title, label, onclick, disabled = false) =>
    el("button", { type: "button", class: "icon", title, "aria-label": title, disabled, onclick }, label);

  // Columns are variables; rows are the Default values, then one row per environment,
  // so the grid grows downwards as environments are added.
  table.append(
    el("thead", {},
      el("tr", {},
        el("th", {}, el("span", { class: "fixed" }, "Environment")),
        ...config.variableNames.map((name, col) =>
          el("th", {},
            el("div", { class: "head-cell" },
              el("input", {
                class: "mono", value: name, "aria-label": "Variable name",
                onchange: (e) => renameVariable(name, e.target.value),
              }),
              iconButton(`Remove ${name}`, "✕", () => {
                config.variableNames.splice(col, 1);
                delete config.globals[name];
                config.environments.forEach((e) => delete e.variables[name]);
                restructured();
              })
            )
          )
        ),
        el("th", { class: "row-actions" })
      )
    )
  );

  const cells = (obj) =>
    config.variableNames.map((name) => {
      const isDefault = obj === config.globals;
      const input = el("input", {
        class: "mono",
        value: obj[name] ?? "",
        "aria-label": name,
        oninput: (e) => {
          if (e.target.value === "") delete obj[name];
          else obj[name] = e.target.value;
          if (isDefault) showDefault(name);
          changed();
        },
      });
      if (!isDefault) input.dataset.inherits = name;
      return el("td", {}, input);
    });

  const body = el("tbody");
  body.append(
    el("tr", { class: "defaults" },
      el("th", {}, el("span", { class: "fixed" }, "Default")),
      ...cells(config.globals),
      el("td", { class: "row-actions" })
    )
  );
  config.environments.forEach((env, i) => {
    body.append(
      el("tr", {},
        el("th", {},
          el("input", {
            value: env.name, "aria-label": "Environment name",
            oninput: (e) => { env.name = e.target.value; changed(); },
          })
        ),
        ...cells(env.variables),
        el("td", { class: "row-actions" },
          el("div", { class: "head-cell" },
            iconButton("Move up", "▲", () => { moveItem(config.environments, i, -1); restructured(); }, i === 0),
            iconButton("Move down", "▼", () => { moveItem(config.environments, i, 1); restructured(); },
              i === config.environments.length - 1),
            iconButton(`Remove ${env.name}`, "✕", () => {
              if (!confirm(`Remove environment "${env.name}"?`)) return;
              config.environments.splice(i, 1);
              config.links.forEach((l) => delete l.overrides[env.id]);
              restructured();
            })
          )
        )
      )
    );
  });
  table.append(body);
  config.variableNames.forEach(showDefault);
}

/** Environment cells left blank show the Default value they will use, as a placeholder. */
function showDefault(name) {
  const value = config.globals[name] ?? "";
  document.querySelectorAll("#vars input[data-inherits]").forEach((input) => {
    if (input.dataset.inherits !== name) return;
    input.placeholder = value;
    input.title = value ? `Blank, so it uses the default: ${value}` : "";
  });
}

function renameVariable(from, rawTo) {
  const to = rawTo.trim().replace(/[^A-Za-z0-9_]/g, "_");
  if (!to || to === from) return render();
  if (config.variableNames.includes(to)) {
    alert(`A variable called ${to} already exists.`);
    return render();
  }
  const move = (obj) => {
    if (from in obj) { obj[to] = obj[from]; delete obj[from]; }
  };
  config.variableNames[config.variableNames.indexOf(from)] = to;
  move(config.globals);
  config.environments.forEach((e) => move(e.variables));
  restructured();
}

function moveItem(list, index, delta) {
  const [item] = list.splice(index, 1);
  list.splice(index + delta, 0, item);
}

// ---- Links ----------------------------------------------------------------

function renderLinks() {
  const root = $("#links");
  root.replaceChildren();
  if (!config.links.length) root.append(el("p", { class: "empty" }, "No links yet."));

  config.links.forEach((link, i) => {
    const isOpen = openLinks.has(link);
    const details = el("div", { class: "link-details" },
      ...config.environments.map((env) =>
        el("div", { class: "env-row" },
          el("span", { class: "name" }, env.name),
          el("input", {
            class: "mono",
            value: link.overrides[env.id] ?? "",
            placeholder: "Uses the template above. Type a URL to override for this environment.",
            "aria-label": `Override for ${env.name}`,
            oninput: (e) => {
              if (e.target.value.trim()) link.overrides[env.id] = e.target.value;
              else delete link.overrides[env.id];
              changed();
            },
          }),
          el("div", { class: "preview", "data-link": i, "data-env": env.id })
        )
      )
    );

    const toggle = el("button", {
      type: "button", class: "toggle", title: "Preview and overrides",
      "aria-expanded": String(isOpen),
      onclick: () => {
        if (openLinks.has(link)) openLinks.delete(link); else openLinks.add(link);
        renderLinks();
      },
    }, isOpen ? "▾" : "▸");

    root.append(
      el("div", { class: `link${isOpen ? " open" : ""}` },
        el("div", { class: "link-row" },
          toggle,
          el("input", {
            value: link.key, placeholder: "name, e.g. backoffice", "aria-label": "Link name",
            oninput: (e) => { link.key = e.target.value.trim(); changed(); },
          }),
          el("input", {
            class: "mono template", value: link.template,
            placeholder: "backoffice.{{ENVIRONMENT}}.{{DOMAIN}}", "aria-label": "URL template",
            oninput: (e) => { link.template = e.target.value; changed(); },
          }),
          el("button", { type: "button", class: "icon", title: "Remove link",
            onclick: () => {
              if (!confirm(`Remove link "${link.key || "untitled"}"?`)) return;
              config.links.splice(i, 1);
              restructured();
            } }, "✕")
        ),
        details
      )
    );
  });
  renderPreviews();
}

function renderPreviews() {
  document.querySelectorAll(".preview").forEach((node) => {
    const link = config.links[Number(node.dataset.link)];
    const result = link && expandLink(link, config).find((r) => r.env.id === node.dataset.env);
    if (!result) return node.replaceChildren();
    const children = [
      result.url
        ? el("a", { href: result.url, target: "_blank", rel: "noreferrer" }, displayUrl(result.url))
        : el("span", {}, "(empty)"),
    ];
    if (result.missing.length) {
      children.push(el("span", { class: "warn" }, `  missing: ${result.missing.join(", ")}`));
    }
    node.replaceChildren(...children);
  });
}

// ---- Wiring ---------------------------------------------------------------

function render() {
  const keyword = chrome.runtime.getManifest().omnibox?.keyword ?? "";
  document.querySelectorAll(".keyword").forEach((k) => (k.textContent = keyword));
  renderVars();
  renderLinks();
  $("#open-in").value = config.openIn;
}

$("#add-var").addEventListener("click", () => {
  let n = 1;
  while (config.variableNames.includes(`VAR_${n}`)) n++;
  config.variableNames.push(`VAR_${n}`);
  restructured();
});

$("#add-env").addEventListener("click", () => {
  const name = `ENV ${config.environments.length + 1}`;
  config.environments.push({ id: uniqueEnvId(name), name, variables: {} });
  restructured();
});

$("#add-link").addEventListener("click", () => {
  const link = { key: "", template: "", overrides: {} };
  config.links.push(link);
  restructured();
  const inputs = document.querySelectorAll(".link-row input:first-of-type");
  inputs[inputs.length - 1]?.focus();
});

$("#open-in").addEventListener("change", (e) => { config.openIn = e.target.value; scheduleSave(); });

$("#export").addEventListener("click", () => {
  $("#json").value = JSON.stringify(config, null, 2);
});

$("#copy").addEventListener("click", async () => {
  if (!$("#json").value) $("#json").value = JSON.stringify(config, null, 2);
  await navigator.clipboard.writeText($("#json").value);
  setStatus("Copied to clipboard", "ok");
});

$("#import").addEventListener("click", () => {
  try {
    const parsed = JSON.parse($("#json").value);
    if (!confirm("Replace your current environments, variables and links with this JSON?")) return;
    config = normalizeConfig(parsed);
    openLinks.clear();
    restructured();
  } catch (err) {
    setStatus(`Import failed: ${err.message}`, "err");
  }
});

$("#reset").addEventListener("click", () => {
  if (!confirm("Replace everything with the example configuration?")) return;
  config = normalizeConfig(structuredClone(DEFAULT_CONFIG));
  openLinks.clear();
  restructured();
});

// Keep in sync if settings change in another tab or on another synced device.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes[STORAGE_KEY]) return;
  const incoming = normalizeConfig(changes[STORAGE_KEY].newValue);
  if (JSON.stringify(incoming) === JSON.stringify(config)) return; // our own save
  if (document.activeElement?.matches("input, textarea, select")) return;
  config = incoming;
  render();
});

(async () => {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  config = normalizeConfig(stored[STORAGE_KEY] || structuredClone(DEFAULT_CONFIG));
  if (!stored[STORAGE_KEY]) await chrome.storage.sync.set({ [STORAGE_KEY]: config });
  render();
})();
