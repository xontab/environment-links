import {
  DEFAULT_CONFIG, DEFAULT_SHARED_PATH, normalizeConfig, normalizeSource, expandLink, displayUrl, slug,
  resolveConfig, parseGitHubLocation, buildSharedFile, isEmptyConfig, normalizeGroup, sourceGroupId, isExcluded, variablesUsed, toVariableName, renameInLink, exportSettings, importSettings, hasCredentials,
} from "./core.js";
import { GROUP_PERMISSION } from "./open.js";
import {
  CONFIG_KEY, GITHUB_PERMISSION, loadCache, layersFor, loadTokens, setToken, syncSource, forgetRemovedSources,
} from "./shared.js";

const $ = (sel) => document.querySelector(sel);

// `config` is the user's own settings (what gets saved). `effective` adds the shared files on
// top for display; it is recomputed from config + cache and never saved.
// settings is everything the user saved. config is the environment group being edited, one of
// settings.groups: Variables, Links and Shared links all show and change that group only.
let settings = normalizeConfig(DEFAULT_CONFIG);
let config = settings.groups[0];
let cache = {};
let tokens = {};
let effectiveAll = resolveConfig(settings);
let effective = effectiveAll.groups[0]; // the group being edited, with its shared links laid underneath
// At most one link's preview and overrides are open at a time: the key of that link (an own
// link object, or "shared:<source>:<key>" for a shared one), or null.
let openLink = null;
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

const GROUP_KEY = "current-group"; // a convenience, so a reload stays on the same group
let currentGroupId = (() => { try { return localStorage.getItem(GROUP_KEY); } catch { return null; } })();

function recompute() {
  config = settings.groups.find((g) => g.id === currentGroupId) || settings.groups[0];
  currentGroupId = config.id;
  effectiveAll = resolveConfig(settings, layersFor(settings, cache));
  effective = effectiveAll.groups.find((g) => g.id === config.id);
}

/** The shared sources that feed the group being edited, and their last fetched files. */
const groupSources = () => settings.sources.filter((source) => sourceGroupId(settings, source) === config.id);
const groupLayers = () => layersFor(settings, cache).filter(({ source }) => sourceGroupId(settings, source) === config.id);

async function saveNow() {
  clearTimeout(saveTimer);
  try {
    await chrome.storage.sync.set({ [CONFIG_KEY]: settings });
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
  return new Set(groupLayers().flatMap(({ data }) => data?.variableNames || []));
}

function sharedEnvironmentIds() {
  return new Set(groupLayers().flatMap(({ data }) => (data?.environments || []).map((e) => e.id)));
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

// ---- Environment groups -----------------------------------------------------

const MORE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
  <circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`;
const PENCIL_PATHS = `<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>`;

let renamingGroup = null; // the id of the group whose tab shows a name field

function switchGroup(id) {
  currentGroupId = id;
  try { localStorage.setItem(GROUP_KEY, id); } catch {}
  openLink = null;
  render();
}

const focusGroupTab = (id) => $(`#group-tabs [role=tab][data-group="${CSS.escape(id)}"]`)?.focus();

/** One tab per group, each with a ⋯ menu to rename or delete it. Arrow keys move between tabs. */
function renderGroups() {
  const several = settings.groups.length > 1;
  closeGroupMenu();
  $("#group-tabs").replaceChildren(...effectiveAll.groups.map((resolved, i) => {
    const group = settings.groups[i];
    const selected = group.id === config.id;
    const count = resolved.links.filter((l) => l.key).length;
    const wrap = el("div", { class: `group-tab${selected ? " selected" : ""}`, dataset: { group: group.id } });
    if (renamingGroup === group.id) {
      wrap.append(renameField(group));
      return wrap;
    }
    wrap.draggable = several; // drag a tab to reorder the groups
    wrap.append(
      el("button", {
        type: "button", role: "tab", dataset: { group: group.id }, "aria-controls": "group-panel",
        "aria-selected": String(selected), tabIndex: selected ? 0 : -1,
        onclick: () => { switchGroup(group.id); focusGroupTab(group.id); }, // the tabs were rebuilt
        ondblclick: () => startRename(group),
        onkeydown: (e) => {
          const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
          if (e.key === "F2") return startRename(group);
          if (!step) return;
          e.preventDefault();
          if (e.altKey) return moveGroup(group, step); // Alt+arrow moves the tab itself
          const next = settings.groups[(i + step + settings.groups.length) % settings.groups.length];
          switchGroup(next.id);
          focusGroupTab(next.id);
        },
        title: several ? "Drag, or press Alt+←/→, to reorder" : "",
      }, el("span", { class: "name" }, group.name), el("span", { class: "count", title: plural(count, "link") }, String(count))),
      moreButton(group, several)
    );
    return wrap;
  }));
}

function moreButton(group, several) {
  const button = el("button", {
    type: "button", class: "more", title: `Options for ${group.name}`, "aria-label": `Options for ${group.name}`,
    "aria-haspopup": "menu", "aria-expanded": "false",
    onclick: (e) => {
      e.stopPropagation();
      if (button.getAttribute("aria-expanded") === "true") return closeGroupMenu();
      openGroupMenu(button, group, several);
    },
  });
  button.innerHTML = MORE_ICON; // static markup
  return button;
}

// ---- The ⋯ menu ----

let groupMenu = null; // { menu, button }

function closeGroupMenu({ refocus = false } = {}) {
  if (!groupMenu) return;
  const { menu, button } = groupMenu;
  groupMenu = null;
  menu.remove();
  button.setAttribute("aria-expanded", "false");
  if (refocus) button.focus();
}

function openGroupMenu(button, group, several) {
  closeGroupMenu();
  const item = (label, icon, action, { danger = false, disabled = false, title = "" } = {}) =>
    el("button", {
      type: "button", role: "menuitem", class: danger ? "danger" : "", disabled, title, tabIndex: -1,
      onclick: () => { closeGroupMenu(); action(); },
    }, buttonIcon(icon), label);
  const index = settings.groups.indexOf(group);
  const menu = el("div", { class: "group-menu", role: "menu", "aria-label": `${group.name} options` },
    item("Rename", PENCIL_PATHS, () => startRename(group)),
    ...(several ? [
      item("Move left", ARROW_LEFT, () => moveGroup(group, -1), { disabled: index === 0 }),
      item("Move right", ARROW_RIGHT, () => moveGroup(group, 1), { disabled: index === settings.groups.length - 1 }),
    ] : []),
    item("Clear settings", ERASER_ICON, () => clearGroup(group), {
      danger: true, disabled: isEmptyGroup(group), title: isEmptyGroup(group) ? "This group has nothing of your own to clear" : "",
    }),
    item("Delete", TRASH_ICON, () => deleteGroup(group), {
      danger: true, disabled: !several, title: several ? "" : "There has to be at least one group",
    }));
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll("[role=menuitem]:not(:disabled)")];
    const at = items.indexOf(document.activeElement);
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      closeGroupMenu({ refocus: true });
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
  });
  button.closest(".group-tab").append(menu);
  button.setAttribute("aria-expanded", "true");
  groupMenu = { menu, button };
  menu.querySelector("[role=menuitem]:not(:disabled)")?.focus();
}

