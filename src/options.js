import {
  DEFAULT_CONFIG, DEFAULT_SHARED_PATH, normalizeConfig, normalizeSource, expandLink, displayUrl, slug,
  resolveConfig, parseGitHubLocation, buildSharedFile,
} from "./core.js";
import {
  CONFIG_KEY, GITHUB_PERMISSION, loadCache, layersFor, loadTokens, setToken, syncSource, forgetRemovedSources,
} from "./shared.js";

const $ = (sel) => document.querySelector(sel);

// `config` is the user's own settings (what gets saved). `effective` adds the shared files on
// top for display; it is recomputed from config + cache and never saved.
let config = normalizeConfig(DEFAULT_CONFIG);
let cache = {};
let tokens = {};
let effective = resolveConfig(config);
const openLinks = new Set();
const syncing = new Set();
let saveTimer;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
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

function recompute() {
  effective = resolveConfig(config, layersFor(config, cache));
}

async function saveNow() {
  clearTimeout(saveTimer);
  try {
    await chrome.storage.sync.set({ [CONFIG_KEY]: config });
    setStatus("Saved", "ok");
  } catch (err) {
    setStatus(`Not saved: ${err.message}`, "err");
  }
}

function scheduleSave() {
  setStatus("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

/** Call after a value edit: saves and refreshes previews without rebuilding inputs (keeps focus). */
function changed() {
  scheduleSave();
  recompute();
  renderPreviews();
  refreshPlaceholders();
}

/** Call after a structural edit (add/remove/rename): rebuilds the UI. */
function restructured() {
  scheduleSave();
  render();
}

function uniqueEnvId(name) {
  const base = slug(name) || "env";
  const taken = new Set(effective.environments.map((e) => e.id));
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

const iconButton = (title, label, onclick, disabled = false) =>
  el("button", { type: "button", class: "icon", title, "aria-label": title, disabled, onclick }, label);

const sharedTag = (source) => el("span", { class: "tag", title: `From ${source}` }, "shared");

function sharedVariableNames() {
  return new Set(layersFor(config, cache).flatMap(({ data }) => data?.variableNames || []));
}

function sharedEnvironmentIds() {
  return new Set(layersFor(config, cache).flatMap(({ data }) => (data?.environments || []).map((e) => e.id)));
}

/** The user's own entry for an environment, created on first edit for one that only comes from a shared file. */
function ownEnvironment(env, create) {
  let own = config.environments.find((e) => e.id === env.id);
  if (!own && create) {
    own = { id: env.id, name: env.name, variables: {} };
    config.environments.push(own);
  }
  return own;
}

// ---- Variables grid -------------------------------------------------------

function renderVars() {
  const table = $("#vars");
  table.replaceChildren();
  const ownNames = new Set(config.variableNames);
  const sharedNames = sharedVariableNames();
  const sharedIds = sharedEnvironmentIds();
  const hasOwnValues = (name) =>
    name in config.globals || config.environments.some((e) => name in e.variables);

  // Columns are variables; rows are the Default values, then one row per environment,
  // so the grid grows downwards as environments are added.
  table.append(
    el("thead", {},
      el("tr", {},
        el("th", {}, el("span", { class: "fixed" }, "Environment")),
        ...effective.variableNames.map((name) => {
          const shared = sharedNames.has(name);
          return el("th", {},
            el("div", { class: "head-cell" },
              el("input", {
                class: "mono", value: name, "aria-label": "Variable name", readOnly: shared,
                title: shared ? "Defined in a shared file, so it can't be renamed here" : "",
                onchange: (e) => renameVariable(name, e.target.value),
              }),
              shared ? sharedTag("a shared file") : null,
              iconButton(
                shared ? `Clear your values for ${name}` : `Remove ${name}`, "✕",
                () => {
                  const i = config.variableNames.indexOf(name);
                  if (i >= 0) config.variableNames.splice(i, 1);
                  delete config.globals[name];
                  config.environments.forEach((e) => delete e.variables[name]);
                  restructured();
                },
                shared ? !hasOwnValues(name) : !ownNames.has(name)
              )
            )
          );
        }),
        el("th", { class: "row-actions" })
      )
    )
  );

  const cell = (name, value, onvalue, dataset) =>
    el("td", {},
      el("input", {
        class: "mono", value: value ?? "", "aria-label": name, dataset,
        oninput: (e) => { onvalue(e.target.value); changed(); },
      })
    );
  const assign = (obj, name, value) => {
    if (value === "") delete obj[name];
    else obj[name] = value;
  };

  const body = el("tbody");
  body.append(
    el("tr", { class: "defaults" },
      el("th", {}, el("span", { class: "fixed" }, "Default")),
      ...effective.variableNames.map((name) =>
        cell(name, config.globals[name], (v) => assign(config.globals, name, v), { var: name, default: "1" })
      ),
      el("td", { class: "row-actions" })
    )
  );

  const last = effective.environments.length - 1;
  effective.environments.forEach((env, pos) => {
    const own = ownEnvironment(env, false);
    const i = own ? config.environments.indexOf(own) : -1;
    const shared = sharedIds.has(env.id);
    body.append(
      el("tr", {},
        el("th", {},
          el("div", { class: "head-cell" },
            el("input", {
              value: own?.name ?? env.name, "aria-label": "Environment name",
              oninput: (e) => { ownEnvironment(env, true).name = e.target.value; changed(); },
            }),
            shared ? sharedTag(env.source || "a shared file") : null
          )
        ),
        ...effective.variableNames.map((name) =>
          cell(name, own?.variables[name], (v) => assign(ownEnvironment(env, true).variables, name, v),
            { var: name, env: env.id })
        ),
        el("td", { class: "row-actions" },
          el("div", { class: "head-cell" },
            iconButton("Move up", "▲", () => moveEnvironment(pos, -1), pos === 0),
            iconButton("Move down", "▼", () => moveEnvironment(pos, 1), pos === last),
            shared
              ? iconButton(`Clear your values for ${env.name}`, "✕", () => {
                  config.environments.splice(i, 1);
                  restructured();
                }, !own)
              : iconButton(`Remove ${env.name}`, "✕", () => {
                  if (!confirm(`Remove environment "${env.name}"?`)) return;
                  config.environments.splice(i, 1);
                  config.environmentOrder = config.environmentOrder.filter((id) => id !== env.id);
                  config.links.forEach((l) => delete l.overrides[env.id]);
                  restructured();
                })
          )
        )
      )
    );
  });
  table.append(body);
  refreshPlaceholders();
}

/** Blank cells show, as a placeholder, the value they get from Default or a shared file. */
function refreshPlaceholders() {
  document.querySelectorAll("#vars input[data-var]").forEach((input) => {
    const { var: name, env: envId } = input.dataset;
    const value = input.dataset.default
      ? effective.sharedGlobals[name]
      : effective.environments.find((e) => e.id === envId)?.inherited[name];
    input.placeholder = value ?? "";
    input.title = value != null && value !== ""
      ? `Blank, so it uses ${input.dataset.default ? "the shared default" : "the default"}: ${value}`
      : "";
  });
}

function renameVariable(from, rawTo) {
  const to = rawTo.trim().replace(/[^A-Za-z0-9_]/g, "_");
  if (!to || to === from) return render();
  if (effective.variableNames.includes(to)) {
    alert(`A variable called ${to} already exists.`);
    return render();
  }
  const move = (obj) => {
    if (from in obj) { obj[to] = obj[from]; delete obj[from]; }
  };
  const i = config.variableNames.indexOf(from);
  if (i >= 0) config.variableNames[i] = to;
  else config.variableNames.push(to);
  move(config.globals);
  config.environments.forEach((e) => move(e.variables));
  restructured();
}

/** Reorder any environment, own or shared, by saving the full order of the list as shown. */
function moveEnvironment(pos, delta) {
  const ids = effective.environments.map((e) => e.id);
  moveItem(ids, pos, delta);
  config.environmentOrder = ids;
  restructured();
}

function moveItem(list, index, delta) {
  const [item] = list.splice(index, 1);
  list.splice(index + delta, 0, item);
}

// ---- Links ----------------------------------------------------------------

function previewRow(env, ref, input) {
  return el("div", { class: "env-row" },
    el("span", { class: "name" }, env.name),
    input,
    el("div", { class: "preview", dataset: { link: ref, env: env.id } })
  );
}

// A chevron that points right when closed; CSS rotates it down when the row is open.
const CHEVRON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor"
  stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`;

function toggleButton(key) {
  const isOpen = openLinks.has(key);
  const button = el("button", {
    type: "button", class: "toggle", "aria-expanded": String(isOpen),
    title: isOpen ? "Hide preview and overrides" : "Show preview and overrides",
    "aria-label": isOpen ? "Hide preview and overrides" : "Show preview and overrides",
    onclick: () => {
      if (openLinks.has(key)) openLinks.delete(key); else openLinks.add(key);
      renderLinks();
    },
  });
  button.innerHTML = CHEVRON; // static markup
  return button;
}

function renderLinks() {
  const root = $("#links");
  root.replaceChildren();
  if (!config.links.length) root.append(el("p", { class: "empty" }, "No links of your own yet."));

  config.links.forEach((link, i) => {
    const isOpen = openLinks.has(link);
    const shadows = effective.sharedLinks.find((s) => s.shadowed && s.key.toLowerCase() === link.key.toLowerCase());
    root.append(
      el("div", { class: `link${isOpen ? " open" : ""}` },
        el("div", { class: "link-row" },
          toggleButton(link),
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
        el("div", { class: "link-details" },
          shadows ? el("p", { class: "muted" }, `Used instead of the shared "${shadows.key}" link from ${shadows.source}.`) : null,
          ...effective.environments.map((env) =>
            previewRow(env, String(i), el("input", {
              class: "mono",
              value: link.overrides[env.id] ?? "",
              placeholder: "Uses the template above. Type a URL to override for this environment.",
              "aria-label": `Override for ${env.name}`,
              oninput: (e) => {
                if (e.target.value.trim()) link.overrides[env.id] = e.target.value;
                else delete link.overrides[env.id];
                changed();
              },
            }))
          )
        )
      )
    );
  });

  renderSharedLinks();
  renderPreviews();
}

function renderSharedLinks() {
  const root = $("#shared-links");
  root.replaceChildren();
  if (!effective.sharedLinks.length) return;
  root.append(el("h3", {}, "From shared files"));

  effective.sharedLinks.forEach((link, i) => {
    const key = `shared:${link.source}:${link.key}`;
    const isOpen = openLinks.has(key);
    root.append(
      el("div", { class: `link shared${isOpen ? " open" : ""}${link.shadowed ? " shadowed" : ""}` },
        el("div", { class: "link-row" },
          toggleButton(key),
          el("span", { class: "key-text" }, link.key, " ", sharedTag(link.source)),
          el("span", { class: "mono template-text", title: link.template }, link.template),
          el("button", {
            type: "button", title: "Copy into your own links so you can change it",
            disabled: link.shadowed,
            onclick: () => {
              config.links.push({ key: link.key, template: link.template, overrides: { ...link.overrides } });
              restructured();
              setStatus(`Copied "${link.key}". Your copy is now used instead of the shared one.`, "ok");
            },
          }, "Customise")
        ),
        el("div", { class: "link-details" },
          link.shadowed
            ? el("p", { class: "muted" }, "Not used: you have your own link with this name.")
            : null,
          ...effective.environments.map((env) =>
            previewRow(env, `s${i}`, el("span", { class: "mono muted" },
              link.overrides[env.id] ? `Override: ${link.overrides[env.id]}` : "Uses the template"))
          )
        )
      )
    );
  });
}

function renderPreviews() {
  document.querySelectorAll(".preview").forEach((node) => {
    const ref = node.dataset.link;
    const link = ref.startsWith("s") ? effective.sharedLinks[Number(ref.slice(1))] : config.links[Number(ref)];
    const result = link && expandLink(link, effective).find((r) => r.env.id === node.dataset.env);
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

// ---- Shared files from GitHub --------------------------------------------

function timeAgo(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString();
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function fileUrl(source) {
  return `https://github.com/${source.repo}/blob/${source.branch || "HEAD"}/${source.path}`;
}

function sourceStatus(source) {
  if (syncing.has(source.id)) return el("span", { class: "muted" }, "Syncing…");
  const entry = cache[source.id];
  if (!entry) return el("span", { class: "muted" }, "Not synced yet.");
  const summary = entry.data
    ? `${plural(entry.data.links.length, "link")}, ${plural(entry.data.environments.length, "environment")}`
    : "";
  if (entry.error) {
    return el("span", {},
      el("span", { class: "warn" }, entry.error),
      entry.data ? el("span", { class: "muted" }, ` Still using the last copy (${summary}).`) : null
    );
  }
  return el("span", { class: "muted" }, `Synced ${timeAgo(entry.syncedAt)} · ${summary}`);
}

/** Must run straight from a click: Chrome only shows the permission prompt for a user gesture. */
function requestGitHubAccess() {
  return chrome.permissions.request(GITHUB_PERMISSION).catch(() => false);
}

async function runSync(source) {
  syncing.add(source.id);
  renderSources();
  const entry = await syncSource(source);
  syncing.delete(source.id);
  cache = await loadCache();
  render();
  if (entry.error) setStatus(`Sync failed: ${source.repo}`, "err");
  else setStatus(`Synced ${source.repo}`, "ok");
}

function renderSources() {
  const root = $("#sources");
  root.replaceChildren();
  if (!config.sources.length) {
    root.append(el("p", { class: "empty" }, "No shared files yet."));
    return;
  }
  config.sources.forEach((source, i) => {
    const hasToken = Boolean(tokens[source.id]);
    root.append(
      el("div", { class: "source" },
        el("div", { class: "source-head" },
          el("div", {},
            el("a", { href: fileUrl(source), target: "_blank", rel: "noreferrer", class: "repo" }, source.repo),
            el("span", { class: "muted mono" }, `  ${source.branch || "default branch"} · ${source.path}`)
          ),
          el("div", { class: "actions" },
            el("button", {
              type: "button", disabled: syncing.has(source.id),
              onclick: async () => {
                if (!(await requestGitHubAccess())) return setStatus("GitHub access wasn't allowed.", "err");
                runSync(source);
              },
            }, "Sync now"),
            el("button", {
              type: "button", class: "danger",
              onclick: async () => {
                if (!confirm(`Stop using shared links from ${source.repo}?`)) return;
                config.sources.splice(i, 1);
                await saveNow();
                await forgetRemovedSources(config);
                [cache, tokens] = await Promise.all([loadCache(), loadTokens()]);
                render();
              },
            }, "Remove")
          )
        ),
        el("div", { class: "source-status" }, sourceStatus(source)),
        el("label", { class: "inline token" },
          "Access token",
          el("input", {
            type: "password", autocomplete: "off", spellcheck: false,
            placeholder: hasToken ? "Saved on this device. Type to replace." : "Only needed for private repositories",
            onchange: async (e) => {
              const value = e.target.value.trim();
              if (!value) return;
              await setToken(source.id, value);
              tokens = await loadTokens();
              e.target.value = "";
              setStatus("Token saved on this device", "ok");
              renderSources();
            },
          }),
          hasToken
            ? el("button", {
                type: "button",
                onclick: async () => {
                  await setToken(source.id, "");
                  tokens = await loadTokens();
                  renderSources();
                },
              }, "Forget token")
            : null
        )
      )
    );
  });
}

$("#add-source").addEventListener("submit", async (e) => {
  e.preventDefault();
  const granted = requestGitHubAccess(); // ask first, while this still counts as a click
  const location = parseGitHubLocation($("#source-location").value);
  if (!location) {
    setStatus("Enter a GitHub repository (owner/name) or a link to the file on github.com.", "err");
    return;
  }
  const source = normalizeSource({
    repo: location.repo,
    branch: $("#source-branch").value.trim() || location.branch || "",
    path: $("#source-path").value.trim() || location.path || DEFAULT_SHARED_PATH,
  });
  if (config.sources.some((s) => s.id === source.id)) {
    setStatus("That file is already in the list.", "err");
    return;
  }
  if (!(await granted)) {
    setStatus("Allow access to api.github.com to sync shared files.", "err");
    return;
  }
  config.sources.push(source);
  await saveNow();
  e.target.reset();
  runSync(source);
});

function renderShareBuilder() {
  const list = $("#share-links");
  const previous = new Set([...list.querySelectorAll("input:checked")].map((c) => c.value));
  const first = !list.children.length;
  list.replaceChildren(
    ...config.links.filter((l) => l.key).map((link) =>
      el("label", { class: "inline" },
        el("input", {
          type: "checkbox", value: link.key, checked: first || previous.has(link.key),
          onchange: updateShareJson,
        }),
        el("span", {}, link.key),
        el("span", { class: "muted mono" }, link.template)
      )
    )
  );
  if (!config.links.length) list.append(el("p", { class: "empty" }, "Add some links of your own first."));
  updateShareJson();
}

function updateShareJson() {
  const keys = [...$("#share-links").querySelectorAll("input:checked")].map((c) => c.value);
  const file = buildSharedFile(config, keys, { includeValues: $("#share-values").checked });
  $("#share-json").value = JSON.stringify(file, null, 2);
}

$("#share-values").addEventListener("change", updateShareJson);
$("#share-copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#share-json").value);
  setStatus("Copied to clipboard", "ok");
});