document.addEventListener("click", (e) => {
  if (groupMenu && !groupMenu.menu.contains(e.target)) closeGroupMenu();
});

// ---- Reordering ----

const ARROW_LEFT = `<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>`;
const ARROW_RIGHT = `<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>`;

/** Put a group at a new position in the list. The order is also the order searches list groups in. */
function placeGroup(group, index) {
  const from = settings.groups.indexOf(group);
  const to = Math.max(0, Math.min(index, settings.groups.length - 1));
  if (from < 0 || from === to) return false;
  settings.groups.splice(from, 1);
  settings.groups.splice(to, 0, group);
  scheduleSave();
  recompute(); // the tabs pair each group with its resolved copy by position
  renderGroups();
  return true;
}

function moveGroup(group, delta) {
  placeGroup(group, settings.groups.indexOf(group) + delta);
  focusGroupTab(group.id);
}

let draggingGroup = null;
const groupTabs = $("#group-tabs");
const clearGroupDrop = () => groupTabs.querySelectorAll(".drop-before, .drop-after, .dragging")
  .forEach((n) => n.classList.remove("drop-before", "drop-after", "dragging"));
/** The tab under the pointer and whether the drop goes after it (the pointer is on its right half). */
function groupDropTarget(e) {
  const tab = e.target.closest(".group-tab");
  if (!tab || !draggingGroup || tab.dataset.group === draggingGroup.id) return null;
  const { left, width } = tab.getBoundingClientRect();
  return { tab, after: e.clientX > left + width / 2 };
}
groupTabs.addEventListener("dragstart", (e) => {
  const tab = e.target.closest(".group-tab");
  draggingGroup = tab && settings.groups.find((g) => g.id === tab.dataset.group);
  if (!draggingGroup) return;
  closeGroupMenu();
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", draggingGroup.name);
  tab.classList.add("dragging");
});
groupTabs.addEventListener("dragover", (e) => {
  if (!draggingGroup) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  groupTabs.querySelectorAll(".drop-before, .drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
  const target = groupDropTarget(e);
  target?.tab.classList.add(target.after ? "drop-after" : "drop-before");
});
groupTabs.addEventListener("drop", (e) => {
  const target = groupDropTarget(e);
  const group = draggingGroup;
  if (!target || !group) return;
  e.preventDefault();
  const others = settings.groups.filter((g) => g !== group);
  const at = others.findIndex((g) => g.id === target.tab.dataset.group) + (target.after ? 1 : 0);
  draggingGroup = null;
  placeGroup(group, at);
});
groupTabs.addEventListener("dragend", () => { draggingGroup = null; clearGroupDrop(); });

// ---- Rename, add and delete ----

function startRename(group) {
  renamingGroup = group.id;
  renderGroups();
  const field = $("#group-tabs .rename");
  field?.focus();
  field?.select();
}

/** The name field a tab turns into. Enter or leaving it saves; Escape keeps the old name. */
function renameField(group) {
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const name = field.value.trim();
    renamingGroup = null;
    if (save && name && name !== group.name) {
      group.name = name;
      scheduleSave();
    }
    render(); // other sections show the group's name too
    focusGroupTab(group.id);
  };
  const field = el("input", {
    class: "rename", value: group.name, maxLength: 40, "aria-label": "Group name",
    onkeydown: (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    },
    onblur: () => finish(true),
  });
  return field;
}

$("#add-group").addEventListener("click", () => {
  let n = settings.groups.length + 1;
  while (settings.groups.some((g) => g.name === `Group ${n}`)) n++;
  const group = normalizeGroup({ name: `Group ${n}` });
  while (settings.groups.some((g) => g.id === group.id)) group.id += "-2";
  settings.groups.push(group);
  scheduleSave();
  currentGroupId = group.id;
  try { localStorage.setItem(GROUP_KEY, group.id); } catch {}
  openLink = null;
  render();
  startRename(group); // ready to type its real name
});

const ERASER_ICON = `<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L11 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>`;

const isEmptyGroup = (group) => !group.environments.length && !group.links.length && !group.variableNames.length
  && !Object.keys(group.globals).length;

/** Remove a group's own variables, environments and links. Its name, place and Shared links stay. */
async function clearGroup(group) {
  const parts = [plural(group.environments.length, "environment"), plural(group.variableNames.length, "variable"),
    plural(group.links.length, "link")];
  const shared = settings.sources.some((s) => sourceGroupId(settings, s) === group.id) ? " Its Shared links are kept." : "";
  if (!confirm(`Clear the ${group.name} group's ${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}?${shared}`)) return;
  Object.assign(group, normalizeGroup({ id: group.id, name: group.name }));
  openLink = null;
  render();
  focusGroupTab(group.id);
  await saveNow(); // save first, so "Saved" doesn't replace the message below
  setStatus(`Cleared the ${group.name} group.`, "ok");
}

async function deleteGroup(group) {
  if (settings.groups.length < 2) return;
  const sources = settings.sources.filter((s) => sourceGroupId(settings, s) === group.id);
  const parts = [plural(group.environments.length, "environment"), plural(group.links.length, "link")];
  if (sources.length) parts.push(`its Shared links from ${sources.map((s) => s.repo).join(", ")}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  const empty = !group.environments.length && !group.links.length && !group.variableNames.length && !sources.length;
  if (!empty && !confirm(`Delete the ${group.name} group, with ${list}?`)) return; // an empty one goes without asking
  settings.groups = settings.groups.filter((g) => g !== group);
  settings.sources = settings.sources.filter((s) => !sources.includes(s));
  if (currentGroupId === group.id) currentGroupId = settings.groups[0].id;
  openLink = null;
  render();
  focusGroupTab(currentGroupId);
  await saveNow();
  await forgetRemovedSources(settings);
  [cache, tokens] = await Promise.all([loadCache(), loadTokens()]);
  setStatus(`Deleted the ${group.name} group.`, "ok");
}

// ---- Variables grid -------------------------------------------------------

const BRACES_ICON = `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round"><path d="M8 4H7a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h1"/>
  <path d="M16 4h1a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-1"/></svg>`;
const LINK_ICON = `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/>
  <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>`;

/** A dashed placeholder with an icon, a title and a hint. The icons are static markup. */
function emptyBlock(icon, title, hint) {
  const art = el("span");
  art.innerHTML = icon;
  return el("div", { class: "empty-block" }, art.firstElementChild, el("div", {}, el("strong", {}, title), hint));
}

function renderVars() {
  const table = $("#vars");
  table.replaceChildren();
  $("#vars-empty")?.remove();
  const nothing = !effective.environments.length && !effective.variableNames.length;
  table.hidden = nothing;
  if (!effective.environments.length) {
    // Without environments there's nothing to fill in, even when some variables are there already.
    const block = emptyBlock(BRACES_ICON, "No environments yet", nothing
      ? "Add one with + Environment, for example DEV. Then add the variables your links need, such as ENVIRONMENT and DOMAIN."
      : "Add one with + Environment, for example DEV, to give these variables a value for it.");
    block.id = "vars-empty";
    table.parentElement.after(block);
    if (nothing) return;
  }
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
          return el("th", { dataset: { var: name } },
            el("div", { class: "head-cell" },
              grip("var", name, `variable ${name}`, "x"),
              el("input", {
                class: "mono", value: name, "aria-label": "Variable name", readOnly: shared,
                title: shared ? "Defined in Shared links, so it can't be renamed here" : "",
                oninput: (e) => capitalise(e.target),
                onchange: (e) => renameVariable(name, e.target.value),
              }),
              shared ? sharedTag("Shared links") : null,
              iconButton(
                shared ? `Clear your values for ${name}` : `Remove ${name}`, "✕",
                () => {
                  if (!shared) {
                    // Like removing an environment, ask first, and say which links would be left with a gap.
                    const users = effective.links.filter((l) => l.key && variablesUsed(l).has(name)).map((l) => l.key);
                    const note = users.length ? `\n\n${users.join(", ")} ${users.length === 1 ? "uses" : "use"} it.` : "";
                    if (!confirm(`Remove variable "${name}"?${note}`)) return;
                  }
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

  const cell = (name, value, onvalue, dataset) => {
    const secret = isSecret(name);
    return el("td", {},
      el("input", {
        class: "mono", value: value ?? "", "aria-label": name, dataset,
        // A password or token is dots until the cell is being edited.
        ...(secret ? {
          type: "password", autocomplete: "off",
          onfocus: (e) => { e.target.type = "text"; }, onblur: (e) => { e.target.type = "password"; },
        } : {}),
        oninput: (e) => { onvalue(e.target.value); changed(); },
      })
    );
  };
  const assign = (obj, name, value) => {
    if (value === "") delete obj[name];
    else obj[name] = value;
  };

  const body = el("tbody");
  // The Default row holds values for every environment, so it only shows once there's a variable.
  if (effective.variableNames.length) body.append(
    el("tr", { class: "defaults" },
      el("th", {}, el("span", { class: "fixed" }, "Default")),
      ...effective.variableNames.map((name) =>
        cell(name, config.globals[name], (v) => assign(config.globals, name, v), { var: name, default: "1" })
      ),
      el("td", { class: "row-actions" })
    )
  );

  effective.environments.forEach((env) => {
    const own = ownEnvironment(env, false);
    const i = own ? config.environments.indexOf(own) : -1;
    const shared = sharedIds.has(env.id);
    body.append(
      el("tr", { dataset: { env: env.id } },
        el("th", {},
          el("div", { class: "head-cell" },
            grip("env", env.id, `environment ${env.name}`, "y"),
            el("input", {
              value: own?.name ?? env.name, "aria-label": "Environment name",
              oninput: (e) => { ownEnvironment(env, true).name = e.target.value; changed(); },
            }),
            shared ? sharedTag(env.source || "Shared links") : null
          )
        ),
        ...effective.variableNames.map((name) =>
          cell(name, own?.variables[name], (v) => assign(ownEnvironment(env, true).variables, name, v),
            { var: name, env: env.id })
        ),
        el("td", { class: "row-actions" },
          el("div", { class: "head-cell" },
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
  restoreGripFocus();
}

/** Blank cells show, as a placeholder, the value they get from Default or a shared file. */
function refreshPlaceholders() {
  document.querySelectorAll("#vars input[data-var]").forEach((input) => {
    const { var: name, env: envId } = input.dataset;
    const value = input.dataset.default
      ? effective.sharedGlobals[name]
      : effective.environments.find((e) => e.id === envId)?.inherited[name];
    const shown = isSecret(name) && value ? "••••" : value; // an inherited password stays hidden too
    input.placeholder = shown ?? "";
    input.title = value != null && value !== ""
      ? `Blank, so it uses ${input.dataset.default ? "the shared default" : "the default"}: ${shown}`
      : "";
  });
}

/** A variable that holds a password or token, by its name: shown as dots in the grid. */
const isSecret = (name) => /PASS|SECRET|TOKEN|API_?KEY/i.test(name);

/** Variable names are capitals only: change what's typed as it's typed, keeping the cursor where it was. */
function capitalise(input) {
  const { selectionStart, selectionEnd } = input;
  const value = input.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"); // one character for one, so the cursor stays put
  if (value !== input.value) {
    input.value = value;
    input.setSelectionRange(selectionStart, selectionEnd);
  }
}

function renameVariable(from, rawTo) {
  const to = toVariableName(rawTo);
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
// ---- Reordering rows and columns by drag and drop -----------------------------

// Environments (rows) and variables (columns) are reordered by their ⋮⋮ handle: drag it, or
// focus it and use the arrow keys. Either way the full order is saved, so shared environments
// and variables can be placed among the user's own.
const ORDER = {
  env: { list: () => effective.environments.map((e) => e.id), save: (ids) => { config.environmentOrder = ids; } },
  var: { list: () => [...effective.variableNames], save: (ids) => { config.variableOrder = ids; } },
};
let dragging = null; // { kind, id }
let focusAfterRender = null; // the handle to focus again once the grid is rebuilt

function reorder(kind, id, targetId, after) {
  const ids = ORDER[kind].list().filter((x) => x !== id);
  const at = ids.indexOf(targetId);
  ids.splice(at < 0 ? ids.length : at + (after ? 1 : 0), 0, id);
  ORDER[kind].save(ids);
  restructured();
}

function nudge(kind, id, delta) {
  const ids = ORDER[kind].list();
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return;
  moveItem(ids, from, delta);
  ORDER[kind].save(ids);
  focusAfterRender = `${kind}:${id}`;
  restructured();
}

const GRIP_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
  <circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/>
  <circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>`;

function grip(kind, id, label, axis) {
  const keys = axis === "y" ? { ArrowUp: -1, ArrowDown: 1 } : { ArrowLeft: -1, ArrowRight: 1 };
  const button = el("button", {
    type: "button", class: "grip", dataset: { grip: `${kind}:${id}` },
    title: `Drag to move ${label}, or use the arrow keys`, "aria-label": `Move ${label}`,
    onkeydown: (e) => {
      if (!(e.key in keys)) return;
      e.preventDefault();
      nudge(kind, id, keys[e.key]);
    },
    // Only the handle starts a drag, so text in the inputs can still be selected normally.
    onpointerdown: () => { (button.closest(kind === "env" ? "tr" : "th")).draggable = true; },
  });
  button.innerHTML = GRIP_ICON; // static markup
  return button;
}

function restoreGripFocus() {
  if (!focusAfterRender) return;
  document.querySelector(`.grip[data-grip="${CSS.escape(focusAfterRender)}"]`)?.focus();
  focusAfterRender = null;
}

function clearDropMarks() {
  document.querySelectorAll("#vars .drop-before, #vars .drop-after, #vars .dragging")
    .forEach((n) => n.classList.remove("drop-before", "drop-after", "dragging"));
}

/** Where the dragged item would land: before or after the row or column under the pointer. */
function dropTarget(e) {
  if (!dragging) return null;
  const node = e.target.closest(dragging.kind === "env" ? "tr[data-env]" : "th[data-var]");
  if (!node) return null;
  const id = dragging.kind === "env" ? node.dataset.env : node.dataset.var;
  if (id === dragging.id) return null;
  const box = node.getBoundingClientRect();
  const after = dragging.kind === "env" ? e.clientY > box.top + box.height / 2 : e.clientX > box.left + box.width / 2;
  return { node, id, after };
}

const varsTable = $("#vars");
varsTable.addEventListener("dragstart", (e) => {
  const node = e.target.closest("tr[data-env], th[data-var]");
  if (!node?.draggable) return e.preventDefault();
  dragging = node.dataset.env ? { kind: "env", id: node.dataset.env } : { kind: "var", id: node.dataset.var };
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", dragging.id);
  node.classList.add("dragging");
});
varsTable.addEventListener("dragover", (e) => {
  const target = dropTarget(e);
  if (!target) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  document.querySelectorAll("#vars .drop-before, #vars .drop-after")
    .forEach((n) => n.classList.remove("drop-before", "drop-after"));
  target.node.classList.add(target.after ? "drop-after" : "drop-before");
});
varsTable.addEventListener("drop", (e) => {
  const target = dropTarget(e);
  if (!target) return;
  e.preventDefault();
  const { kind, id } = dragging;
  dragging = null;
  clearDropMarks();
  reorder(kind, id, target.id, target.after);
});
varsTable.addEventListener("dragend", (e) => {
  e.target.closest?.("[draggable]")?.removeAttribute("draggable");
  dragging = null;
  clearDropMarks();
});
document.addEventListener("pointerup", () => {
  if (!dragging) varsTable.querySelectorAll("[draggable]").forEach((n) => n.removeAttribute("draggable"));
});

function moveItem(list, index, delta) {
  const [item] = list.splice(index, 1);
  list.splice(index + delta, 0, item);
}

// ---- Links ----------------------------------------------------------------

function previewRow(env, ref, input, applies = null) {
  return el("div", { class: "env-row", dataset: { env: env.id } },
    el("span", { class: "name" }, env.name),
    input,
    applies,
    el("div", { class: "preview", dataset: { link: ref, env: env.id } })
  );
}

/**
 * The "Applicable" tickbox on one of the user's own links: untick it when the link doesn't exist in
 * that environment, so it isn't listed there. Any override typed for it is kept for later.
 */
function appliesToggle(link, env, input) {
  const box = el("input", {
    type: "checkbox", checked: !isExcluded(link, env),
    onchange: (e) => {
      const excluded = new Set(link.excluded || []);
      if (e.target.checked) excluded.delete(env.id);
      else excluded.add(env.id);
      if (excluded.size) link.excluded = [...excluded];
      else delete link.excluded;
      markExcluded(label, input, !e.target.checked);
      changed();
    },
  });
  const label = el("label", {
    class: "applies", title: `Untick if ${link.key || "this link"} doesn't exist in ${env.name}, to leave ${env.name} out of its list`,
  }, box, "Applicable");
  queueMicrotask(() => markExcluded(label, input, isExcluded(link, env))); // once the row exists
  return label;
}

function markExcluded(label, input, excluded) {
  label.closest(".env-row")?.classList.toggle("excluded", excluded);
  input.disabled = excluded;
}

// A chevron that points right when closed; CSS rotates it down when the row is open.
const CHEVRON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor"
  stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`;

function toggleButton(key) {
  const button = el("button", {
    type: "button", class: "toggle",
    onclick: () => openOnly(openLink === key ? null : key),
  });
  button.innerHTML = CHEVRON; // static markup
  return button;
}

/** A link's row in the list, remembering which link it shows so it can be opened in place. */
function linkBox(key, className, ...children) {
  const box = el("div", { class: className }, ...children);
  box.linkKey = key;
  return box;
}

/** A note in the same style as the "Alt+Enter still works" one under Behaviour. */
function infoNote(text) {
  const note = el("p", { class: "info", role: "note" });
  note.innerHTML = `<svg class="info-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>`;
  note.append(el("span", {}, text)); // the text is added as text, never as markup
  return note;
}

/** A pencil, for "Override with your own copy". */
function pencilIcon() {
  const icon = el("span", { class: "override-icon", "aria-hidden": "true" });
  icon.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;
  return icon;
}

/** An anticlockwise arrow, for "Restore the shared link". */
function restoreIcon() {
  const icon = el("span", { class: "override-icon", "aria-hidden": "true" });
  icon.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`;
  return icon;
}

/** Delete the user's own link(s) with this shared link's name, so the shared one is used again. */
async function restoreShared(shared) {
  const name = shared.key.toLowerCase();
  if (!confirm(`Delete your own "${shared.key}" link and use the shared one from ${shared.source} again?`)) return;
  config.links = config.links.filter((l) => l.key.toLowerCase() !== name);
  if (openLink && typeof openLink === "object" && openLink.key.toLowerCase() === name) openLink = null;
  render();
  await saveNow(); // save first, so "Saved" doesn't replace the message below
  setStatus(`Restored the shared "${shared.key}" link.`, "ok");
}

/** Go to the user's own link with this name: open it, bring it into view and briefly highlight it. */
function showOwnLink(name) {
  const own = config.links.find((l) => l.key.toLowerCase() === name.toLowerCase());
  const box = own && [...document.querySelectorAll("#links .link")].find((b) => b.linkKey === own);
  if (!box) return;
  openOnly(own);
  box.scrollIntoView({ block: "center" });
  box.querySelector(".link-row input.template")?.focus({ preventScroll: true });
  box.classList.remove("flash");
  void box.offsetWidth; // restart the animation if it's clicked twice
  box.classList.add("flash");
  box.addEventListener("animationend", () => box.classList.remove("flash"), { once: true });
}

/**
 * Open one link (closing any other), or close them all with null. It only switches classes,
 * because the details already exist: rebuilding would lose the cursor in a field being typed in.
 */
function openOnly(key) {
  openLink = key;
  document.querySelectorAll("#links .link, #shared-links .link").forEach((box) => {
    const open = box.linkKey === key;
    box.classList.toggle("open", open);
    const toggle = box.querySelector(".toggle");
    const label = open ? "Hide preview and overrides" : "Show preview and overrides";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
  });
}

/** With no environments in the group, a link has nowhere to open, so its details say so and offer one. */
function noEnvironmentsNote() {
  if (effective.environments.length) return null;
  const note = infoNote("There are no environments yet, so this link has nowhere to open. Add one, such as DEV, and give it the values your template uses.");
  note.append(el("button", {
    type: "button", class: "note-action",
    onclick: () => {
      $("#add-env").click();
      const name = [...document.querySelectorAll('#vars input[aria-label="Environment name"]')].at(-1);
      name?.scrollIntoView({ block: "center" });
      name?.focus({ preventScroll: true });
      name?.select();
    },
  }, buttonIcon(PLUS_ICON), "Add an environment"));
  return note;
}

function renderLinks() {
  const root = $("#links");
  root.replaceChildren();
  if (!config.links.length) {
    root.append(emptyBlock(LINK_ICON, "No links of your own yet",
      el("span", {}, "Add one with + Link: a short name, and a URL template with your variables in {{double braces}}, for example ",
        el("code", {}, "backoffice"), " and ", el("code", {}, "backoffice.{{ENVIRONMENT}}.{{DOMAIN}}"), ".")));
  }

  config.links.forEach((link, i) => {

    const shadows = effective.sharedLinks.find((s) => s.shadowed && s.key.toLowerCase() === link.key.toLowerCase());
    root.append(
      linkBox(link, "link",
        el("div", { class: "link-row" },
          toggleButton(link),
          el("input", {
            value: link.key, placeholder: "Link Name (e.g. BackOffice)", "aria-label": "Link name",
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
          shadows
            ? infoNote(`This overrides the shared "${shadows.key}" link from ${shadows.source}. Delete this link, or click restore (↺) on the shared one, to use it again.`)
            : null,
          noEnvironmentsNote(),
          ...effective.environments.map((env) => {
            const input = el("input", {
              class: "mono",
              value: link.overrides[env.id] ?? "",
              placeholder: "Uses the template above. Type a URL to override for this environment.",
              "aria-label": `Override for ${env.name}`,
              oninput: (e) => {
                if (e.target.value.trim()) link.overrides[env.id] = e.target.value;
                else delete link.overrides[env.id];
                changed();
              },
            });
            return previewRow(env, String(i), input, appliesToggle(link, env, input));
          })
        )
      )
    );
  });

  renderSharedLinks();
  renderPreviews();
  openOnly(openLink);
}

// Clicking a shared link's row opens it (or closes it if it's already open), like its arrow.
// Its buttons keep their own actions. The arrow stays the keyboard way to do it.
$("#shared-links").addEventListener("click", (e) => {
  const row = e.target.closest(".link-row");
  if (!row || e.target.closest("button, a, input")) return;
  const box = row.closest(".link");
  openOnly(openLink === box.linkKey ? null : box.linkKey);
});

// Clicking or tabbing into a link's name or template opens that link (and closes the others),
// so its previews and overrides are in view while it's being edited.
$("#links").addEventListener("focusin", (e) => {
  const box = e.target.closest(".link");
  if (box && e.target.closest(".link-row input") && openLink !== box.linkKey) openOnly(box.linkKey);
});

const GITHUB_MARK = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.81 1.19 1.83 1.19 3.09 0 4.41-2.7 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"/></svg>`;

/** "Shared links from owner/repo", with the repository linking to the file on GitHub. */
function sourceHeading(source, repo) {
  const mark = el("span", { class: "source-mark", "aria-hidden": "true" });
  mark.innerHTML = GITHUB_MARK;
  const name = source
    ? el("a", { href: fileUrl(source), target: "_blank", rel: "noopener", title: `${source.path} on ${source.branch || "the default branch"}` }, repo)
    : el("span", {}, repo);
  return el("h3", { class: "source-heading" }, mark, "Shared links from ", name);
}

function renderSharedLinks() {
  const root = $("#shared-links");
  root.replaceChildren();
  if (!effective.sharedLinks.length) return;

  // Shared links come out in source order; each source gets a heading naming the repository.
  let lastSource = null;
  effective.sharedLinks.forEach((link, i) => {
    if (link.source !== lastSource) {
      lastSource = link.source;
      root.append(sourceHeading(groupSources().find((src) => src.repo === link.source), link.source));
    }
    const key = `shared:${link.source}:${link.key}`;

    root.append(
      linkBox(key, `link shared${link.shadowed ? " shadowed" : ""}`,
        el("div", { class: "link-row" },
          toggleButton(key),
          el("span", { class: "key-text" }, link.key, " ", sharedTag(link.source)),
          el("span", { class: "mono template-text", title: link.template }, link.template),
          link.shadowed
            ? el("span", { class: "override-actions" },
                el("button", {
                  type: "button", class: "tag overridden",
                  title: "Your own link with this name is used instead. Click to go to it.",
                  onclick: () => showOwnLink(link.key),
                }, "Overridden"),
                el("button", {
                  type: "button", class: "restore",
                  title: `Restore: delete your own "${link.key}" link and use the shared one again`,
                  "aria-label": `Restore the shared ${link.key} link`,
                  onclick: () => restoreShared(link),
                }, restoreIcon())
              )
            : el("button", {
                type: "button", class: "override",
                title: `Override: copy "${link.key}" into your own links and change it there. Your copy is used instead of the shared one.`,
                "aria-label": `Override ${link.key} with your own copy`,
                onclick: async () => {
                  const copy = { key: link.key, template: link.template, overrides: { ...link.overrides },
                    ...(link.excluded ? { excluded: [...link.excluded] } : {}) };
                  config.links.push(copy);
                  openLink = copy; // open the copy, ready to edit
                  render();
                  const box = [...document.querySelectorAll("#links .link")].find((b) => b.linkKey === copy);
                  box?.scrollIntoView({ block: "center" });
                  box?.querySelector(".link-row input.template")?.focus({ preventScroll: true });
                  await saveNow(); // save first, so "Saved" doesn't replace the message below
                  setStatus(`"${link.key}" is now overridden by your own copy. Edit it in Links.`, "ok");
                },
              }, pencilIcon())
        ),
        el("div", { class: "link-details" },
          link.shadowed
            ? infoNote("Overridden: your own link with this name is used instead. Click restore (↺) to use the shared one again.")
            : null,
          ...effective.environments.map((env) =>
            previewRow(env, `s${i}`, el("span", { class: "mono muted" },
              isExcluded(link, env) ? "Not applicable"
                : link.overrides[env.id] ? `Override: ${link.overrides[env.id]}` : "Uses the template"))
          )
        )
      )
    );
  });
}

function renderPreviews() {
  // Environment names, which change as they're typed in the Environments grid.
  document.querySelectorAll(".env-row[data-env]").forEach((row) => {
    const env = effective.environments.find((e) => e.id === row.dataset.env);
    if (!env) return;
    row.querySelector(".name").textContent = env.name;
    row.querySelector("input.mono")?.setAttribute("aria-label", `Override for ${env.name}`);
  });
  document.querySelectorAll(".preview").forEach((node) => {
    const ref = node.dataset.link;
    const link = ref.startsWith("s") ? effective.sharedLinks[Number(ref.slice(1))] : config.links[Number(ref)];
    if (link?.excluded?.includes(node.dataset.env)) {
      return node.replaceChildren(el("span", {}, "Not applicable: this link isn't listed for this environment."));
    }
    const result = link && expandLink(link, effective).find((r) => r.env.id === node.dataset.env);
    if (!result) return node.replaceChildren();
    const children = [
      result.url
        ? previewLink(result.url)
        : el("span", {}, "(empty)"),
    ];
    if (result.missing.length) {
      children.push(el("span", { class: "warn" }, "missing:"),
        ...result.missing.map((name) => missingButton(name, result.env, ref.startsWith("s"))));
    }
    node.replaceChildren(...children);
  });
}

/**
 * A preview's link. One with a password opens from a click instead of its href, so hovering it
 * doesn't show the password in Chrome's status bar.
 */
function previewLink(url) {
  if (!hasCredentials(url)) return el("a", { href: url, target: "_blank", rel: "noreferrer" }, displayUrl(url));
  return el("a", {
    href: "#", title: "Opens with the user and password in the URL",
    onclick: (e) => { e.preventDefault(); window.open(url, "_blank", "noopener,noreferrer"); },
  }, displayUrl(url));
}

/**
 * A missing variable, as a button: it adds the variable to Environments if it isn't there yet, then
 * goes to this environment's cell for it, ready to type the value.
 */
function missingButton(name, env, shared) {
  const known = effective.variableNames.includes(name);
  // Variables added here are capitals only. For one of the user's own links, {{name}} becomes
  // {{NAME}} in their links too; a shared link's file can't be changed, so it gets no button.
  const upper = toVariableName(name);
  if (!known && upper !== name && shared) return el("span", { class: "warn" }, name);
  const title = known ? `Set ${name} for ${env.name} in Environments`
    : upper !== name ? `Add ${upper} to Environments, change {{${name}}} to {{${upper}}} in your links, and set it for ${env.name}`
    : `Add ${name} to Environments and set it for ${env.name}`;
  return el("button", {
    type: "button", class: "add-missing", title,
    onclick: () => {
      let target = name;
      if (!known) {
        target = upper;
        if (upper !== name) config.links.forEach((l) => renameInLink(l, name, upper));
        if (!effective.variableNames.includes(upper)) config.variableNames.push(upper);
        restructured();
      }
      const cell = $(`#vars input[data-var="${CSS.escape(target)}"][data-env="${CSS.escape(env.id)}"]`);
      if (!cell) return;
      cell.scrollIntoView({ block: "center" });
      cell.focus({ preventScroll: true });
      cell.classList.remove("flash");
      void cell.offsetWidth; // restart the animation if it's clicked twice
      cell.classList.add("flash");
      cell.addEventListener("animationend", () => cell.classList.remove("flash"), { once: true });
    },
  }, buttonIcon(known ? PENCIL_PATHS : PLUS_ICON), known ? `Set ${name}` : `Add ${upper}`);
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

const SYNC_ICON = `<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>
  <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/>`;
const TRASH_ICON = `<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>`;

/** A small stroked icon to sit before a button's text. The paths are static markup. */
function buttonIcon(paths) {
  const icon = el("span", { class: "btn-icon", "aria-hidden": "true" });
  icon.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return icon;
}

const KEY_ICON = `<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8"/><path d="m17 6 3 3"/><path d="m14.5 8.5 2 2"/>`;
const X_ICON = `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`;

const TOKEN_HELP_URL =
  "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token";

/** A "?" link to GitHub's guide for creating the fine-grained token a private repository needs. */
function tokenHelpLink() {
  const link = el("a", {
    href: TOKEN_HELP_URL, target: "_blank", rel: "noopener", class: "help-link",
    title: "How to create a GitHub token: make a fine-grained token with read-only Contents access to this repository",
    "aria-label": "How to create a GitHub access token (opens GitHub's guide)",
  });
  link.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/>
    <path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.8c0 1.7-2.4 2.2-2.4 3.7"/><path d="M12 17h.01"/></svg>`;
  return link;
}

/** The access token field, with a button to save it (or replace a saved one) and one to forget it. */
function tokenRow(source, hasToken) {
  const input = el("input", {
    type: "password", autocomplete: "off", spellcheck: false, "aria-label": `Access token for ${source.repo}`,
    placeholder: hasToken ? "A token is saved on this device. Paste a new one to replace it." : "Only needed for private repositories",
    oninput: () => { save.disabled = !input.value.trim(); },
    onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); saveToken(); } },
  });
  const saveToken = async () => {
    const value = input.value.trim();
    if (!value) return;
    await setToken(source.id, value);
    tokens = await loadTokens();
    setStatus(hasToken ? "Token replaced on this device" : "Token saved on this device", "ok");
    renderSources();
  };
  const save = el("button", { type: "button", disabled: true, onclick: saveToken },
    buttonIcon(KEY_ICON), hasToken ? "Replace token" : "Save token");
  return el("div", { class: "inline token" },
    el("span", { class: "token-label" }, "Access token", tokenHelpLink()),
    // The save button sits inside the field's right end, so the field keeps the full width.
    el("div", { class: "token-field" }, input, save),
    hasToken
      ? el("button", {
          type: "button",
          onclick: async () => {
            await setToken(source.id, "");
            tokens = await loadTokens();
            setStatus("Token forgotten", "ok");
            renderSources();
          },
        }, buttonIcon(X_ICON), "Forget token")
      : null
  );
}