// ---- Tutorial ---------------------------------------------------------------

// Open until dismissed; remembered per browser. Storage can be unavailable, so it's best effort.
const TUTORIAL_KEY = "tutorial-hidden";
try {
  if (localStorage.getItem(TUTORIAL_KEY) === "1") $("#tutorial").open = false;
} catch {}
$("#tutorial").addEventListener("toggle", (e) => {
  try {
    localStorage.setItem(TUTORIAL_KEY, e.target.open ? "0" : "1");
  } catch {}
});
$("#tutorial-done").addEventListener("click", () => {
  $("#tutorial").open = false;
  $("#tutorial").scrollIntoView({ block: "nearest" });
});

// ---- Wiring ---------------------------------------------------------------

function render() {
  recompute();
  const keyword = chrome.runtime.getManifest().omnibox?.keyword ?? "";
  document.querySelectorAll(".keyword").forEach((k) => (k.textContent = keyword));
  renderVars();
  renderLinks();
  renderSources();
  renderShareBuilder();
  $("#open-in").value = config.openIn;
}

$("#add-var").addEventListener("click", () => {
  let n = 1;
  while (effective.variableNames.includes(`VAR_${n}`)) n++;
  config.variableNames.push(`VAR_${n}`);
  restructured();
});

$("#add-env").addEventListener("click", () => {
  const name = `ENV ${effective.environments.length + 1}`;
  config.environments.push({ id: uniqueEnvId(name), name, variables: {} });
  restructured();
});