function renderSources() {
  const root = $("#sources");
  root.replaceChildren();
  const sources = groupSources();
  if (!sources.length) {
    root.append(el("p", { class: "empty" },
      settings.groups.length > 1 ? `No Shared links added to ${config.name} yet.` : "No Shared links added yet."));
    return;
  }
  sources.forEach((source) => {
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
            }, buttonIcon(SYNC_ICON), "Sync now"),
            el("button", {
              type: "button", class: "danger",
              onclick: async () => {
                if (!confirm(`Stop using shared links from ${source.repo}?`)) return;
                settings.sources = settings.sources.filter((s) => s !== source);
                await saveNow();
                await forgetRemovedSources(settings);
                [cache, tokens] = await Promise.all([loadCache(), loadTokens()]);
                render();
              },
            }, buttonIcon(TRASH_ICON), "Remove")
          )
        ),
        el("div", { class: "source-status" }, sourceStatus(source)),
        tokenRow(source, hasToken)
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
    group: config.id,
  });
  const existing = settings.sources.find((s) => s.id === source.id);
  if (existing) {
    const where = settings.groups.find((g) => g.id === sourceGroupId(settings, existing));
    setStatus(where && where.id !== config.id ? `That file is already used by the ${where.name} group.` : "That file is already in the list.", "err");
    return;
  }
  if (!(await granted)) {
    setStatus("Allow access to api.github.com to sync Shared links.", "err");
    return;
  }
  settings.sources.push(source);
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
let autoOpened = false; // opened because nothing is set up, which shouldn't count as the user's choice
$("#tutorial").addEventListener("toggle", (e) => {
  if (autoOpened) { autoOpened = false; return; }
  try {
    localStorage.setItem(TUTORIAL_KEY, e.target.open ? "0" : "1");
  } catch {}
});
$("#tutorial-done").addEventListener("click", () => {
  $("#tutorial").open = false;
  $("#tutorial").scrollIntoView({ block: "nearest" });
});

// The steps are banners in a sideways-scrolling track that snaps to each one. The numbered
// buttons, arrows and arrow keys move between them, and swiping or scrolling works too.
const track = $("#tour-track");
const slides = [...track.querySelectorAll(".slide")];
let currentSlide = 0;

const goToSlide = (i) => {
  const index = Math.max(0, Math.min(i, slides.length - 1));
  track.scrollTo({ left: slides[index].offsetLeft - track.offsetLeft });
  showSlide(index);
};

function showSlide(index) {
  currentSlide = index;
  $("#tour-prev").disabled = index === 0;
  $("#tour-next").disabled = index === slides.length - 1;
  $("#tour-dots").querySelectorAll("button").forEach((dot, i) => {
    if (i === index) dot.setAttribute("aria-current", "step");
    else dot.removeAttribute("aria-current");
  });
}

$("#tour-dots").append(
  ...slides.map((slide, i) =>
    el("button", { type: "button", "aria-label": `Step ${i + 1}: ${slide.querySelector("h3").textContent}`,
      onclick: () => goToSlide(i) }, String(i + 1))
  )
);
$("#tour-prev").addEventListener("click", () => goToSlide(currentSlide - 1));
$("#tour-next").addEventListener("click", () => goToSlide(currentSlide + 1));
track.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") { e.preventDefault(); goToSlide(currentSlide + 1); }
  if (e.key === "ArrowLeft") { e.preventDefault(); goToSlide(currentSlide - 1); }
});
// Keep the numbers in step when the user swipes or scrolls the track themselves. This waits
// for the scroll to settle, so the numbers don't flicker back while a step animates into view.
track.addEventListener("scrollend", () => {
  const index = slides.reduce((best, slide, i) =>
    Math.abs(slide.offsetLeft - track.offsetLeft - track.scrollLeft) <
    Math.abs(slides[best].offsetLeft - track.offsetLeft - track.scrollLeft) ? i : best, 0);
  if (index !== currentSlide) showSlide(index);
});
showSlide(0);