$("#add-link").addEventListener("click", () => {
  const link = { key: "", template: "", overrides: {} };
  config.links.push(link);
  restructured();
  const inputs = document.querySelectorAll("#links .link-row input:first-of-type");
  inputs[inputs.length - 1]?.focus();
});

$("#open-in").addEventListener("change", (e) => { config.openIn = e.target.value; scheduleSave(); });

$("#export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(config, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  el("a", { href: url, download: `environment-links-${date}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus("Exported", "ok");
});

async function importJson(text, from) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
    if (!confirm(`Replace your current environments, variables and links with ${from}?`)) return;
    config = normalizeConfig(parsed);
    openLinks.clear();
    restructured();
    await forgetRemovedSources(config);
    setStatus("Imported", "ok");
  } catch (err) {
    setStatus(`Import failed: ${err.message}`, "err");
  }
}

$("#import").addEventListener("click", () => importJson($("#json").value, "this JSON"));

$("#import-file").addEventListener("click", () => $("#import-file-input").click());
$("#import-file-input").addEventListener("change", async (e) => {
  const [file] = e.target.files;
  e.target.value = ""; // so choosing the same file again still triggers a change
  if (file) await importJson(await file.text(), `the contents of ${file.name}`);
});

$("#reset").addEventListener("click", () => {
  if (!confirm("Replace your own environments, variables and links with the example? Shared files are kept.")) return;
  config = normalizeConfig({ ...structuredClone(DEFAULT_CONFIG), sources: config.sources });
  openLinks.clear();
  restructured();
});

// Keep in sync with other tabs, other synced devices, and background syncs of shared files.
chrome.storage.onChanged.addListener(async (changes, area) => {
  const busy = document.activeElement?.matches("input, textarea, select");
  if (area === "local" && (changes.shared || changes.tokens)) {
    if (changes.shared) cache = changes.shared.newValue || {};
    if (changes.tokens) tokens = changes.tokens.newValue || {};
    if (busy) { recompute(); renderPreviews(); refreshPlaceholders(); } else render();
    return;
  }
  if (area !== "sync" || !changes[CONFIG_KEY]) return;
  const incoming = normalizeConfig(changes[CONFIG_KEY].newValue);
  if (JSON.stringify(incoming) === JSON.stringify(config)) return; // our own save
  if (busy) return;
  config = incoming;
  render();
});

(async () => {
  const stored = await chrome.storage.sync.get(CONFIG_KEY);
  config = normalizeConfig(stored[CONFIG_KEY] || structuredClone(DEFAULT_CONFIG));
  if (!stored[CONFIG_KEY]) await chrome.storage.sync.set({ [CONFIG_KEY]: config });
  [cache, tokens] = await Promise.all([loadCache(), loadTokens()]);
  render();
})();