// Buttons on the slides jump to the part of the page they describe.
const slideActions = {
  "add-env": () => { $("#add-env").click(); $("#vars-section").scrollIntoView({ block: "start" }); },
  "add-link": () => { $("#add-link").click(); },
  shortcut: () => { chrome.tabs.create({ url: "chrome://extensions/shortcuts" }); },
  sharing: () => { $("#sharing").scrollIntoView({ block: "start" }); $("#source-location").focus({ preventScroll: true }); },
};
// An ⓘ next to a section or setting (data-tutorial-step="5") opens the tutorial at the step about it.
const INFO_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>`;
document.querySelectorAll("[data-tutorial-step]").forEach((link) => (link.innerHTML = INFO_ICON)); // static markup
document.addEventListener("click", (e) => {
  const link = e.target.closest("[data-tutorial-step]");
  if (!link) return;
  e.preventDefault();
  const tutorial = $("#tutorial");
  tutorial.open = true;
  goToSlide(Number(link.dataset.tutorialStep) - 1); // laid out now that it's open
  window.scrollTo({ top: tutorial.getBoundingClientRect().top + window.scrollY - stickyHeight() - 16 });
  slides[currentSlide].querySelector("input, button, a")?.focus({ preventScroll: true });
});

track.addEventListener("click", (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action) slideActions[action]?.();
});

/** With nothing set up yet, the tutorial opens (even if it was hidden before) and says so. */
function updateTutorial(firstRender) {
  const empty = isEmptyConfig(effectiveAll);
  $("#tutorial").classList.toggle("is-empty", empty);
  if (empty && firstRender && !$("#tutorial").open) {
    autoOpened = true;
    $("#tutorial").open = true;
  }
}

// ---- Section links ----------------------------------------------------------

// The sidebar is built from each section's own heading and icon, so it can't drift out of step.
const NAV_TARGETS = [
  ["tutorial", "Tutorial"],
  ["vars-section"],
  ["links-section"],
  ["sharing"],
  ["behaviour"],
  ["import-export"],
];
const navLinks = NAV_TARGETS.map(([id, label]) => {
  const target = document.getElementById(id);
  const heading = target.querySelector("h2, summary");
  const link = el("a", { href: `#${id}` });
  const icon = heading.querySelector(".h-icon")?.cloneNode(true);
  if (icon) link.append(icon);
  link.append(label || heading.textContent.trim());
  link.addEventListener("click", (e) => {
    e.preventDefault();
    if (target.tagName === "DETAILS") target.open = true;
    // Measured now rather than read from CSS, so it's right even before a resize has been noticed.
    // Sections under the group tabs also clear the tabs, which stick below the header.
    const tabs = target.closest(".group-panel") ? $(".group-bar").offsetHeight : 0;
    window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - stickyHeight() - tabs - 16 });
    history.replaceState(null, "", `#${id}`);
    markSection(id);
  });
  return { id, target, link };
});
$("#side-nav").append(...navLinks.map((n) => n.link));

const sideNav = $("#side-nav");
const narrowLayout = matchMedia("(max-width: 900px)");

function markSection(id) {
  let active;
  navLinks.forEach((n) => {
    n.link.setAttribute("aria-current", String(n.id === id));
    if (n.id === id) active = n.link;
  });
  // In the narrow layout the links are a sideways-scrolling row; keep the current one visible.
  if (narrowLayout.matches && active) {
    const { offsetLeft, offsetWidth } = active;
    if (offsetLeft < sideNav.scrollLeft || offsetLeft + offsetWidth > sideNav.scrollLeft + sideNav.clientWidth) {
      sideNav.scrollTo({ left: offsetLeft - 8 });
    }
  }
}

// The header is sticky and its height changes with the window width; the sidebar and the
// scroll positions both need it.
// In the narrow layout the row of links is sticky too, so it's added to the offset.
const header = $(".top");
const stickyHeight = () => header.offsetHeight + (narrowLayout.matches ? sideNav.offsetHeight : 0);
const setHeaderHeight = () => {
  document.documentElement.style.setProperty("--header-h", `${header.offsetHeight}px`);
  document.documentElement.style.setProperty("--nav-h", `${narrowLayout.matches ? sideNav.offsetHeight : 0}px`);
};
const resizeWatch = new ResizeObserver(setHeaderHeight);
resizeWatch.observe(header);
resizeWatch.observe(sideNav);
narrowLayout.addEventListener("change", setHeaderHeight);
setHeaderHeight();

// Highlight the section being read: the last one whose top has passed under the header.
function currentSection() {
  const line = stickyHeight() + $(".group-bar").offsetHeight + 60;
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
    return navLinks[navLinks.length - 1].id; // at the very bottom, the last section is the one in view
  }
  let current = navLinks[0].id;
  for (const n of navLinks) if (n.target.getBoundingClientRect().top <= line) current = n.id;
  return current;
}
// Six sections, so it's cheap enough to check on every scroll event.
let lastSection;
window.addEventListener("scroll", () => {
  const id = currentSection();
  if (id !== lastSection) { lastSection = id; markSection(id); }
}, { passive: true });
markSection(currentSection());

// ---- Keyboard shortcut ------------------------------------------------------

// The shortcut that opens the toolbar list is a Chrome "command". Extensions can't change it
// themselves; users pick it on Chrome's own shortcuts page, so show it and link there.
async function showPopupShortcut() {
  let shortcut = "";
  try {
    const commands = await chrome.commands.getAll();
    shortcut = commands.find((c) => c.name === "_execute_action")?.shortcut || "";
  } catch {}
  document.querySelectorAll(".popup-shortcut").forEach((k) => {
    k.textContent = shortcut || "Not set";
    k.classList.toggle("unset", !shortcut);
  });
  // Keycaps in the tutorial and under Behaviour: "⇧⌘E" on a Mac is one character per key,
  // "Ctrl+Shift+E" elsewhere.
  const keys = shortcut ? (shortcut.includes("+") ? shortcut.split("+") : [...shortcut]) : [];
  document.querySelectorAll(".mt-keys, .popup-keycaps").forEach((box) => {
    if (keys.length) box.replaceChildren(...keys.map((key) => el("kbd", {}, key)));
    else if (box.classList.contains("popup-keycaps")) box.replaceChildren(el("kbd", { class: "unset" }, "Not set"));
  });
  document.querySelectorAll(".popup-keycaps").forEach((box) =>
    box.setAttribute("aria-label", shortcut ? `Shortcut ${shortcut}` : "No shortcut set"));
}

$("#change-shortcut").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});
// Pick up a change made on the shortcuts page when the user comes back to this tab.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") showPopupShortcut();
});
showPopupShortcut();

// ---- Footer ---------------------------------------------------------------

const STORE_URL = "https://chromewebstore.google.com/detail/ggliopecghngikmibollhhljadddnbic";

// Use the system share sheet where Chrome has one; otherwise copy the store link.
$("#share").addEventListener("click", async () => {
  const data = {
    title: "Environment Links",
    text: "Open the same link in every environment from Chrome's address bar.",
    url: STORE_URL,
  };
  try {
    if (navigator.share && navigator.canShare?.(data)) {
      await navigator.share(data);
      return;
    }
  } catch (err) {
    if (err.name === "AbortError") return; // the user closed the share sheet
  }
  try {
    await navigator.clipboard.writeText(STORE_URL);
    setStatus("Chrome Web Store link copied", "ok");
  } catch {
    setStatus(`Share this link: ${STORE_URL}`, "ok");
  }
});

// ---- Wiring ---------------------------------------------------------------

let rendered = false;

function render() {
  recompute();
  const keyword = chrome.runtime.getManifest().omnibox?.keyword ?? "";
  document.querySelectorAll(".keyword").forEach((k) => (k.textContent = keyword));
  updateTutorial(!rendered);
  rendered = true;
  renderGroups();
  renderVars();
  renderLinks();
  renderSources();
  renderShareBuilder();
  $("#open-in").value = settings.openIn;
  showGroupTabs();
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
  openLink = link; // a new link opens straight away, with the others closed
  restructured();
  const inputs = document.querySelectorAll("#links .link-row input:first-of-type");
  inputs[inputs.length - 1]?.focus();
});

$("#open-in").addEventListener("change", (e) => { settings.openIn = e.target.value; scheduleSave(); });

// Grouping tabs is a setting of each environment group. It needs the optional "tabGroups"
// permission, asked for when it's turned on (Chrome only shows the prompt during a click, so the
// request comes first) and given back once no group uses it. There are two tickboxes for the group
// being edited, under Environments and in the tutorial; they stay in step.
const groupTabBoxes = () => document.querySelectorAll(".group-tabs-input");
const tickGroupTabs = (on) => groupTabBoxes().forEach((box) => (box.checked = on));
groupTabBoxes().forEach((box) => box.addEventListener("change", async (e) => {
  tickGroupTabs(e.target.checked);
  if (e.target.checked) {
    const granted = await chrome.permissions.request(GROUP_PERMISSION).catch(() => false);
    if (!granted) {
      tickGroupTabs(false);
      return setStatus("Tab groups need Chrome's permission to manage tab groups.", "err");
    }
    config.groupTabs = true;
    await saveNow(); // save first, so "Saved" doesn't replace the message below
    setStatus(settings.groups.length > 1
      ? `${config.name}'s links will open in a tab group per environment`
      : "New links will open in a tab group per environment", "ok");
  } else {
    config.groupTabs = false;
    if (!settings.groups.some((g) => g.groupTabs)) chrome.permissions.remove(GROUP_PERMISSION).catch(() => {});
    await saveNow();
  }
}));

/** Ticked only when the setting is on and Chrome still has the permission. */
async function showGroupTabs() {
  const granted = await chrome.permissions.contains(GROUP_PERMISSION).catch(() => false);
  tickGroupTabs(config.groupTabs && granted);
}

$("#export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(exportSettings(settings), null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  el("a", { href: url, download: `environment-links-${date}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus("Exported", "ok");
});

async function importJson(text, from) {
  try {
    const imported = importSettings(JSON.parse(text)); // checks the format before asking
    if (!confirm(`Replace all your groups, environments, variables and links with ${from}?`)) return;
    settings = imported;
    openLink = null;
    render();
    await saveNow(); // save first, so "Saved" doesn't replace the message below
    await forgetRemovedSources(settings);
    setStatus("Imported", "ok");
  } catch (err) {
    setStatus(`Import failed: ${err.message}`, "err");
  }
}

$("#import").addEventListener("click", () => importJson($("#json").value, "this JSON"));

// Dropping a file onto the import box opens it there, to check before importing.
const MAX_IMPORT_BYTES = 1024 * 1024;
const dropZone = $("#json-drop");
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
let dragDepth = 0; // dragenter/dragleave also fire for the box's children
dropZone.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropZone.classList.add("over");
});
dropZone.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
dropZone.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; dropZone.classList.remove("over"); }
});
dropZone.addEventListener("drop", async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropZone.classList.remove("over");
  const [file] = e.dataTransfer.files;
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) return setStatus(`${file.name} is too large to be a settings file.`, "err");
  const text = await file.text();
  try {
    JSON.parse(text);
  } catch {
    return setStatus(`${file.name} isn't a JSON file.`, "err");
  }
  $("#json").value = text;
  $("#json").focus();
  setStatus(`Opened ${file.name}. Check it, then click Import from text.`, "ok");
});
// A file dropped just outside the box shouldn't make Chrome open it in place of the settings page.
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => { if (hasFiles(e)) e.preventDefault(); });

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
  if (JSON.stringify(incoming) === JSON.stringify(settings)) return; // our own save
  if (busy) return;
  settings = incoming;
  render();
});

// Icons before the text of the page's fixed buttons. A leading "+ " is dropped where the plus icon
// replaces it.
const PLUS_ICON = `<path d="M12 5v14"/><path d="M5 12h14"/>`;
const BUTTON_ICONS = [
  ["#add-group, #add-var, #add-env, #add-link, #add-source button[type=submit], .slide-cta[data-action^='add-']", PLUS_ICON],
  ["#share-copy", `<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>`],
  ["#change-shortcut, .slide-cta[data-action='shortcut']",
    `<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>`],
  [".slide-cta[data-action='sharing']", `<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>`],
  ["#tutorial-done", `<path d="M20 6 9 17l-5-5"/>`],
  ["#export", `<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>`],
  ["#import", `<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/>`],
];
for (const [selector, icon] of BUTTON_ICONS) {
  document.querySelectorAll(selector).forEach((button) => {
    const label = button.textContent.trim().replace(/^\+\s*/, "");
    button.replaceChildren(buttonIcon(icon), label);
  });
}

(async () => {
  const stored = await chrome.storage.sync.get(CONFIG_KEY);
  settings = normalizeConfig(stored[CONFIG_KEY] || structuredClone(DEFAULT_CONFIG));
  if (!stored[CONFIG_KEY] || !Array.isArray(stored[CONFIG_KEY].groups)) {
    await chrome.storage.sync.set({ [CONFIG_KEY]: settings }); // first run, or a config from before groups
  }
  [cache, tokens] = await Promise.all([loadCache(), loadTokens()]);
  render();
})();
