"use strict";

const mqMobile = window.matchMedia("(max-width: 820px)");
const mqDark = window.matchMedia("(prefers-color-scheme: dark)");
const state = { tabs: [], activeId: null };
const restartRequests = new Map();
let interruptPending = false;
const RECENT_SESSION_LIMIT = 10;
let recentSessionIds = readRecentSessionIds();
let recentSwitchBusy = false;
let startupRestoreTried = false;
const TERMINAL_FONT_FAMILY = '"CC JetBrains Mono", "CC Terminal Mono", "CC Terminal Symbols", "Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, "Segoe UI Symbol", "Segoe UI Emoji", "Microsoft YaHei UI", monospace';

// ---- auth / api ------------------------------------------------------------
let tokenPromptOpen = false;
function getToken() { return localStorage.getItem("cc_token") || ""; }
function setTokenPrompt() {
  if (tokenPromptOpen) return;  // one login only; ignore stale 401s
  tokenPromptOpen = true;
  showLogin();
}
function hideLogin() {
  closeLayer(document.getElementById("login"));
  document.body.classList.remove("login-open");
  tokenPromptOpen = false;
}
function showLogin() {
  const el = document.getElementById("login");
  const input = document.getElementById("login-input");
  const hint = document.getElementById("login-hint");
  openLayer(el);
  document.body.classList.add("login-open");
  input.value = "";
  document.getElementById("login-go").style.opacity = "0";
  if (sessionStorage.getItem("cc_login_tried")) {
    sessionStorage.removeItem("cc_login_tried");
    hint.textContent = "Token 不正确，请重试"; hint.classList.add("err");
    el.classList.add("shake"); setTimeout(() => el.classList.remove("shake"), 500);
  } else {
    hint.textContent = "输入 Token 后按回车"; hint.classList.remove("err");
  }
  setTimeout(() => input.focus(), 60);
}
(function initLogin() {
  const input = document.getElementById("login-input");
  const go = document.getElementById("login-go");
  if (!input) return;
  input.addEventListener("input", () => { go.style.opacity = input.value ? "1" : "0"; });
  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    go.disabled = true;
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: v }),
      });
      if (!r.ok) throw new Error("Token 不正确，请重试");
      localStorage.removeItem("cc_token");
      sessionStorage.removeItem("cc_login_tried");
      hideLogin();
      await loadConfig();
      await loadTabs();
      heartbeat();
    } catch (err) {
      const hint = document.getElementById("login-hint");
      hint.textContent = err.message || "Token 不正确，请重试"; hint.classList.add("err");
      document.getElementById("login").classList.add("shake");
      setTimeout(() => document.getElementById("login").classList.remove("shake"), 500);
    } finally {
      go.disabled = false;
    }
  });
  document.addEventListener("keydown", (e) => {
    const el = document.getElementById("login");
    if (e.key === "Escape" && !el.classList.contains("hidden")) hideLogin();
  });
})();
async function api(path, opts = {}, _retries) {
  const method = (opts.method || "GET").toUpperCase();
  if (_retries === undefined) _retries = method === "GET" ? 3 : 0;  // retry idempotent GETs
  const headers = Object.assign({}, opts.headers || {});
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const legacyToken = getToken();
  if (legacyToken && !headers.Authorization) headers.Authorization = "Bearer " + legacyToken;
  let r;
  try {
    r = await fetch(path, Object.assign({}, opts, { headers, credentials: "same-origin" }));
  } catch (e) {
    if (_retries > 0) { await new Promise((res) => setTimeout(res, 600)); return api(path, opts, _retries - 1); }
    throw e;  // network-level failure (TypeError) after retries
  }
  if (r.status === 401) { setTokenPrompt(); throw new Error("需要有效 Token"); }
  if (!r.ok) {
    let msg = r.statusText;
    const body = await r.text();
    if (body) { try { msg = JSON.parse(body).detail || body; } catch (_) { msg = body; } }
    throw new Error(msg);
  }
  const ct = r.headers.get("content-type") || "";
  return ct.includes("json") ? r.json() : r.text();
}
function wsUrl(p) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + location.host + p;
}
function esc(s) { return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
const uiIconCache = new Map();
function uiIcon(name) {
  if (uiIconCache.has(name)) return uiIconCache.get(name);
  const library = window.lucide;
  if (!library || !library.icons[name]) return "";
  const svg = library.createElement(library.icons[name], {
    class: "ui-icon", width: 16, height: 16, "stroke-width": 1.65,
    "aria-hidden": "true", focusable: "false",
  }).outerHTML;
  uiIconCache.set(name, svg);
  return svg;
}
function setCommandIcon(button, name, label) {
  if (typeof button === "string") button = document.getElementById(button);
  if (!button) return;
  const svg = uiIcon(name);
  if (!svg) return;
  if (label || !button.hasAttribute("aria-label")) button.setAttribute("aria-label", label || button.title || button.textContent.trim());
  button.innerHTML = svg + (label ? '<span>' + esc(label) + '</span>' : "");
}
const GLYPH_ICONS = {
  "✎": "Pencil", "⤴": "FolderInput", "■": "Square", "▷": "Play", "⌫": "Trash2",
  "⬇": "Download", "⇄": "ArrowLeftRight", "✕": "X", "↑": "ArrowUp", "↓": "ArrowDown",
  "←": "ArrowLeft", "→": "ArrowRight", "↵": "CornerDownLeft",
};
function initialiseCommandIcons() {
  document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = uiIcon(el.dataset.icon); });
  const commands = {
    "btn-sidebar": "PanelLeft", hamburger: "PanelLeft", "btn-files": "FolderOpen",
    "btn-files-m": "FolderOpen", "btn-gpu": "Activity", "btn-gpu-m": "Activity",
    "tl-green": "Maximize", "btn-fs": "Maximize", "new-group": "FolderPlus",
    "btn-select": "TextSelect", "btn-copy": "Copy", "btn-img": "ImagePlus",
    "btn-split": "PanelsTopLeft", "btn-dir": "Columns2", "btn-kbd": "Keyboard",
    "btn-aux": "Command", "btn-interrupt": "CirclePause", "btn-stop": "Square", "btn-restart": "RotateCw", "size-dn": "Minus", "size-up": "Plus",
    "dir-close": "X", "img-close": "X", "gpu-close": "X", "ips-close": "X",
    "files-close": "X", "files-reload": "RefreshCw", "fv-close": "ArrowLeft",
    "fv-prev": "ChevronLeft", "fv-next": "ChevronRight", "login-go": "ArrowRight",
  };
  Object.entries(commands).forEach(([id, name]) => setCommandIcon(id, name));
  [
    ["new-term", "Plus", "新终端"], ["empty-new", "Plus", "新终端"],
    ["set-token", "KeyRound", "Token"], ["refresh", "RefreshCw", "刷新"],
    ["dir-mkdir", "FolderPlus", "新建文件夹"], ["dir-touch", "FilePlus2", "新建文件"],
    ["dir-upload", "Upload", "上传文件"], ["gpu-reload", "RefreshCw", "刷新"],
    ["files-up", "ArrowUp", "上级"], ["files-home", "House", "常用目录"],
    ["tab-gpu", "Cpu", "显卡"], ["tab-disk", "HardDrive", "存储"],
    ["ips-open", "Users", "IP 记录 / 熟人名单"], ["fv-dl", "Download", "下载"],
  ].forEach(([id, name, label]) => setCommandIcon(id, name, label));
}
initialiseCommandIcons();

function keyboardClickable(el, action, label) {
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  if (label) el.setAttribute("aria-label", label);
  el.addEventListener("keydown", (e) => {
    if (e.target !== el || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    action();
  });
}

const layerTimers = new WeakMap();
function motionOff() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}
function clearLayerTimer(el) {
  const timer = layerTimers.get(el);
  if (timer) clearTimeout(timer);
  layerTimers.delete(el);
}
function layerOpen(el) {
  return !!el && !el.classList.contains("hidden") && !el.classList.contains("is-closing");
}
function openLayer(el, restoreFocus) {
  if (!el) return;
  clearLayerTimer(el);
  if (restoreFocus && el.classList.contains("hidden")) el.__ccReturnFocus = document.activeElement;
  el.classList.remove("hidden", "is-closing");
  el.classList.add("is-opening");
  const timer = setTimeout(() => {
    el.classList.remove("is-opening");
    layerTimers.delete(el);
  }, motionOff() ? 0 : 220);
  layerTimers.set(el, timer);
}
function closeLayer(el, after) {
  if (!el || el.classList.contains("hidden")) { if (after) after(); return; }
  clearLayerTimer(el);
  const finish = () => {
    el.classList.add("hidden");
    el.classList.remove("is-opening", "is-closing");
    layerTimers.delete(el);
    if (after) after();
    const returnFocus = el.__ccReturnFocus;
    delete el.__ccReturnFocus;
    if (returnFocus && returnFocus.isConnected) {
      try { returnFocus.focus({ preventScroll: true }); } catch (e) {}
    }
  };
  if (motionOff()) { finish(); return; }
  el.classList.remove("is-opening");
  el.classList.add("is-closing");
  layerTimers.set(el, setTimeout(finish, 150));
}
function setButtonBusy(button, busy) {
  if (!button) return;
  if (busy) {
    button.dataset.ccWidth = button.style.width || "";
    button.style.width = button.getBoundingClientRect().width + "px";
    button.disabled = true;
    button.classList.add("btn-pending");
    button.setAttribute("aria-busy", "true");
  } else {
    button.disabled = false;
    button.classList.remove("btn-pending");
    button.removeAttribute("aria-busy");
    button.style.width = button.dataset.ccWidth || "";
    delete button.dataset.ccWidth;
  }
}

// Fluent-style tooltips for icon-only commands. Native titles are promoted on
// first use so the tooltip can be positioned inside the viewport.
const tooltip = document.getElementById("tooltip");
const TOOLTIP_TARGETS = ".tb-btn,.hdr-btn,.icon-btn,.ws-icon,.mini,.icon-btn-sm,.group-rename,.group-del,.pane-x,.pane-swap,.pane-restart,.toolbar-btn[aria-label]";
let tooltipTimer = null;
let tooltipOwner = null;
let keyboardNavigation = false;
function tooltipInfo(el) {
  if (!el || !el.matches(TOOLTIP_TARGETS)) return "";
  const latest = el.getAttribute("title");
  if (latest) {
    el.dataset.tooltip = latest;
    el.removeAttribute("title");
  }
  return el.dataset.tooltip || el.getAttribute("aria-label") || "";
}
function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltipTimer = null;
  tooltipOwner = null;
  if (tooltip) tooltip.classList.add("hidden");
}
function placeTooltip(owner) {
  if (!tooltip || !owner || !owner.isConnected) return;
  const label = tooltipInfo(owner);
  if (!label) return;
  tooltip.textContent = label;
  openLayer(tooltip);
  requestAnimationFrame(() => {
    if (owner !== tooltipOwner) return;
    const r = owner.getBoundingClientRect();
    const tr = tooltip.getBoundingClientRect();
    let left = r.left + (r.width - tr.width) / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
    let top = r.bottom + 7;
    if (top + tr.height > window.innerHeight - 8) top = r.top - tr.height - 7;
    tooltip.style.left = Math.round(left) + "px";
    tooltip.style.top = Math.round(Math.max(8, top)) + "px";
  });
}
function queueTooltip(owner, keyboard) {
  const label = tooltipInfo(owner);
  if (!label || (!keyboard && !window.matchMedia("(hover: hover)").matches)) return;
  if (tooltipOwner === owner && !tooltip.classList.contains("hidden")) return;
  hideTooltip();
  tooltipOwner = owner;
  tooltipTimer = setTimeout(() => placeTooltip(owner), keyboard ? 250 : 480);
}
document.addEventListener("pointerover", (e) => {
  const owner = e.target.closest && e.target.closest(TOOLTIP_TARGETS);
  if (owner) queueTooltip(owner, false);
});
document.addEventListener("pointerout", (e) => {
  if (!tooltipOwner) return;
  if (e.relatedTarget && tooltipOwner.contains(e.relatedTarget)) return;
  hideTooltip();
});
document.addEventListener("focusin", (e) => {
  const owner = e.target.closest && e.target.closest(TOOLTIP_TARGETS);
  if (owner && keyboardNavigation) queueTooltip(owner, true);
});
document.addEventListener("focusout", hideTooltip);
document.addEventListener("pointerdown", () => { keyboardNavigation = false; hideTooltip(); }, true);
document.addEventListener("wheel", hideTooltip, { passive: true, capture: true });
document.addEventListener("keydown", (e) => {
  if (e.key === "Tab" || e.key.startsWith("Arrow")) keyboardNavigation = true;
  if (e.key === "Escape" || e.key === "Control") hideTooltip();
});

// Keep keyboard focus inside the uppermost modal surface.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const layers = Array.from(document.querySelectorAll(
    '.modal:not(.hidden):not(.is-closing),.ui-dialog-backdrop:not(.hidden):not(.is-closing),.login:not(.hidden):not(.is-closing)'
  ));
  const layer = layers[layers.length - 1];
  if (!layer) return;
  const focusable = Array.from(layer.querySelectorAll(
    'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])'
  )).filter((el) => el.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && (document.activeElement === first || !layer.contains(document.activeElement))) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !layer.contains(document.activeElement))) {
    e.preventDefault(); first.focus();
  }
});

// ---- toast -----------------------------------------------------------------
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; openLayer(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => closeLayer(t), 3800);
}

// ---- workspace dialogs (replace native prompt / confirm) ------------------
function uiDialog(opts) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "ui-dialog-backdrop hidden";
    const box = document.createElement("div");
    box.className = "ui-dialog";
    box.innerHTML =
      '<div class="ui-dialog-icon"></div><div class="ui-dialog-title"></div><div class="ui-dialog-msg"></div>' +
      (opts.input ? '<input class="ui-dialog-input" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" />' : "") +
      '<div class="ui-dialog-btns"></div>';
    box.querySelector(".ui-dialog-icon").textContent = opts.icon || "i";
    box.querySelector(".ui-dialog-title").textContent = opts.title || "";
    const msgEl = box.querySelector(".ui-dialog-msg");
    if (opts.message) msgEl.textContent = opts.message; else msgEl.remove();
    const input = opts.input ? box.querySelector(".ui-dialog-input") : null;
    if (input) input.value = opts.defaultValue || "";
    const btns = box.querySelector(".ui-dialog-btns");
    const cancel = document.createElement("button");
    cancel.className = "ui-btn"; cancel.textContent = opts.cancelLabel || "取消";
    const ok = document.createElement("button");
    ok.className = "ui-btn primary" + (opts.destructive ? " danger" : ""); ok.textContent = opts.okLabel || "好";
    let settling = false;
    function done(val) {
      if (settling) return;
      settling = true;
      document.removeEventListener("keydown", onKey);
      closeLayer(back, () => { back.remove(); resolve(val); });
    }
    cancel.onclick = () => done(opts.input ? null : false);
    ok.onclick = () => done(opts.input ? (input ? input.value : "") : true);
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); cancel.onclick(); }
      else if (e.key === "Enter") { e.preventDefault(); ok.onclick(); }
    }
    btns.appendChild(cancel); btns.appendChild(ok);
    back.appendChild(box); document.body.appendChild(back); openLayer(back, true);
    back.onclick = (e) => { if (e.target === back) cancel.onclick(); };
    document.addEventListener("keydown", onKey);
    setTimeout(() => { if (input) { input.focus(); input.select(); } else ok.focus(); }, 30);
  });
}
function uiPrompt(title, defaultValue, icon) { return uiDialog({ title, input: true, defaultValue, okLabel: "确定", icon: icon || "✎" }); }
function uiConfirm(title, message, destructive) { return uiDialog({ title, message, okLabel: destructive ? "删除" : "确定", destructive, icon: destructive ? "!" : "?" }); }

// ---- drawer ----------------------------------------------------------------
const body = document.body;
function setDrawer(open) {
  if (open) { closeRecentSessions(false); closeQuickCommands(false); }
  body.classList.toggle("drawer-open", open);
  document.getElementById("hamburger").setAttribute("aria-expanded", String(open));
}
function closeDrawer() { setDrawer(false); }
document.getElementById("hamburger").onclick = () => setDrawer(!body.classList.contains("drawer-open"));
document.getElementById("scrim").onclick = closeDrawer;

// ---- tab list (the "chats") ------------------------------------------------
let tabsLoadSeq = 0;
async function loadTabs() {
  const seq = ++tabsLoadSeq;
  let data;
  try { data = await api("/api/sessions"); } catch (e) { return; }
  if (seq !== tabsLoadSeq) return;
  state.tabs = data.sessions || [];
  state.sessionsLoaded = true;
  recentSessionIds = recentSessionIds.filter(id => state.tabs.some(tab => tab.id === id));
  persistRecentSessions();
  state.groups = data.groups || {};
  state.manualGroups = data.manualGroups || [];
  for (const pane of panes) {
    const tab = pane.tab && state.tabs.find(t => t.id === pane.tab.id);
    if (tab) pane.tab = tab;
  }
  renderTabs();
  updateRestartControls();
  maybeRestoreActiveTab();
  window.ccWorkspace?.sessionsChanged();
  window.ccNativeInput?.sync();
}
function mini(label, cls, onclick, title) {
  const b = document.createElement("button");
  b.className = "mini" + (cls ? " " + cls : "");
  b.textContent = label;
  if (title) { b.title = title; b.setAttribute("aria-label", title); }
  if (GLYPH_ICONS[label]) setCommandIcon(b, GLYPH_ICONS[label]);
  b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
}
function tabBasename(p) { if (!p) return "?"; const s = p.replace(/\/+$/, "").split("/"); return s[s.length - 1] || p; }
function getCollapsed() { try { return JSON.parse(localStorage.getItem("cc_collapsed") || "{}"); } catch (e) { return {}; } }
function toggleCollapsed(cwd) { const c = getCollapsed(); c[cwd] = !c[cwd]; localStorage.setItem("cc_collapsed", JSON.stringify(c)); }
function tabName(t) { return t.name || ("cc_" + t.id); }
function typeLabel(ty) { return ty === "opencode" ? "OpenCode" : ty === "codex" ? "Codex" : ty === "shell" ? "终端" : "Claude"; }
function saveActiveId(id) {
  if (!id) return;
  localStorage.setItem("cc_active_id", id);
  recentSessionIds = [id, ...recentSessionIds.filter(previous => previous !== id)].slice(0, RECENT_SESSION_LIMIT);
  persistRecentSessions();
}

function readRecentSessionIds() {
  try {
    const value = JSON.parse(localStorage.getItem("cc_recent_sessions") || "[]");
    return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === "string" && id.length <= 128))].slice(0, RECENT_SESSION_LIMIT) : [];
  } catch (_) { return []; }
}
function persistRecentSessions() {
  try { localStorage.setItem("cc_recent_sessions", JSON.stringify(recentSessionIds)); } catch (_) {}
}
function recentTabs() {
  const tabs = state.tabs || [];
  const ids = [...new Set([state.activeId, ...recentSessionIds, ...tabs.filter(tab => tab.alive).map(tab => tab.id), ...tabs.map(tab => tab.id)])];
  return ids.map(id => tabs.find(tab => tab.id === id)).filter(Boolean).slice(0, RECENT_SESSION_LIMIT);
}
function renderRecentSessions() {
  const list = document.getElementById("recent-list");
  const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.sessionId : null;
  list.replaceChildren();
  list.setAttribute("aria-busy", String(recentSwitchBusy));
  const tabs = recentTabs();
  if (!tabs.length) {
    const empty = document.createElement("div");
    empty.className = "recent-empty";
    empty.textContent = "暂无会话";
    list.appendChild(empty);
  }
  for (const tab of tabs) {
    const button = document.createElement("button");
    const selected = tab.id === state.activeId;
    button.className = "recent-row" + (selected ? " selected" : "");
    button.dataset.sessionId = tab.id;
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(selected));
    button.setAttribute("aria-label", tabName(tab) + "，" + typeLabel(tab.type) + "，" + (tab.alive ? "运行中" : "已停止，点击重启"));
    button.disabled = recentSwitchBusy;
    button.innerHTML = '<span class="status-dot ' + (tab.alive ? "green" : "grey") + '"></span><span class="recent-meta"><span class="recent-name"></span><span class="recent-detail"></span></span><span class="recent-check" aria-hidden="true"></span>';
    button.querySelector(".recent-name").textContent = tabName(tab);
    button.querySelector(".recent-detail").textContent = typeLabel(tab.type) + " · " + tabBasename(tab.cwd) + (tab.alive ? "" : " · 已停止");
    button.querySelector(".recent-check").innerHTML = selected ? uiIcon("Check") : "";
    button.onclick = async () => {
      if (recentSwitchBusy) return;
      recentSwitchBusy = true;
      renderRecentSessions();
      try { if (await openTab(tab)) closeRecentSessions(false); }
      finally { recentSwitchBusy = false; renderRecentSessions(); }
    };
    list.appendChild(button);
  }
  if (focusedId && !recentSwitchBusy && layerOpen(document.getElementById("recent-sessions"))) {
    const row = Array.from(list.children).find(button => button.dataset.sessionId === focusedId);
    (row || list.querySelector("button") || document.getElementById("recent-close")).focus({ preventScroll: true });
  }
}
function closeRecentSessions(restoreFocus = true) {
  const menu = document.getElementById("recent-sessions");
  const wasOpen = layerOpen(menu);
  menu.classList.add("hidden");
  document.getElementById("recent-toggle").setAttribute("aria-expanded", "false");
  if (wasOpen && restoreFocus) document.getElementById("recent-toggle").focus({ preventScroll: true });
}
document.getElementById("recent-toggle").onclick = () => {
  const menu = document.getElementById("recent-sessions");
  if (layerOpen(menu)) { closeRecentSessions(); return; }
  closeQuickCommands(false);
  closeDrawer();
  renderRecentSessions();
  menu.classList.remove("hidden");
  document.getElementById("recent-toggle").setAttribute("aria-expanded", "true");
  (menu.querySelector('[aria-checked="true"]') || menu.querySelector(".recent-row") || document.getElementById("recent-close")).focus({ preventScroll: true });
};
document.getElementById("recent-close").onclick = () => closeRecentSessions();
document.addEventListener("pointerdown", event => {
  const menu = document.getElementById("recent-sessions");
  if (recentSwitchBusy && event.target.closest(".ui-dialog-backdrop")) return;
  if (layerOpen(menu) && !menu.contains(event.target) && !document.getElementById("recent-toggle").contains(event.target)) closeRecentSessions(false);
}, true);
document.addEventListener("keydown", event => {
  const menu = document.getElementById("recent-sessions");
  if (!layerOpen(menu)) return;
  if (recentSwitchBusy && document.querySelector(".ui-dialog-backdrop:not(.hidden)")) return;
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRecentSessions(); return; }
  if (event.key === "Tab") { closeRecentSessions(); return; }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const buttons = Array.from(menu.querySelectorAll(".recent-row:not(:disabled)"));
  if (!buttons.length) return;
  event.preventDefault();
  event.stopPropagation();
  const current = buttons.indexOf(document.activeElement);
  const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
    (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
  buttons[index].focus();
}, true);
mqMobile.addEventListener("change", () => closeRecentSessions(false));
function maybeRestoreActiveTab() {
  if (startupRestoreTried || panes.length || tokenPromptOpen) return;
  const alive = (state.tabs || []).filter((t) => t.alive);
  if (!alive.length) return;
  startupRestoreTried = true;
  const saved = localStorage.getItem("cc_active_id") || "";
  // Restore the whole split layout, not just one terminal.
  let ids = [];
  try { ids = JSON.parse(localStorage.getItem("cc_panes") || "[]"); } catch (e) {}
  const restore = ids.map((id) => alive.find((t) => t.id === id)).filter(Boolean).slice(0, MAX_PANES);
  if (restore.length > 1) {
    restore.forEach((t, i) => attachTerminal(t, i === 0 ? null : makePane()));
    const focus = paneOfTab(saved) || panes[0];
    focusPane(focus);
  } else {
    const tab = alive.find((t) => t.id === saved) || alive[0];
    state.activeId = tab.id;
    attachTerminal(tab);
  }
  renderTabs();
}

function chatItem(t) {
  const item = document.createElement("div");
  item.className = "chat-item" + (t.alive ? "" : " stopped") + (t.id === state.activeId ? " active" : "");
  item.innerHTML =
    '<span class="status-dot ' + (t.alive ? "green" : "grey") + '"></span>' +
    '<div class="chat-meta"><div class="chat-title"></div><div class="chat-sub"></div></div>' +
    '<div class="chat-actions"></div>';
  item.querySelector(".chat-title").textContent = tabName(t);
  item.querySelector(".chat-sub").textContent = typeLabel(t.type) + " · " + (t.alive ? (t.attached > 0 ? "在线" : "后台运行") : "已停止");
  item.title = "cc_" + t.id + " · " + (t.cwd || "");
  const actions = item.querySelector(".chat-actions");
  actions.appendChild(mini("✎", "", () => renameTab(t), "改名"));
  actions.appendChild(mini("⤴", "", () => moveTab(t), "移动到分组"));
  if (["codex", "claude", "opencode"].includes(t.resumeAgent || t.type)) {
    const restart = mini("", "", () => requestRestartTab(t), "重启并恢复原会话");
    setCommandIcon(restart, "RotateCw");
    restart.disabled = restartRequests.has(t.id);
    actions.appendChild(restart);
  }
  if (t.alive) {
    const stop = mini("■", "danger", () => requestStopTab(t), "停止");
    stop.disabled = restartRequests.has(t.id);
    actions.appendChild(stop);
  }
  else { actions.appendChild(mini("▷", "", () => openTab(t), "重启")); actions.appendChild(mini("⌫", "danger", () => deleteTab(t.id), "删除")); }
  item.onclick = () => openTab(t);
  keyboardClickable(item, () => openTab(t), "打开终端 " + tabName(t));
  return item;
}

function groupBox(key, headHTML, items, headWire, emptyHint) {
  const collapsed = getCollapsed();
  const isCol = !!collapsed[key];
  const g = document.createElement("div"); g.className = "chat-group";
  const head = document.createElement("div"); head.className = "group-head" + (isCol ? " collapsed" : "") + (key[0] === "m" ? " manual" : "");
  head.innerHTML = headHTML;
  head.querySelectorAll(".group-rename").forEach(b => setCommandIcon(b, "Pencil"));
  head.querySelectorAll(".group-del").forEach(b => setCommandIcon(b, "Trash2"));
  head.querySelector(".group-count").textContent = items.length;
  head.setAttribute("aria-expanded", String(!isCol));
  headWire(head);
  head.addEventListener("click", () => { toggleCollapsed(key); renderTabs(); });
  keyboardClickable(head, () => { toggleCollapsed(key); renderTabs(); }, "展开或收起终端分组");
  g.appendChild(head);
  if (!isCol) {
    if (!items.length && emptyHint) { const e = document.createElement("div"); e.className = "group-empty"; e.textContent = emptyHint; g.appendChild(e); }
    items.forEach((t) => g.appendChild(chatItem(t)));
  }
  return g;
}

function renderTabs() {
  renderRecentSessions();
  const list = document.getElementById("chat-list");
  list.innerHTML = "";
  const query = document.getElementById("session-search").value.trim().toLowerCase();
  const tabs = (state.tabs || []).filter(t => !query || [t.name, t.id, t.cwd, typeLabel(t.type)].some(value => String(value || "").toLowerCase().includes(query))), manual = state.manualGroups || [];
  if (!tabs.length && !manual.length) {
    list.innerHTML = '<div class="chat-empty">还没有终端<br>点上面「＋ 新终端」开始</div>';
    return;
  }
  // partition: assigned to a manual group vs auto-grouped by cwd
  const byManual = {}; manual.forEach((m) => (byManual[m] = []));
  const auto = {}, autoOrder = [];
  tabs.forEach((t) => {
    if (t.group && manual.indexOf(t.group) !== -1) { byManual[t.group].push(t); }
    else { const k = t.cwd || "?"; if (!auto[k]) { auto[k] = []; autoOrder.push(k); } auto[k].push(t); }
  });

  manual.forEach((name) => {
    const html = '<span class="group-caret">▾</span><span class="group-icon">▣</span><span class="group-name"></span>' +
      '<button class="group-rename" title="重命名分组" aria-label="重命名分组">✎</button><button class="group-del" title="删除分组" aria-label="删除分组">⌫</button><span class="group-count"></span>';
    const box = groupBox("m:" + name, html, byManual[name], (head) => {
      head.querySelector(".group-name").textContent = name;
      head.querySelector(".group-rename").onclick = (e) => { e.stopPropagation(); renameManualGroup(name); };
      head.querySelector(".group-del").onclick = (e) => { e.stopPropagation(); deleteManualGroup(name); };
    }, "空分组 · 用终端的「移动」按钮把终端放进来");
    list.appendChild(box);
  });

  autoOrder.forEach((cwd) => {
    const html = '<span class="group-caret">▾</span><span class="group-name"></span><button class="group-rename" title="重命名分组">✎</button><span class="group-count"></span>';
    const box = groupBox("d:" + cwd, html, auto[cwd], (head) => {
      head.title = cwd;
      head.querySelector(".group-name").textContent = (state.groups && state.groups[cwd]) || tabBasename(cwd);
      head.querySelector(".group-rename").onclick = (e) => { e.stopPropagation(); renameGroup(cwd); };
    });
    list.appendChild(box);
  });
}

// ---- manual group management -----------------------------------------------
async function newManualGroup() {
  const name = await uiPrompt("新建分组", "", "▣");
  if (name === null) return;
  const nm = name.trim(); if (!nm) return;
  try { await api("/api/manual-groups", { method: "POST", body: JSON.stringify({ name: nm }) }); await loadTabs(); }
  catch (e) { showToast("新建失败 · " + e.message); }
}
async function renameManualGroup(name) {
  const nn = await uiPrompt("重命名分组「" + name + "」", name, "▣");
  if (nn === null) return;
  const v = nn.trim(); if (!v || v === name) return;
  try { await api("/api/manual-groups/rename", { method: "POST", body: JSON.stringify({ old: name, new: v }) }); await loadTabs(); }
  catch (e) { showToast("重命名失败 · " + e.message); }
}
async function deleteManualGroup(name) {
  if (!(await uiConfirm("删除分组「" + name + "」", "分组内的终端会回到按目录分组（终端本身不受影响）。"))) return;
  try { await api("/api/manual-groups/delete", { method: "POST", body: JSON.stringify({ name }) }); await loadTabs(); }
  catch (e) { showToast("删除失败 · " + e.message); }
}
async function moveTab(t) {
  const g = await pickGroup(t.group || "");
  if (g === undefined) return;
  try { await api("/api/sessions/" + t.id + "/group", { method: "POST", body: JSON.stringify({ group: g }) }); await loadTabs(); }
  catch (e) { showToast("移动失败 · " + e.message); }
}
function pickGroup(current) {
  return new Promise((resolve) => {
    const back = document.createElement("div"); back.className = "ui-dialog-backdrop";
    const box = document.createElement("div"); box.className = "ui-dialog";
    box.innerHTML = '<div class="ui-dialog-icon">▣</div><div class="ui-dialog-title">移动到分组</div><div class="pick-list"></div><div class="ui-dialog-btns"></div>';
    const listEl = box.querySelector(".pick-list");
    function row(label, val) {
      const b = document.createElement("button"); b.className = "pick-row" + (val === current ? " sel" : "");
      b.textContent = label; b.onclick = () => done(val); return b;
    }
    listEl.appendChild(row("按目录（默认）", ""));
    (state.manualGroups || []).forEach((g) => listEl.appendChild(row("▣ " + g, g)));
    const btns = box.querySelector(".ui-dialog-btns");
    const cancel = document.createElement("button"); cancel.className = "ui-btn"; cancel.textContent = "取消"; cancel.onclick = () => done(undefined);
    const nw = document.createElement("button"); nw.className = "ui-btn primary"; nw.textContent = "＋ 新分组";
    nw.onclick = async () => {
      const name = await uiPrompt("新建分组", "", "▣");
      if (name === null) return;
      const nm = name.trim(); if (!nm) return;
      try { await api("/api/manual-groups", { method: "POST", body: JSON.stringify({ name: nm }) }); done(nm); }
      catch (e) { showToast("新建失败 · " + e.message); }
    };
    btns.appendChild(cancel); btns.appendChild(nw);
    function done(v) { document.removeEventListener("keydown", onKey); back.remove(); resolve(v); }
    function onKey(e) { if (e.key === "Escape") done(undefined); }
    back.appendChild(box); document.body.appendChild(back);
    back.onclick = (e) => { if (e.target === back) done(undefined); };
    document.addEventListener("keydown", onKey);
  });
}

async function renameGroup(cwd) {
  const label = await uiPrompt("重命名分组「" + tabBasename(cwd) + "」", (state.groups && state.groups[cwd]) || "", "▣");
  if (label === null) return;
  try { await api("/api/groups", { method: "POST", body: JSON.stringify({ cwd, label: label.trim() }) }); await loadTabs(); }
  catch (e) { showToast("重命名失败 · " + e.message); }
}

async function renameTab(t) {
  const name = await uiPrompt("重命名终端 cc_" + t.id, t.name || "", "◇");
  if (name === null) return;
  const nm = name.trim();
  try {
    await api("/api/sessions/" + t.id + "/rename", { method: "POST", body: JSON.stringify({ name: nm }) });
    await loadTabs();
    const rp = paneOfTab(t.id);
    if (rp) {
      rp.tab.name = nm;
      paneHeader(rp);
    }
    if (rp && rp === active) {
      const disp = nm || ("cc_" + t.id);
      document.getElementById("term-title").textContent = disp;
      document.getElementById("topbar-title").textContent = disp;
      setTitlebar(disp + "  —  cc_" + t.id);
    }
  } catch (e) { showToast("重命名失败 · " + e.message); }
}

async function stopTab(id) {
  try { await api("/api/sessions/" + id + "/stop", { method: "POST" }); }
  catch (e) { showToast(e.message); return; }
  const sp = paneOfTab(id);
  if (sp) closePane(sp);
  await loadTabs();
}
async function requestStopTab(tab) {
  if (restartRequests.has(tab.id)) { showToast("此终端正在执行重启操作"); return; }
  const name = tab.name || tab.title || ("cc_" + tab.id);
  if (!(await uiConfirm("停止「" + name + "」", "这会终止服务器上的 tmux 会话。关闭当前视图不会停止它。", true))) return;
  await stopTab(tab.id);
}
async function requestStopActive() {
  if (!active) return;
  await requestStopTab(active.tab);
}
async function deleteTab(id) {
  if (!(await uiConfirm("删除终端标签 cc_" + id, "这个已停止的终端标签将被彻底删除，不可恢复。", true))) return;
  try { await api("/api/sessions/" + id, { method: "DELETE" }); }
  catch (e) { showToast(e.message); return; }
  const dp = paneOfTab(id);
  if (dp) closePane(dp);
  if (state.activeId === id) state.activeId = null;
  await loadTabs();
}

// ---- new terminal: directory picker + file management ----------------------
let dirCurrentPath = "";
let dirCurrentData = null;
let dirLoadSeq = 0;
function openDirModal() {
  openLayer(document.getElementById("dir-modal"), true);
  const search = document.getElementById("dir-search");
  if (search) search.value = "";
  loadDir(state.defaultDir || "");
  setTimeout(() => { if (search) search.focus(); }, 40);
}
function closeDirModal() { closeLayer(document.getElementById("dir-modal")); }
document.getElementById("dir-close").onclick = closeDirModal;
document.getElementById("new-term").onclick = openDirModal;
document.getElementById("empty-new").onclick = openDirModal;
document.getElementById("new-group").onclick = newManualGroup;
document.getElementById("dir-mkdir").onclick = mkdirHere;
document.getElementById("dir-touch").onclick = touchHere;
document.getElementById("dir-upload").onclick = () => document.getElementById("dir-upload-input").click();
document.getElementById("dir-upload-input").onchange = (ev) => { if (ev.target.files.length) uploadFiles(ev.target.files); ev.target.value = ""; };
document.getElementById("dir-search").oninput = () => { if (dirCurrentData) renderDirEntries(dirCurrentData); };

async function loadDir(path) {
  const seq = ++dirLoadSeq;
  const list = document.getElementById("dir-list");
  list.setAttribute("aria-busy", "true");
  list.innerHTML = '<div class="gpu-loading">读取目录</div>';
  let data;
  try { data = await api("/api/fs" + (path ? "?path=" + encodeURIComponent(path) : "")); }
  catch (e) {
    if (seq !== dirLoadSeq) return;
    list.innerHTML = '<div class="dir-empty">目录读取失败</div>';
    showToast("打不开 · " + (e.name ? e.name + ": " : "") + (e.message || ""));
    return;
  } finally {
    if (seq === dirLoadSeq) list.removeAttribute("aria-busy");
  }
  if (seq !== dirLoadSeq) return;
  if (!data.path && data.entries.length === 1 && data.entries[0].type === "dir") return loadDir(data.entries[0].path);
  renderDir(data);
}

function upRow(target) {
  const row = document.createElement("div");
  row.className = "dir-row up";
  row.innerHTML = '<span class="ic">↰</span><span class="nm">..</span>';
  row.onclick = () => loadDir(target);
  keyboardClickable(row, () => loadDir(target), "返回上级目录");
  return row;
}
function entryRow(e) {
  const row = document.createElement("div");
  row.className = "dir-row" + (e.type === "file" ? " file" : "");
  row.innerHTML = '<span class="ic">' + (uiIcon(e.type === "dir" ? "Folder" : "File") || (e.type === "dir" ? "▸" : "·")) + '</span><span class="nm"></span><span class="row-actions"></span>';
  row.querySelector(".nm").textContent = e.name;
  if (e.type === "dir") {
    row.onclick = () => loadDir(e.path);
    keyboardClickable(row, () => loadDir(e.path), "打开目录 " + e.name);
  }
  const acts = row.querySelector(".row-actions");
  if (e.type === "file") acts.appendChild(iconBtn("⬇", "下载", () => downloadEntry(e)));
  acts.appendChild(iconBtn("✎", "重命名", () => renameEntry(e)));
  acts.appendChild(iconBtn("⌫", "删除", () => deleteEntry(e)));
  return row;
}
function iconBtn(label, title, onclick) {
  const b = document.createElement("button");
  b.className = "icon-btn-sm"; b.textContent = label; b.title = title; b.setAttribute("aria-label", title);
  if (GLYPH_ICONS[label]) setCommandIcon(b, GLYPH_ICONS[label]);
  b.onclick = (ev) => { ev.stopPropagation(); onclick(); };
  return b;
}

function renderDir(data) {
  dirCurrentData = data;
  dirCurrentPath = data.path;
  renderCrumbs(data);

  const cur = document.getElementById("dir-current");
  const modeRow = document.getElementById("mode-row");
  document.getElementById("dir-mkdir").classList.toggle("hidden", !data.path);
  if (data.path) { cur.textContent = data.path; modeRow.classList.remove("hidden"); modeRow.dataset.cwd = data.path; }
  else { cur.textContent = "选择一个目录后即可在此开终端"; modeRow.classList.add("hidden"); }

  renderDirEntries(data);
}

function renderCrumbs(data) {
  const cr = document.getElementById("dir-crumb");
  cr.innerHTML = "";
  const root = document.createElement("a");
  root.textContent = "Roots";
  root.onclick = () => loadDir("");
  keyboardClickable(root, () => loadDir(""), "打开根目录列表");
  cr.appendChild(root);
  if (!data.path) return;
  let acc = "";
  const parts = data.path.split("/").filter(Boolean);
  parts.forEach((part, i) => {
    acc += "/" + part;
    const sep = document.createElement("span"); sep.className = "sep"; sep.textContent = "›"; cr.appendChild(sep);
    if (i === parts.length - 1) {
      const cur = document.createElement("span"); cur.textContent = part; cr.appendChild(cur);
    } else {
      const link = document.createElement("a"); link.textContent = part;
      const target = acc;
      link.onclick = () => loadDir(target);
      keyboardClickable(link, () => loadDir(target), "打开目录 " + part);
      cr.appendChild(link);
    }
  });
}

function filterDirEntries(entries) {
  const q = (document.getElementById("dir-search").value || "").trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(q));
}

function renderDirEntries(data) {
  const dl = document.getElementById("dir-list");
  dl.innerHTML = "";
  if (data.parent !== null && data.parent !== undefined) dl.appendChild(upRow(data.parent));
  else if (data.path) dl.appendChild(upRow(""));
  const entries = filterDirEntries(data.entries);
  entries.forEach((e) => dl.appendChild(entryRow(e)));
  if (!entries.length && data.path) {
    const d = document.createElement("div"); d.className = "dir-empty";
    d.textContent = data.entries.length ? "没有匹配项" : "空目录";
    dl.appendChild(d);
  }
}

async function mkdirHere() {
  if (!dirCurrentPath) { showToast("请先进入一个目录"); return; }
  const name = await uiPrompt("新建文件夹", "", "□");
  if (!name) return;
  try { await api("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ parent: dirCurrentPath, name }) }); loadDir(dirCurrentPath); }
  catch (e) { showToast("新建失败 · " + e.message); }
}
async function touchHere() {
  if (!dirCurrentPath) { showToast("请先进入一个目录"); return; }
  const name = await uiPrompt("新建文件", "", "◇");
  if (!name) return;
  try { await api("/api/fs/touch", { method: "POST", body: JSON.stringify({ parent: dirCurrentPath, name }) }); loadDir(dirCurrentPath); }
  catch (e) { showToast("新建失败 · " + e.message); }
}
async function uploadFiles(files) {
  if (!dirCurrentPath) { showToast("请先进入一个目录"); return; }
  let ok = 0;
  for (const file of files) {
    const fd = new FormData();
    fd.append("parent", dirCurrentPath);
    fd.append("file", file);
    try {
      const r = await fetch("/api/fs/upload", { method: "POST", body: fd, credentials: "same-origin" });
      if (r.ok) ok++; else showToast("上传失败 · " + file.name);
    } catch (e) { showToast("上传失败 · " + file.name); }
  }
  if (ok) showToast("已上传 " + ok + " 个文件");
  loadDir(dirCurrentPath);
}
async function downloadEntry(e) {
  try {
    const headers = {};
    if (getToken()) headers.Authorization = "Bearer " + getToken();
    const r = await fetch("/api/fs/download?path=" + encodeURIComponent(e.path), { credentials: "same-origin", headers });
    if (r.status === 401) { setTokenPrompt(); throw new Error("需要有效 Token"); }
    if (!r.ok) throw new Error(r.statusText || "下载失败");
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = e.name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  } catch (err) { showToast("下载失败 · " + err.message); }
}
async function renameEntry(e) {
  const name = await uiPrompt("重命名为", e.name, "✎");
  if (!name || name === e.name) return;
  try { await api("/api/fs/rename", { method: "POST", body: JSON.stringify({ path: e.path, name }) }); loadDir(dirCurrentPath); }
  catch (err) { showToast("重命名失败 · " + err.message); }
}
async function deleteEntry(e) {
  const msg = e.type === "dir" ? "文件夹及其全部内容会一并删除，不可恢复。" : "此文件将被删除，不可恢复。";
  if (!(await uiConfirm("删除「" + e.name + "」", msg, true))) return;
  try { await api("/api/fs/delete", { method: "POST", body: JSON.stringify({ path: e.path }) }); loadDir(dirCurrentPath); }
  catch (err) { showToast("删除失败 · " + err.message); }
}
let sessionLaunchBusy = false;
document.querySelectorAll(".mode-btn").forEach((b) => {
  b.onclick = async () => {
    if (sessionLaunchBusy) return;
    const cwd = document.getElementById("mode-row").dataset.cwd;
    const buttons = Array.from(document.querySelectorAll(".mode-btn"));
    const originalLabel = b.textContent;
    sessionLaunchBusy = true;
    buttons.forEach((button) => { button.disabled = true; });
    setButtonBusy(b, true);
    b.textContent = "正在创建";
    try {
      const tab = await api("/api/sessions", { method: "POST", body: JSON.stringify({ cwd, type: b.dataset.type || "claude", mode: b.dataset.mode || "new" }) });
      closeDirModal();
      state.activeId = tab.id;
      saveActiveId(tab.id);
      attachTerminal(tab);
      await loadTabs();
      await window.ccWorkspace?.terminalCreated(tab);
      closeDrawer();
    } catch (e) { showToast("创建失败 · " + e.message); }
    finally {
      sessionLaunchBusy = false;
      buttons.forEach((button) => { button.disabled = false; });
      setButtonBusy(b, false);
      b.textContent = originalLabel;
    }
  };
});

// ---- open / restart a tab --------------------------------------------------
function updateRestartControls() {
  const supported = tab => tab && ["codex", "claude", "opencode"].includes(tab.resumeAgent || tab.type);
  for (const pane of panes) {
    const button = pane.el.querySelector(".pane-restart");
    if (!button) continue;
    const busy = !!(pane.tab && restartRequests.has(pane.tab.id));
    button.classList.toggle("hidden", !supported(pane.tab));
    button.disabled = !supported(pane.tab) || busy;
    button.setAttribute("aria-busy", String(busy));
    pane.el.classList.toggle("restarting", pane.tab && restartRequests.get(pane.tab.id) === "restarting");
  }
  const tab = active && active.tab;
  const button = document.getElementById("btn-restart");
  if (button) {
    button.disabled = !supported(tab) || restartRequests.has(tab.id);
    button.setAttribute("aria-busy", String(!!(tab && restartRequests.has(tab.id))));
  }
  document.getElementById("btn-stop").disabled = !tab || restartRequests.has(tab.id);
  updateInterruptControl();
  updateQuickCommandState();
}
function updateInterruptControl() {
  const button = document.getElementById("btn-interrupt"), p = active;
  if (button) button.disabled = interruptPending || !p?.term || !p.tab || p.dead || p.ws?.readyState !== 1 || restartRequests.has(p.tab.id);
}
async function requestInterruptActive() {
  const p = active, term = p?.term, ws = p?.ws, gen = p?.gen, id = p?.tab?.id;
  if (interruptPending || !term || !id || p.dead || ws?.readyState !== 1 || restartRequests.has(id)) return;
  interruptPending = true; updateInterruptControl();
  try {
    if (!(await uiDialog({ title: "中断「" + tabName(p.tab) + "」", message: "向当前程序发送一次 Ctrl+C，可能取消正在执行的任务或退出 Codex / Claude Code。不会终止 tmux 会话。",
      okLabel: "发送中断", destructive: true, icon: "!" }))) return;
    if (active !== p || !panes.includes(p) || p.term !== term || p.ws !== ws || p.gen !== gen || p.tab?.id !== id || p.dead || ws.readyState !== 1 || restartRequests.has(id)) {
      showToast("窗口或连接已变化，中断已取消"); return;
    }
    ctrlArmed = false; updateCtrlCap();
    // This explicit, confirmed command is the only UI interrupt path.
    sendInputTo(p, "\x03");
  } finally { interruptPending = false; updateInterruptControl(); }
}
function restartRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
async function requestRestartTab(tab) {
  if (!tab || !["codex", "claude", "opencode"].includes(tab.resumeAgent || tab.type) || restartRequests.has(tab.id)) return;
  const id = tab.id, name = tabName(tab), pane = paneOfTab(id), generation = pane && pane.gen;
  const targetUnchanged = () => !pane || (panes.includes(pane) && pane.gen === generation && pane.tab?.id === id);
  restartRequests.set(id, "checking");
  updateRestartControls();
  renderTabs();
  try {
    let preview = await api("/api/sessions/" + id + "/restart", {}, 0);
    if (!targetUnchanged()) { showToast("窗口已切换，重启已取消"); return; }
    if (preview.canBind && !preview.ready) {
      const identifier = await uiPrompt("绑定「" + name + "」的原会话" + (preview.agent === "opencode" ? "编号" : " UUID"), "", "i");
      if (identifier === null || !identifier.trim() || !targetUnchanged()) return;
      preview = await api("/api/sessions/" + id + "/restart/bind", {
        method: "POST", body: JSON.stringify({ sessionId: identifier.trim() }),
      });
    }
    if (!preview.ready) { showToast(preview.reason || "此会话暂时不能自动恢复"); return; }
    const message = (preview.running ? "这会退出当前程序，可能中断正在执行的任务，并丢弃未发送的输入。" : "") +
      "将恢复原会话 " + preview.sessionId + "，恢复后等待输入，不自动发送“继续”。";
    if (!(await uiDialog({ title: "重启并恢复「" + name + "」", message, okLabel: "重启并恢复", icon: "?" }))) return;
    if (!targetUnchanged()) { showToast("窗口已切换，重启已取消"); return; }
    restartRequests.set(id, "restarting");
    closeQuickCommands(false);
    updateRestartControls();
    if (pane && targetUnchanged()) setStatus("reconnecting", "重启中", pane);
    const restored = await api("/api/sessions/" + id + "/restart", {
      method: "POST", body: JSON.stringify({ expected: preview.expected, requestId: restartRequestId(), confirmed: true }),
    });
    const index = state.tabs.findIndex(item => item.id === id);
    if (index !== -1) state.tabs[index] = restored;
    if (pane && targetUnchanged()) { pane.tab = restored; paneHeader(pane); }
    showToast("已恢复「" + name + "」的原会话");
  } catch (error) {
    showToast("重启未完成 · " + error.message);
  } finally {
    restartRequests.delete(id);
    if (pane && targetUnchanged() && pane.ws?.readyState === 1) setStatus("connected", "运行中", pane);
    updateRestartControls();
    renderTabs();
  }
}
let openingTab = false;
async function openTab(tab) {
  if (openingTab) return false;
  openingTab = true;
  try {
    if (window.ccWorkspace && !(await window.ccWorkspace.beforeOpen(tab))) return false;
    const mobile = mqMobile.matches;
    const targetPane = active, targetGeneration = active?.gen;
    const ep = paneOfTab(tab.id);
    if (ep && tab.alive) { focusPane(ep, !COARSE); closeDrawer(); return true; }
    let t = tab;
    if (!t.alive) {
      const name = tab.name || tab.title || tabName(tab);
      if (!(await uiConfirm("启动「" + name + "」？", tab.type === "shell" ? "将在原目录启动终端。" : "将检查原会话绑定后启动并恢复；无法确认原会话时不会新建替代对话。"))) return false;
      if (mobile !== mqMobile.matches || (window.ccWorkspace && !(await window.ccWorkspace.beforeOpen(tab)))) return false;
      try { t = await api("/api/sessions/" + t.id + "/start", { method: "POST" }); }
      catch (e) { showToast("启动失败 · " + e.message); return false; }
      if (mobile !== mqMobile.matches || active !== targetPane || active?.gen !== targetGeneration) {
        await loadTabs(); return false;
      }
    }
    state.activeId = t.id;
    saveActiveId(t.id);
    attachTerminal(t);
    await loadTabs();
    closeDrawer();
    return true;
  } finally { openingTab = false; }
}

// ---- font size -------------------------------------------------------------
function getFont() {
  let n = parseInt(localStorage.getItem("cc_fontsize") || "", 10);
  if (!n) n = mqMobile.matches ? 11 : 13;
  return Math.min(20, Math.max(8, n));
}
function setFont(n) {
  n = Math.min(20, Math.max(8, n));
  localStorage.setItem("cc_fontsize", n);
  document.getElementById("size-val").textContent = n;
  panes.forEach((p) => { if (p.term) p.term.options.fontSize = n; });
  refitAll();
}
function loadTerminalFonts() {
  if (!document.fonts || typeof document.fonts.load !== "function") return;
  Promise.all([
    document.fonts.load('13px "CC JetBrains Mono"'),
    document.fonts.load('12px "CC Terminal Mono"'),
    document.fonts.load('12px "CC Terminal Symbols"', "✓✻⠋─→"),
  ]).then(() => {
    panes.forEach((p) => {
      if (!p.term) return;
      p.term.options.fontFamily = TERMINAL_FONT_FAMILY;
      try { p.term.clearTextureAtlas(); } catch (e) {}
      refit(p);
    });
  }).catch(() => {});
}
document.getElementById("size-up").onclick = () => setFont(getFont() + 1);
document.getElementById("size-dn").onclick = () => setFont(getFont() - 1);

// ---- aux key bar (mobile) --------------------------------------------------
const AUX_KEYS = [
  { l: "Esc", s: "\x1b", primary: true }, { l: "Tab", s: "\t", primary: true }, { l: "Ctrl", ctrl: true, primary: true },
  { l: "↑", s: "\x1b[A", gap: true, primary: true }, { l: "↓", s: "\x1b[B", primary: true },
  { l: "↵", s: "\r", title: "回车", primary: true },
  { l: "/", commands: true, title: "快捷命令", primary: true },
  { l: "←", s: "\x1b[D" }, { l: "→", s: "\x1b[C" }, { l: "⌫", s: "\x7f", title: "退格", extra: true },
  { l: "~", s: "~", gap: true }, { l: "`", s: "`" }, { l: "/", s: "/" },
  { l: ".", s: "." }, { l: ",", s: "," }, { l: "?", s: "?" }, { l: ";", s: ";" },
  { l: "'", s: "'" }, { l: '"', s: '"' }, { l: "[", s: "[" }, { l: "]", s: "]" },
  { l: "-", s: "-" }, { l: "+", s: "+" }, { l: "=", s: "=" },
  { l: ":", s: ":", extra: true },
  { l: "|", s: "|", extra: true }, { l: "(", s: "(", extra: true }, { l: ")", s: ")", extra: true },
  { l: "*", s: "*", extra: true }, { l: "&", s: "&", extra: true }, { l: "$", s: "$", extra: true }, { l: "_", s: "_", extra: true },
];
let ctrlArmed = false;
function ctrlByte(ch) {
  const u = ch.toLowerCase().charCodeAt(0);
  if (u >= 97 && u <= 122) return String.fromCharCode(u - 96);
  const c = ch.charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c & 0x1f);
  return ch;
}
function updateCtrlCap() { const c = document.getElementById("cap-ctrl"); if (c) { c.classList.toggle("armed", ctrlArmed); c.setAttribute("aria-pressed", String(ctrlArmed)); } }
let _dropWarn = 0;
function sendInputTo(pane, data) {
  const ws = pane && pane.ws;
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: "input", data })); return; }
  // Never swallow keystrokes silently — that reads as "this pane is frozen".
  const now = Date.now();
  if (now - _dropWarn > 2500) { _dropWarn = now; showToast("这一格还没连上,输入未送出"); }
}
function sendInput(data) { sendInputTo(active, data); }
function deliverTo(pane, data) {
  if (data === "\x03" || (ctrlArmed && (data === "c" || data === "C"))) { copyTerminalSelection(pane); return; }
  if (pane && pane.tab && restartRequests.get(pane.tab.id) === "restarting") return;
  if (ctrlArmed && data.length === 1) { data = ctrlByte(data); ctrlArmed = false; updateCtrlCap(); }
  sendInputTo(pane, data);
}
function deliver(data) { deliverTo(active, data); }
function buildAux() {
  const bar = document.getElementById("auxbar");
  bar.innerHTML = "";
  const primary = document.createElement("div"); primary.className = "aux-primary";
  const keys = document.createElement("div"); keys.className = "aux-keys";
  bar.append(primary, keys);
  AUX_KEYS.forEach((k) => {
    const group = k.primary ? primary : keys;
    if (k.gap) { const gap = document.createElement("span"); gap.className = "key-gap"; gap.setAttribute("aria-hidden", "true"); group.appendChild(gap); }
    const b = document.createElement("button");
    b.className = "keycap" + (k.extra ? " extra" : "") + (/[↑↓←→]/.test(k.l) ? " arrow" : ""); b.textContent = k.l;
    b.title = k.title || k.l;
    b.setAttribute("aria-label", b.title);
    if (k.commands) {
      b.id = "cap-commands";
      b.setAttribute("aria-haspopup", "menu");
      b.setAttribute("aria-controls", "quick-commands");
      b.setAttribute("aria-expanded", "false");
      setCommandIcon(b, "SquareSlash");
    } else if (GLYPH_ICONS[k.l]) {
      setCommandIcon(b, k.l === "⌫" ? "Delete" : GLYPH_ICONS[k.l]);
    }
    if (k.ctrl) b.id = "cap-ctrl";
    // Keep terminal focus without cancelling the click synthesized from a tap.
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      if (k.commands) { toggleQuickCommands(); return; }
      if (!active || !active.term) return;
      if (k.ctrl) { ctrlArmed = !ctrlArmed; updateCtrlCap(); active.term.focus(); return; }
      let data = k.s;
      if (/^\x1b\[[ABCD]$/.test(data) && active.term.modes.applicationCursorKeysMode) data = "\x1bO" + data.slice(-1);
      deliver(data); active.term.focus();
    });
    group.appendChild(b);
  });
  updateQuickCommandState();
}

const QUICK_COMMANDS = {
  codex: [
    { command: "/model", label: "模型", icon: "Cpu" },
    { command: "/fast", label: "Fast", icon: "Zap" },
    { command: "/status", label: "状态", icon: "Info" },
    { command: "/", label: "全部命令", icon: "List" },
  ],
  claude: [
    { command: "/model", label: "模型", icon: "Cpu" },
    { command: "/fast", label: "Fast", icon: "Zap" },
    { command: "/status", label: "状态", icon: "Info" },
    { command: "/", label: "全部命令", icon: "List" },
  ],
  opencode: [
    { command: "/models", label: "模型", icon: "Cpu" },
    { command: "/help", label: "帮助", icon: "CircleHelp" },
    { command: "/", label: "全部命令", icon: "List" },
  ],
};
let quickCommandTarget = null;
function commandsForPane(pane) { return pane && pane.tab ? QUICK_COMMANDS[pane.tab.type] || [] : []; }
function quickTargetValid(target) {
  return !!(target && active && target.pane === active && target.gen === active.gen && target.ws === active.ws &&
    active.term && !active.dead && !active.closedByUser && active.ws && active.ws.readyState === 1 &&
    restartRequests.get(active.tab?.id) !== "restarting");
}
function updateQuickCommandState() {
  const button = document.getElementById("cap-commands");
  if (!button) return;
  button.disabled = !active || !active.term || active.dead || !active.ws || active.ws.readyState !== 1 || !commandsForPane(active).length || restartRequests.get(active.tab?.id) === "restarting";
  if (quickCommandTarget && (!quickTargetValid(quickCommandTarget) || !commandsForPane(active).length)) closeQuickCommands(false);
}
function closeQuickCommands(restoreFocus = true) {
  const menu = document.getElementById("quick-commands");
  const wasOpen = layerOpen(menu);
  menu.classList.add("hidden");
  quickCommandTarget = null;
  const button = document.getElementById("cap-commands");
  if (button) {
    button.setAttribute("aria-expanded", "false");
    if (wasOpen && restoreFocus && !button.disabled) button.focus({ preventScroll: true });
  }
}
function insertQuickCommand(command, target) {
  if (!layerOpen(document.getElementById("quick-commands"))) return;
  if (!quickTargetValid(target) || !commandsForPane(target.pane).some(item => item.command === command)) {
    closeQuickCommands(false);
    showToast("终端连接已变化，命令未送出");
    return;
  }
  // Use the application's paste mode; never clear a draft or synthesize Enter.
  try { target.pane.term.paste(command); }
  catch (_) { closeQuickCommands(false); showToast("连接已中断，命令未送出"); return; }
  ctrlArmed = false;
  updateCtrlCap();
  closeQuickCommands();
  if (!COARSE) target.pane.term.focus();
}
function toggleQuickCommands() {
  const menu = document.getElementById("quick-commands");
  if (layerOpen(menu)) { closeQuickCommands(); return; }
  const target = active && { pane: active, gen: active.gen, ws: active.ws };
  if (!quickTargetValid(target) || !commandsForPane(active).length) { updateQuickCommandState(); return; }
  closeRecentSessions(false);
  closeDrawer();
  if (COARSE) {
    kbdOn = false;
    panes.forEach(pane => pane.term && applyKbdMode(pane.term));
    try { active.term.textarea.blur(); } catch (_) {}
    updateKbdBtn();
  }
  quickCommandTarget = target;
  document.getElementById("quick-commands-title").textContent = typeLabel(active.tab.type) + " · 快捷命令";
  const list = document.getElementById("quick-command-list");
  list.replaceChildren();
  for (const item of commandsForPane(active)) {
    const button = document.createElement("button");
    button.className = "quick-command-row";
    button.dataset.command = item.command;
    button.setAttribute("role", "menuitem");
    button.setAttribute("aria-label", item.command + " · " + item.label);
    button.innerHTML = '<span class="quick-command-icon" aria-hidden="true">' + uiIcon(item.icon) + '</span><span class="quick-command-name"></span><span class="quick-command-label"></span>';
    button.querySelector(".quick-command-name").textContent = item.command;
    button.querySelector(".quick-command-label").textContent = item.label;
    button.onclick = () => insertQuickCommand(item.command, target);
    list.appendChild(button);
  }
  menu.classList.remove("hidden");
  document.getElementById("cap-commands").setAttribute("aria-expanded", "true");
  list.querySelector("button").focus({ preventScroll: true });
}
document.getElementById("quick-commands-close").onclick = () => closeQuickCommands();
document.addEventListener("pointerdown", event => {
  const menu = document.getElementById("quick-commands");
  if (layerOpen(menu) && !menu.contains(event.target) && !document.getElementById("cap-commands").contains(event.target)) closeQuickCommands(false);
}, true);
document.addEventListener("keydown", event => {
  const menu = document.getElementById("quick-commands");
  if (!layerOpen(menu)) return;
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeQuickCommands(); return; }
  if (event.key === "Tab") { closeQuickCommands(); return; }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const buttons = Array.from(menu.querySelectorAll(".quick-command-row"));
  if (!buttons.length) return;
  event.preventDefault();
  event.stopPropagation();
  const current = buttons.indexOf(document.activeElement);
  const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
    (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
  buttons[index].focus();
}, true);
mqMobile.addEventListener("change", () => closeQuickCommands(false));

// ---- terminal panes (split view) -------------------------------------------
// `panes` holds every visible split cell; `active` points at the FOCUSED pane so
// all the single-terminal code (input, images, aux keys, font) keeps working —
// it just acts on whichever pane has focus.
const MAX_PANES = 4;
let panes = [];
let active = null; // the focused pane: { term, fit, ws, tab, el, host, dead, ... }
let maximizedPane = null;

function paneOfTab(id) { return panes.find((p) => p.tab && p.tab.id === id) || null; }
function savePaneLayout() {
  try { localStorage.setItem("cc_panes", JSON.stringify(panes.map((p) => (p.tab ? p.tab.id : null)))); } catch (e) {}
  window.ccWorkspace?.layoutChanged();
}
// Split direction: "auto" picks side-by-side only when each cell stays usable,
// otherwise stacks top-to-bottom. "row"/"col" force it.
function paneDirMode() { return localStorage.getItem("cc_pane_dir") || "auto"; }
function effectivePaneDir() {
  const mode = paneDirMode();
  if ((window.innerWidth || 1000) <= 560) return "col";   // phone floor, even if forced
  if (mode === "row" || mode === "col") return mode;
  const box = document.getElementById("panes");
  const w = (box && box.clientWidth) || window.innerWidth || 1000;
  const colsIfRow = panes.length >= 2 ? 2 : 1;
  return window.innerWidth >= 1024 && w / colsIfRow >= 240 ? "row" : "col";
}
function updateDirBtn() {
  const b = document.getElementById("btn-dir");
  if (!b) return;
  const mode = paneDirMode();
  const eff = effectivePaneDir();
  b.textContent = mode === "auto" ? (eff === "col" ? "⇅" : "⇄") : (mode === "col" ? "⇅" : "⇄");
  setCommandIcon(b, (mode === "auto" ? eff : mode) === "col" ? "Rows2" : "Columns2");
  b.classList.toggle("auto-mode", mode === "auto");
  b.title = "分屏方向：" + (mode === "auto" ? "自动(当前" + (eff === "col" ? "上下" : "左右") + ")" : mode === "row" ? "左右" : "上下") + " · 点击切换";
}
function applyPaneDir() {
  const box = document.getElementById("panes");
  if (box) box.setAttribute("data-eff", effectivePaneDir());
  updateDirBtn();
  applyGridTemplate();
  requestAnimationFrame(renderGutters);
}

// ---- resizable cells: drag the divider between them ------------------------
// Sizes are kept as grid `fr` weights that always sum to the container, so the
// cells stay flush — resizing can never leave a blank strip on the page.
const MIN_CELL = 140;  // px; keeps a shrunk cell still readable, never zero
let gridFr = (function () {
  try {
    const v = JSON.parse(localStorage.getItem("cc_pane_fr") || "null");
    if (v && Array.isArray(v.cols) && Array.isArray(v.rows)) return v;
  } catch (e) {}
  return { cols: [1, 1], rows: [1, 1, 1, 1] };
})();
function saveGridFr() { try { localStorage.setItem("cc_pane_fr", JSON.stringify(gridFr)); } catch (e) {} window.ccWorkspace?.layoutChanged(); }
function gridShape() {
  if (maximizedPane) return { cols: 1, rows: 1 };
  const n = Math.max(1, panes.length);
  const eff = (document.getElementById("panes") || {}).getAttribute
    ? document.getElementById("panes").getAttribute("data-eff") : "row";
  return (eff === "col") ? { cols: 1, rows: n } : { cols: n >= 2 ? 2 : 1, rows: n >= 3 ? 2 : 1 };
}
function frTemplate(arr, k) {
  const use = arr.slice(0, k);
  const sum = use.reduce((x, y) => x + y, 0) || k;
  return use.map((v) => (v / sum).toFixed(4) + "fr").join(" ");
}
function normalizeFr(arr, k) {           // keep weights around 1 so unused
  const use = arr.slice(0, k);           // tracks stay comparable later
  const sum = use.reduce((x, y) => x + y, 0) || k;
  for (let i = 0; i < k; i++) arr[i] = use[i] / sum * k;
}
function applyGridTemplate() {
  const box = document.getElementById("panes");
  if (!box) return;
  const sh = gridShape();
  box.style.gridTemplateColumns = frTemplate(gridFr.cols, sh.cols);
  box.style.gridTemplateRows = frTemplate(gridFr.rows, sh.rows);
  // Divider nodes can precede panes after reconciliation or a swap. Place cells
  // by their model order, never by their child index in the mixed DOM container.
  panes.forEach((pane, index) => {
    if (maximizedPane) pane.el.style.gridArea = "1 / 1 / 2 / 2";
    else if (sh.cols === 2 && panes.length === 3) {
      pane.el.style.gridArea = ["1 / 1 / 3 / 2", "1 / 2 / 2 / 3", "2 / 2 / 3 / 3"][index];
    } else {
      const row = Math.floor(index / sh.cols) + 1, col = index % sh.cols + 1;
      pane.el.style.gridArea = `${row} / ${col} / ${row + 1} / ${col + 1}`;
    }
  });
}
function renderGutters() {
  const box = document.getElementById("panes");
  if (!box) return;
  const existing = new Map(Array.from(box.querySelectorAll(".gutter")).map((g) => [g.dataset.divider, g]));
  if (panes.length < 2 || maximizedPane) { existing.forEach((g) => g.remove()); return; }
  // Preserve nodes across refits so pointer capture and double-click survive.
  function gutter(axis, idx) {
    const key = axis + idx;
    let g = existing.get(key);
    if (g) existing.delete(key);
    else {
      g = document.createElement("div");
      g.dataset.divider = key;
      g.className = "gutter " + (axis === "col" ? "v" : "h");
      g.title = axis === "col" ? "拖动调整宽度 · 双击复位" : "拖动调整高度 · 双击复位";
      wireGutter(g, axis, idx);
      box.appendChild(g);
    }
    return g;
  }
  const sh = gridShape();
  const cs = getComputedStyle(box);
  const gap = parseFloat(cs.rowGap || cs.gap) || 0;
  const padL = parseFloat(cs.paddingLeft) || 0, padT = parseFloat(cs.paddingTop) || 0;
  const padR = parseFloat(cs.paddingRight) || 0, padB = parseFloat(cs.paddingBottom) || 0;
  const colPx = cs.gridTemplateColumns.split(" ").map(parseFloat);
  const rowPx = cs.gridTemplateRows.split(" ").map(parseFloat);
  const sum = (a, k) => a.slice(0, k).reduce((x, y) => x + (y || 0), 0);
  for (let i = 0; i < sh.cols - 1; i++) {
    const g = gutter("col", i);
    g.style.left = (padL + sum(colPx, i + 1) + i * gap + gap / 2) + "px";
    g.style.top = padT + "px"; g.style.bottom = padB + "px";
  }
  for (let j = 0; j < sh.rows - 1; j++) {
    const g = gutter("row", j);
    g.style.top = (padT + sum(rowPx, j + 1) + j * gap + gap / 2) + "px";
    // with 3 cells the left one spans both rows, so this divider only covers col 2
    g.style.left = ((sh.cols === 2 && panes.length === 3) ? padL + (colPx[0] || 0) + gap : padL) + "px";
    g.style.right = padR + "px";
  }
  existing.forEach((g) => g.remove());
}
function wireGutter(g, axis, idx) {
  g.addEventListener("dblclick", () => {
    const arr = axis === "col" ? gridFr.cols : gridFr.rows;
    for (let k = 0; k < arr.length; k++) arr[k] = 1;
    saveGridFr(); applyGridTemplate(); refitAll();
    requestAnimationFrame(renderGutters);
    showToast("已复位为等分");
  });
  g.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    const box = document.getElementById("panes");
    const cs = getComputedStyle(box);
    const px = (axis === "col" ? cs.gridTemplateColumns : cs.gridTemplateRows).split(" ").map(parseFloat);
    const a0 = px[idx], b0 = px[idx + 1];
    if (!isFinite(a0) || !isFinite(b0)) return;
    const start = axis === "col" ? e.clientX : e.clientY;
    const arr = axis === "col" ? gridFr.cols : gridFr.rows;
    const k = axis === "col" ? gridShape().cols : gridShape().rows;
    let last = 0;
    try { g.setPointerCapture(e.pointerId); } catch (_) {}
    g.classList.add("dragging");
    document.body.classList.add("gutter-dragging");
    const onMove = (ev) => {
      const d = (axis === "col" ? ev.clientX : ev.clientY) - start;
      let a = a0 + d, b = b0 - d;
      if (a < MIN_CELL) { b = a0 + b0 - MIN_CELL; a = MIN_CELL; }
      if (b < MIN_CELL) { a = a0 + b0 - MIN_CELL; b = MIN_CELL; }
      if (a < MIN_CELL || b < MIN_CELL) return;      // both would collapse: ignore
      arr[idx] = a; arr[idx + 1] = b;
      applyGridTemplate();
      const now = Date.now();
      if (now - last > 120) { last = now; refitAll(); }   // keep it responsive, not frantic
    };
    const onUp = () => {
      g.removeEventListener("pointermove", onMove);
      g.removeEventListener("pointerup", onUp);
      g.removeEventListener("pointercancel", onUp);
      g.classList.remove("dragging");
      document.body.classList.remove("gutter-dragging");
      normalizeFr(arr, k); saveGridFr(); applyGridTemplate(); refitAll();
      requestAnimationFrame(renderGutters);
    };
    g.addEventListener("pointermove", onMove);
    g.addEventListener("pointerup", onUp);
    g.addEventListener("pointercancel", onUp);
  });
}
function cyclePaneDir() {
  const order = ["auto", "row", "col"];
  const next = order[(order.indexOf(paneDirMode()) + 1) % order.length];
  localStorage.setItem("cc_pane_dir", next);
  applyPaneDir();
  showToast("分屏方向：" + (next === "auto" ? "自动" : next === "row" ? "左右并排" : "上下堆叠"));
  setTimeout(refitAll, 80);
}
function layoutPanes() {
  const box = document.getElementById("panes");
  box.setAttribute("data-n", String(Math.max(1, panes.length)));
  box.setAttribute("data-maximized", String(!!maximizedPane));
  applyPaneDir();
  panes.forEach((p) => p.el.classList.toggle("focused", p === active));
  panes.forEach((p) => {
    p.el.classList.toggle("maximized", p === maximizedPane);
    const button = p.el.querySelector(".pane-expand");
    button.title = p === maximizedPane ? "恢复分屏" : "放大此窗";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(p === maximizedPane));
    setCommandIcon(button, p === maximizedPane ? "Minimize2" : "Maximize2");
  });
  for (const id of ["btn-split", "header-split"]) document.getElementById(id).disabled = !window.ccWorkspace && panes.length >= MAX_PANES;
  setTimeout(refitAll, 60);
}
function refitAll() {
  panes.forEach((p) => refit(p));
  // Toolbar/quota changes move the gaps too. Keep drag handles off pane buttons,
  // but don't replace a handle while it owns pointer capture during a drag.
  if (!document.body.classList.contains("gutter-dragging")) renderGutters();
}

let workspaceResizeFrame = 0;
let workspaceNeedsDirection = false;
function scheduleWorkspaceFit(updateDirection = false) {
  workspaceNeedsDirection = workspaceNeedsDirection || updateDirection;
  if (workspaceResizeFrame) return;
  workspaceResizeFrame = requestAnimationFrame(() => {
    workspaceResizeFrame = 0;
    if (workspaceNeedsDirection) { workspaceNeedsDirection = false; applyPaneDir(); }
    refitAll();
  });
}
// Container changes do not always produce a window resize event.
const workspaceGrid = document.getElementById("panes");
const workspaceResizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(entries => {
  scheduleWorkspaceFit(entries.some(entry => entry.target === workspaceGrid));
}) : null;
if (workspaceResizeObserver) workspaceResizeObserver.observe(workspaceGrid);

function setStatus(klass, text, pane) {
  const p = pane || active;
  if (p?.tab && restartRequests.get(p.tab.id) === "restarting") { klass = "reconnecting"; text = "重启中"; }
  if (p && p.el) {
    p.connectionState = klass;
    const pc = p.el.querySelector(".pane-conn");
    if (pc) pc.textContent = text;
    const pd = p.el.querySelector(".pane-bar .status-dot");
    if (pd) pd.className = "status-dot " + (klass === "connected" ? "green" : klass === "closed" ? "grey" : klass === "reconnecting" ? "yellow" : "blue");
  }
  if (p) window.ccNativeInput?.update(p);
  updateInterruptControl();
  if (p && p !== active) return;             // background pane: don't touch global header
  updateQuickCommandState();
  const c = document.getElementById("term-conn");
  c.className = "conn " + klass; c.textContent = text;
  const dot = document.getElementById("term-dot");
  dot.className = "status-dot " + (klass === "connected" ? "green" : klass === "closed" ? "grey" : klass === "reconnecting" ? "yellow" : "blue");
  document.getElementById("topbar-status").textContent = active ? text : "";
  document.getElementById("footer-state").textContent = klass === "connected" ? "RUNNING TASK" : klass.toUpperCase();
}
function refit(pane) {
  const p = pane || active;
  if (!p || !p.fit || !p.term) return;
  // Fitting against a collapsed box — mid keyboard animation on iOS, or a pane
  // that is not laid out yet — resizes the terminal to a degenerate size and the
  // renderer comes back blank, which shows xterm's #000 viewport default as a
  // pure black screen. Skip those; a later refit will catch up.
  const r = p.host && p.host.getBoundingClientRect();
  if (!r || r.width < 40 || r.height < 40) return;
  try {
    const term = p.term, cols = term.cols, rows = term.rows;
    const metrics = [r.width, r.height, devicePixelRatio, term.options.fontSize, term.options.fontFamily,
      term.options.lineHeight, term.options.letterSpacing].join("|");
    p.fit.fit();
    sendResize(p);
    // Keep the iOS resize repaint, not a full refresh on every layout check.
    if (term.rows > 0 && (p._lastFit?.term !== term || p._lastFit.metrics !== metrics || cols !== term.cols || rows !== term.rows)) {
      term.refresh(0, term.rows - 1);
    }
    p._lastFit = { term, metrics };
  } catch (e) {}
}
function sendResize(pane) {
  const p = pane || active;
  const ws = p && p.ws;
  if (!ws || ws.readyState !== 1 || !p.term || p.term.cols < 1 || p.term.rows < 1) return;
  const cols = p.term.cols, rows = p.term.rows, last = p._lastResize;
  if (last && last.ws === ws && last.cols === cols && last.rows === rows) return;
  ws.send(JSON.stringify({ type: "resize", cols, rows }));
  p._lastResize = { ws, cols, rows };
}

function paneHeader(p) {
  const disp = p.tab ? (p.tab.name || p.tab.title || ("cc_" + p.tab.id)) : "空白分屏";
  const nm = p.el.querySelector(".pane-name");
  if (nm) { nm.textContent = disp; nm.title = p.tab ? ("cc_" + p.tab.id + " · " + (p.tab.cwd || "")) : ""; }
}

// Keep one quiet, account-wide limit below the focused Codex pane. The backend
// owns both the cross-process refresh lock and the authoritative expiry time.
let codexUsageData = null;
let codexUsagePending = null;
let codexUsageTimer = null;

function codexResetLabel(seconds) {
  const d = new Date(Number(seconds) * 1000);
  if (!Number.isFinite(d.getTime())) return { short: "—", full: "重置时间未知" };
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  const short = sameDay ? hm : (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
  return { short: short + " 重置", full: d.toLocaleString("zh-CN") + " 重置" };
}
function codexPercent(value) {
  const n = Math.max(0, Math.min(100, Number(value) || 0));
  return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
}
function renderCodexUsage(p) {
  if (!p || !p.usage) return;
  const isCodex = !!(p === active && p.tab && p.tab.type === "codex");
  p.usage.classList.toggle("hidden", !isCodex);
  if (!isCodex) return;

  const window = codexUsageData && codexUsageData.window;
  p.usage.classList.toggle("is-stale", !!(codexUsageData && codexUsageData.stale));
  if (!window) {
    const failed = codexUsageData && codexUsageData.error;
    p.usage.setAttribute("aria-busy", String(!failed));
    p.usage.innerHTML = '<div class="codex-usage-state">' +
      (failed ? '<span class="codex-usage-error" aria-hidden="true">!</span>' : '<span class="codex-usage-spinner" aria-hidden="true"></span>') +
      '<span>' + (failed ? "Codex 用量暂时不可用" : "正在读取 Codex 用量…") + '</span>' +
      (failed ? '<button class="codex-usage-retry" type="button" title="重新读取" aria-label="重新读取 Codex 用量">↻</button>' : "") +
      '</div>';
    requestAnimationFrame(() => refit(p));
    return;
  }

  p.usage.setAttribute("aria-busy", "false");
  const remaining = Math.max(0, Math.min(100, Number(window.remainingPercent) || 0));
  const tone = remaining <= 10 ? " critical" : remaining <= 30 ? " warning" : "";
  const reset = codexResetLabel(window.resetsAt);
  const title = "Codex · 已用 " + codexPercent(window.usedPercent) + "% · " + reset.full;
  const aria = "Codex 剩余 " + codexPercent(remaining) + "%，" + reset.full;
  p.usage.innerHTML = '<div class="codex-usage-row' + tone + '" title="' + esc(title) + '" aria-label="' + esc(aria) + '">' +
    '<span class="codex-usage-meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + remaining + '"><i style="width:' + remaining + '%"></i></span>' +
    '<span class="codex-usage-value">' + codexPercent(remaining) + '%</span>' +
    '<span class="codex-usage-reset">' + esc(reset.short) + '</span>' +
    '</div>';
  requestAnimationFrame(() => refit(p));
}
function renderAllCodexUsage() { panes.forEach(renderCodexUsage); }
function scheduleCodexUsageRefresh() {
  clearTimeout(codexUsageTimer);
  codexUsageTimer = null;
  if (document.visibilityState !== "visible" || !active || !active.tab || active.tab.type !== "codex") return;
  const nextAt = Number(codexUsageData && codexUsageData.nextRefreshAt) * 1000;
  const fallback = 10 * 60 * 1000;
  const delay = Number.isFinite(nextAt) && nextAt > 0
    ? Math.max(3000, Math.min(10 * 60 * 1000 + 3000, nextAt - Date.now() + 3000))
    : fallback;
  codexUsageTimer = setTimeout(() => {
    codexUsageTimer = null;
    refreshCodexUsage(false);
  }, delay);
}
async function refreshCodexUsage(force) {
  if (document.visibilityState !== "visible" || !active || !active.tab || active.tab.type !== "codex") {
    scheduleCodexUsageRefresh();
    return;
  }
  const nextAt = Number(codexUsageData && codexUsageData.nextRefreshAt) * 1000;
  if (!force && codexUsageData && codexUsageData.window && Number.isFinite(nextAt) && Date.now() < nextAt) {
    renderAllCodexUsage();
    scheduleCodexUsageRefresh();
    return;
  }
  if (codexUsagePending) return codexUsagePending;
  if (!codexUsageData) renderAllCodexUsage();
  codexUsagePending = (async () => {
    try {
      codexUsageData = await api("/api/codex/usage");
    } catch (e) {
      if (codexUsageData && !codexUsageData.error) codexUsageData.stale = true;
      else codexUsageData = { window: null, error: true };
    } finally {
      codexUsagePending = null;
      renderAllCodexUsage();
      scheduleCodexUsageRefresh();
    }
  })();
  return codexUsagePending;
}
function focusPane(p, focusTerminal = true) {
  if (!p || p === active) { if (p && focusTerminal) try { p.term && p.term.focus(); } catch (e) {} return; }
  active = p;
  updateRestartControls();
  updateQuickCommandState();
  if (maximizedPane && maximizedPane !== p) { maximizedPane = p; layoutPanes(); }
  panes.forEach((x) => x.el.classList.toggle("focused", x === active));
  renderAllCodexUsage();
  scheduleCodexUsageRefresh();
  if (p.tab && p.tab.type === "codex") refreshCodexUsage(false);
  if (p.tab) {
    const disp = p.tab.name || p.tab.title || ("cc_" + p.tab.id);
    document.getElementById("term-title").textContent = disp;
    document.getElementById("term-path").textContent = p.tab.cwd || "";
    document.getElementById("topbar-title").textContent = disp;
    setTitlebar(disp + "  —  cc_" + p.tab.id);
    state.activeId = p.tab.id;
    saveActiveId(p.tab.id);
    renderTabs();
  }
  window.ccWorkspace?.focusChanged();
  window.ccAppearance?.sync();
  if (focusTerminal) try { p.term && p.term.focus(); } catch (e) {}
}

function togglePaneMaximized(p) {
  maximizedPane = maximizedPane === p ? null : p;
  focusPane(p, false);
  layoutPanes();
}

// Swap two cells' positions. We move the pane ELEMENTS (never re-create the
// terminals), so sessions, scrollback and sockets are untouched by a swap.
let dragSrcPane = null;
function swapPanes(i, j) {
  if (i < 0 || j < 0 || i === j || i >= panes.length || j >= panes.length) return;
  const box = document.getElementById("panes");
  const t = panes[i]; panes[i] = panes[j]; panes[j] = t;
  // appendChild MOVES an existing node, so walking the array re-orders the DOM.
  panes.forEach((x) => box.appendChild(x.el));
  layoutPanes(); savePaneLayout();
  // cells may now have different sizes — re-fit, then force a repaint
  setTimeout(() => {
    refitAll();
    panes.forEach((x) => { try { x.term && x.term.refresh(0, x.term.rows - 1); } catch (e) {} });
    if (active && active.term) { try { active.term.focus(); } catch (e) {} }
  }, 60);
}

function makePane() {
  const el = document.createElement("div");
  el.className = "pane";
  el.innerHTML =
    '<div class="pane-bar" draggable="true" title="拖动此栏可与其它格交换位置">' +
    '<span class="status-dot grey"></span><span class="pane-name">空白分屏</span>' +
    '<span class="pane-conn">—</span>' +
    '<button class="pane-expand" title="放大此窗" aria-label="放大此窗" aria-pressed="false">⛶</button>' +
    '<button class="pane-restart hidden" title="重启并恢复原会话" aria-label="重启并恢复原会话"></button>' +
    '<button class="pane-swap" title="与下一格交换位置">⇄</button>' +
    '<button class="pane-x" title="关闭此格">✕</button></div>' +
    '<div class="pane-host"></div>' +
    '<div class="codex-usage hidden" aria-live="polite"></div>';
  setCommandIcon(el.querySelector(".pane-expand"), "Maximize2");
  setCommandIcon(el.querySelector(".pane-restart"), "RotateCw");
  setCommandIcon(el.querySelector(".pane-swap"), "ArrowLeftRight");
  setCommandIcon(el.querySelector(".pane-x"), "X");
  const p = { el, host: el.querySelector(".pane-host"), usage: el.querySelector(".codex-usage"), term: null, fit: null, ws: null, tab: null, dead: false, closedByUser: false, gen: 0, _reconnectTimer: null, _disposeWheel: null, _disposeIme: null };
  el.querySelector(".pane-expand").onclick = e => { e.stopPropagation(); togglePaneMaximized(p); };
  el.querySelector(".pane-restart").onclick = e => { e.stopPropagation(); requestRestartTab(p.tab); };
  el.querySelector(".pane-restart").addEventListener("mousedown", e => e.stopPropagation());
  el.querySelector(".pane-x").onclick = (e) => { e.stopPropagation(); closePane(p); };
  el.querySelector(".pane-swap").onclick = (e) => {
    e.stopPropagation();
    if (panes.length < 2) { showToast("只有一格 · 先点 ⧉ 分屏"); return; }
    const i = panes.indexOf(p);
    swapPanes(i, (i + 1) % panes.length);   // cyclic: last swaps with first
  };
  const focus = () => focusPane(p);
  el.addEventListener("mousedown", focus);
  el.addEventListener("touchstart", () => focusPane(p, false), { passive: true });
  p.usage.addEventListener("click", (e) => {
    const retry = e.target.closest && e.target.closest(".codex-usage-retry");
    if (!retry) return;
    e.preventDefault(); e.stopPropagation();
    codexUsageData = null;
    refreshCodexUsage(true);
  });

  // drag the title bar onto another cell to swap the two
  const bar = el.querySelector(".pane-bar");
  bar.addEventListener("dragstart", (e) => {
    dragSrcPane = p; el.classList.add("dragging");
    try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "cc-pane"); } catch (_) {}
  });
  bar.addEventListener("dragend", () => {
    dragSrcPane = null; el.classList.remove("dragging");
    panes.forEach((x) => x.el.classList.remove("drop-target"));
  });
  el.addEventListener("dragover", (e) => {
    if (!dragSrcPane || dragSrcPane === p) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch (_) {}
    el.classList.add("drop-target");
  });
  el.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget || !el.contains(e.relatedTarget)) el.classList.remove("drop-target");
  });
  el.addEventListener("drop", (e) => {
    el.classList.remove("drop-target");
    if (!dragSrcPane || dragSrcPane === p) return;
    e.preventDefault(); e.stopPropagation();
    swapPanes(panes.indexOf(dragSrcPane), panes.indexOf(p));
    dragSrcPane = null;
  });

  document.getElementById("panes").appendChild(el);
  panes.push(p);
  if (workspaceResizeObserver) workspaceResizeObserver.observe(p.host);
  showPaneEmpty(p);
  return p;
}
function showPaneEmpty(p) {
  if (p.usage) p.usage.classList.add("hidden");
  p.host.innerHTML = '<div class="pane-empty"><div class="big">＋</div><div>点这里,或从左侧列表选一个终端</div></div>';
  const ph = p.host.querySelector(".pane-empty");
  if (ph) ph.onclick = () => { focusPane(p, false); window.ccWorkspace ? window.ccWorkspace.openSplitPicker() : openDirModal(); };
}
function teardownPane(p, keepEl) {
  window.ccNativeInput?.detach(p);
  window.ccAppearance?.detach(p);
  if (!keepEl && maximizedPane === p) maximizedPane = null;
  // Bump the generation FIRST: ws.close() is async, so the old socket's onclose
  // fires after attachTerminal has already reset dead/closedByUser for the new
  // mount. Without this the stale closure would "reconnect" the OLD session and
  // overwrite p.ws — the pane then showed one terminal but typed into another.
  p.gen = (p.gen || 0) + 1;
  p.dead = true; p.closedByUser = true;
  if (p._reconnectTimer) { clearTimeout(p._reconnectTimer); p._reconnectTimer = null; }
  if (!keepEl && workspaceResizeObserver) workspaceResizeObserver.unobserve(p.host);
  p._lastResize = null;
  try { p._disposeWheel && p._disposeWheel(); } catch (e) {}
  try { p._disposeIme && p._disposeIme(); } catch (e) {}
  try { p._disposeTouchSel && p._disposeTouchSel(); } catch (e) {}
  try { p._disposeTouchScroll && p._disposeTouchScroll(); } catch (e) {}
  try { p.ws && p.ws.close(); } catch (e) {}
  try { p.term && p.term.dispose(); } catch (e) {}
  p.ws = null; p.term = null; p.fit = null;
  if (!keepEl && p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el);
}
function closePane(p) {
  const i = panes.indexOf(p);
  if (i === -1) return;
  teardownPane(p);
  panes.splice(i, 1);
  ctrlArmed = false; updateCtrlCap();
  if (active === p) active = null;
  if (!panes.length) { closeActiveView(); return; }   // last cell closed → empty state
  focusPane(active || panes[Math.min(i, panes.length - 1)]);
  layoutPanes(); savePaneLayout();
}
function splitPane() {
  if (panes.length >= MAX_PANES) { showToast("最多 " + MAX_PANES + " 格"); return; }
  if (!panes.length) { document.getElementById("empty").classList.add("hidden"); document.getElementById("term-view").classList.remove("hidden"); }
  const p = makePane();
  maximizedPane = null;
  active = p;
  updateQuickCommandState();
  updateRestartControls();
  layoutPanes(); savePaneLayout();
  showToast("已新增分屏 · 从左侧选一个终端,或点空格新建");
  if (mqMobile.matches) body.classList.add("drawer-open");
}
// Actual on-screen height of one terminal row. Everything that converts a
// scroll gesture into "how many lines" has to use this — a fixed pixels-per-line
// constant silently over-scrolls as soon as the font size changes.
function rowPx(term) {
  try {
    const sc = term && term.element && term.element.querySelector(".xterm-screen");
    const r = sc && sc.getBoundingClientRect();
    if (r && r.height && term.rows) return Math.max(4, r.height / term.rows);
  } catch (e) {}
  return 18;
}
function wheelToLines(ev, term) {
  const raw = ev && ev.deltaY ? ev.deltaY : 0;
  if (!Number.isFinite(raw) || !raw) return 0;
  // xterm divides pixel deltas by the real row height; this used to divide by a
  // hardcoded 18, so at a large font one row of finger travel scrolled ~2 rows.
  const unit = ev.deltaMode === 1 ? 1 : ev.deltaMode === 2 ? (term ? term.rows : 24) : 1 / rowPx(term);
  const lines = Math.min(120, Math.abs(raw) * unit);
  return raw > 0 ? lines : -lines;
}
function wheelRow(ev, term) {
  const screen = term.element && term.element.querySelector(".xterm-screen");
  const rect = screen && screen.getBoundingClientRect();
  if (!rect || !rect.height || !Number.isFinite(ev.clientY) || ev.clientY < rect.top || ev.clientY >= rect.bottom) return Math.min(term.rows, 2);
  return Math.max(1, Math.min(term.rows, Math.floor((ev.clientY - rect.top) / rowPx(term)) + 1));
}
// Our own SGR wheel report coming back in the OUTPUT stream can only mean one
// thing: whatever is on the other end is echoing it as text instead of reading
// it. Only the SGR form is matched — a bare "\x1b[M" is also CSI DL (delete
// line), which apps emit legitimately, so matching that would misfire.
// Two forms to catch: the raw bytes, and the caret notation the tty line
// discipline produces when a shell echoes a control character (ESC comes back
// as the two visible chars "^["), which is what actually lands on screen.
const MOUSE_ECHO_RE = /(?:\x1b|\^\[)\[<6[45];\d+;\d+[Mm]/;
let _echoDecoder = null;
function noteMouseEcho(pane, bytes) {
  if (!pane || !pane.echoProbeUntil || Date.now() > pane.echoProbeUntil) return;
  try {
    if (!_echoDecoder) _echoDecoder = new TextDecoder("latin1");
    if (!MOUSE_ECHO_RE.test(_echoDecoder.decode(bytes))) return;
  } catch (e) { return; }
  pane.echoProbeUntil = 0;
  if (pane.mouseEcho) return;
  pane.mouseEcho = true;
  showToast("这个终端的程序已退出但没关掉鼠标上报,滚轮回显成了乱码。已改用 tmux 滚动;乱码按 Ctrl+U 可清掉");
}

function appWantsMouse(term, pane) {
  // Because we run over `tmux attach`, tmux itself holds the outer terminal on
  // the alternate screen, so xterm's buffer type is ALWAYS "alternate" and can't
  // tell claude from codex. The reliable signal is whether the inner app enabled
  // mouse reporting (tmux passes it through): claude does, codex/plain-shell don't.
  let m = "none";
  try { m = (term.modes && term.modes.mouseTrackingMode) || "none"; } catch (e) { return false; }
  if (m === "none") {
    if (pane) pane.mouseEcho = false;      // mode reset ⇒ a future TUI gets a clean slate
    return false;
  }
  // A TUI that died without sending ?1000l leaves reporting on, and the wheel
  // then goes to whatever took its place — usually a shell, which echoes our
  // escape bytes and papers the whole screen with them. Once caught, scroll
  // through tmux instead.
  return !(pane && pane.mouseEcho);
}
function attachTerminalWheelHandler(term, host, pane) {
  // Two kinds of sessions need opposite handling:
  //  • mouse-reporting apps (claude): forward the wheel so the app scrolls its
  //    own view — tmux has no scrollback for them (they own the inner screen).
  //  • non-mouse apps: the server chooses normal-buffer tmux history or native
  //    wheel events for fullscreen Codex. We must also swallow the
  //    event so xterm's alternate-scroll-mode doesn't turn the wheel into arrow
  //    keys (which is why codex's wheel only moved the input box).
  let remainder = 0, lastWheelAt = 0, lastSocket = null;
  const handler = (ev) => {
    if (appWantsMouse(term, pane || active)) {
      remainder = 0;
      lastSocket = null;
      const p = pane || active;
      if (p) p.echoProbeUntil = Date.now() + 600;   // watch the next output for our own bytes
      return true;                                  // native: forward wheel to the app
    }
    const delta = wheelToLines(ev, term);
    const ws = (pane || active) && (pane || active).ws;
    if (!ws || ws.readyState !== 1) {
      remainder = 0;
      lastSocket = null;
    } else if (delta) {
      const now = Date.now();
      // Keep sub-row trackpad movement within this pane and gesture only.
      if (ws !== lastSocket || now - lastWheelAt > 250 || delta * remainder < 0) remainder = 0;
      lastSocket = ws;
      lastWheelAt = now;
      remainder += delta;
      const lines = Math.trunc(remainder);
      remainder -= lines;
      if (lines) ws.send(JSON.stringify({ type: "scroll", lines, row: wheelRow(ev, term) }));
    }
    if (ev && ev.preventDefault) ev.preventDefault();
    if (ev && ev.stopPropagation) ev.stopPropagation();
    return false;
  };
  const hasCustomHandler = typeof term.attachCustomWheelEventHandler === "function";
  if (hasCustomHandler) {
    term.attachCustomWheelEventHandler(handler);
  }
  const domHandler = (ev) => {
    // Chromium represents trackpad pinch as Ctrl+wheel. Leave browser zoom
    // intact before xterm can cancel it or send it to the terminal program.
    if (ev.ctrlKey) {
      remainder = 0;
      ev.stopPropagation();
      return;
    }
    // Fit leaves padding and sometimes an unpainted row below the screen.
    // Capture non-mouse scrolling on the whole host, not only xterm's surface.
    if (!hasCustomHandler || !appWantsMouse(term, pane || active)) handler(ev);
  };
  host.addEventListener("wheel", domHandler, { passive: false, capture: true });
  return () => host.removeEventListener("wheel", domHandler, { capture: true });
}

// iPadOS/iOS with a CJK IME never delivers punctuation to xterm. The key press
// arrives as keydown keyCode 229 (the "IME is processing" key), so xterm's
// _keyDown bails out early — but it has already set _keyDownSeen = true. The
// `insertText` input event that follows is then rejected by xterm's own
// de-dup guard `(!ev.composed || !this._keyDownSeen)`: `composed` is always true
// for real user events, and keyup (which clears _keyDownSeen) fires *after*
// input. Its only fallback, _handleAnyTextareaChanges(), gives up whenever a
// composition is open — exactly the CJK case. Result: the character is dropped,
// and you have to switch the IME to English to type "," or ".".
//
// So we take the insertText path ourselves, before xterm sees it, and
// preventDefault: the textarea value never changes, so xterm's diff fallback
// finds nothing and the `input` event is never dispatched at all — no double
// send. Compositions are left strictly alone so pinyin candidates still work.
function attachImeInput(term, pane) {
  const ta = term.textarea;
  if (!ta) return () => {};
  // iOS smart punctuation is poison in a terminal: it turns " into curly quotes
  // and -- into an em dash, and capitalises the first word of every command.
  ta.setAttribute("autocapitalize", "none");
  ta.setAttribute("autocorrect", "off");
  ta.setAttribute("autocomplete", "off");
  ta.setAttribute("spellcheck", "false");

  // xterm only preventDefaults keydown for the keys it handles there; plain
  // printable chars that fall through to _keyPress are NOT cancelled, so their
  // beforeinput still reaches us after xterm already sent the character. A
  // keypress therefore arms a one-shot skip, consumed by the next beforeinput.
  let skipNext = false;
  const onKeyDown = () => { skipNext = false; };
  const onKeyPress = () => { skipNext = true; };

  const onBeforeInput = (ev) => {
    const armed = skipNext; skipNext = false;
    if (armed) return;                       // xterm's _keyPress already sent it
    if (ev.isComposing) return;              // mid-composition belongs to xterm
    const t = ev.inputType || "";
    if (t.indexOf("Composition") >= 0) return;
    let data;
    if (t === "insertText") data = ev.data;
    else if (t === "insertLineBreak" || t === "insertParagraph") data = "\r";
    else if (t === "deleteContentBackward") data = "\x7f";
    else return;                             // paste, replacements, … stay with xterm
    if (!data) return;
    ev.preventDefault();                     // no textarea change ⇒ no `input` ⇒ no dupe
    deliverTo(pane, data);
  };

  ta.addEventListener("keydown", onKeyDown, true);
  ta.addEventListener("keypress", onKeyPress, true);
  ta.addEventListener("beforeinput", onBeforeInput, true);
  return () => {
    try {
      ta.removeEventListener("keydown", onKeyDown, true);
      ta.removeEventListener("keypress", onKeyPress, true);
      ta.removeEventListener("beforeinput", onBeforeInput, true);
    } catch (e) {}
  };
}

const TERM_THEME = {
  dark: {
    background: "#00000000", foreground: "#D1D5DB", cursor: "#D1D5DB", cursorAccent: "#0F1115",
    selectionBackground: "rgba(255,255,255,0.20)",
    black: "#3A3A3A", red: "#FF6B60", green: "#6BD96B", yellow: "#F1D32B", blue: "#6EA8FF",
    magenta: "#D58AFF", cyan: "#62D4D4", white: "#D6D6D6",
    brightBlack: "#6E6E6E", brightRed: "#FF8A80", brightGreen: "#9BE89B", brightYellow: "#FFE45C",
    brightBlue: "#9CC4FF", brightMagenta: "#E3B3FF", brightCyan: "#9CE9E9", brightWhite: "#FFFFFF",
  },
  light: {
    background: "#00000000", foreground: "#27313A", cursor: "#27313A", cursorAccent: "#FBFCFD",
    selectionBackground: "rgba(15,108,189,0.20)",
    black: "#1A1A1A", red: "#C0392B", green: "#1E8E3E", yellow: "#9A6E00", blue: "#1A66D6",
    magenta: "#A21CAF", cyan: "#0E7C86", white: "#3C3C3C",
    brightBlack: "#6E6E73", brightRed: "#D93025", brightGreen: "#188038", brightYellow: "#B06000",
    brightBlue: "#1A73E8", brightMagenta: "#C026D3", brightCyan: "#12808A", brightWhite: "#000000",
  },
};
function termTheme(t = currentTheme()) {
  const base = TERM_THEME[t] || TERM_THEME.dark;
  return window.ccAppearance?.terminalTheme(base, t) || base;
}
function setTitlebar(t) {
  const tab = active && active.tab;
  const el = document.getElementById("titlebar-title"); if (el) el.textContent = tab ? (tab.name || tab.id) : (t || "CC Terminal");
  document.getElementById("workspace-project").textContent = tab ? tabBasename(tab.cwd) : "工作区";
  document.getElementById("footer-session").textContent = tab ? "cc_" + tab.id : "—";
  if (!tab) document.getElementById("footer-state").textContent = "READY";
  document.getElementById("btn-tools").disabled = !tab;
  document.getElementById("topbar-tools").disabled = !tab;
}

// Open `tab` inside a pane (defaults to the focused pane; creates the first one).
function attachTerminal(tab, pane) {
  closeQuickCommands(false);
  document.getElementById("empty").classList.add("hidden");
  document.getElementById("term-view").classList.remove("hidden");

  let p = pane || active || panes[0];
  if (!p) p = makePane();
  if (p.term) teardownPane(p, true);            // reuse the cell: drop its old terminal
  p.dead = false; p.closedByUser = false;
  p.tab = tab;
  state.activeId = tab.id;
  saveActiveId(tab.id);
  renderRecentSessions();
  p.host.innerHTML = "";
  active = p;
  paneHeader(p);
  updateRestartControls();
  renderAllCodexUsage();
  scheduleCodexUsageRefresh();
  if (tab.type === "codex") refreshCodexUsage(false);
  const _disp = tab.name || tab.title || tab.id;
  document.getElementById("term-title").textContent = _disp;
  document.getElementById("term-path").textContent = tab.cwd || "";
  document.getElementById("topbar-title").textContent = _disp;
  setTitlebar(_disp + "  —  cc_" + tab.id);

  const term = new Terminal({
    cursorBlink: true,
    allowTransparency: true,
    fontSize: getFont(),
    fontFamily: TERMINAL_FONT_FAMILY,
    letterSpacing: 0,
    // xterm scales measured glyph height, not CSS font-size (21px rows at 13px).
    lineHeight: 1.25,
    scrollback: 10000,
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    // TUIs can retain explicit backgrounds after a theme change. Keep their
    // text readable without rewriting ANSI output or changing those backgrounds.
    minimumContrastRatio: 4.5,
    // Without this, xterm's shouldForceSelection() on mac/iPadOS is
    // `altKey && macOptionClickForcesSelection` — i.e. always false — so a
    // mouse-reporting app (claude/codex) leaves NO way to select text at all.
    macOptionClickForcesSelection: true,
    theme: termTheme(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const host = p.host;
  term.open(host);
  fit.fit();
  term.onData((d) => deliverTo(p, d));
  const disposeWheel = attachTerminalWheelHandler(term, host, p);
  const disposeIme = attachImeInput(term, p);
  // Browser copy shortcuts must never become SIGINT, even without a selection
  // or when clipboard access fails. Interruption is a separate toolbar command.
  applyKbdMode(term);
  installSelectMode(term);
  const disposeTouchSel = attachTouchSelection(term, host, p);
  const disposeTouchScroll = attachTouchScroll(term, host, p);
  installSelectMode(term);
  // Right-click copies the selection. With no selection we stay out of the way
  // and let the browser's own menu appear.
  host.addEventListener("contextmenu", (ev) => {
    const hit = currentSelection();
    if (!hit) return;                      // nothing selected: leave the native menu alone
    ev.preventDefault();
    copyText(hit.text).then((ok) => showToast(ok ? "已复制选中内容 (" + hit.text.length + " 字)" : "复制失败,浏览器拒绝了剪贴板访问"));
  });
  term.attachCustomKeyEventHandler((ev) => {
    if ((ev.key || "").toLowerCase() !== "c") return true;
    const mac = /Mac|iP(ad|hone|od)/.test(navigator.platform || "") || /Mac|iP(ad|hone|od)/.test(navigator.userAgent);
    const combo = !ev.altKey && ((ev.ctrlKey && !ev.metaKey) || (mac && ev.metaKey && !ev.ctrlKey)
      || (ctrlArmed && !ev.ctrlKey && !ev.metaKey));
    if (!combo) return true;
    ev.preventDefault();
    if (ev.type === "keydown" && !ev.repeat) copyTerminalSelection(p);
    return false;
  });

  p.term = term; p.fit = fit; p.ws = null; p._disposeWheel = disposeWheel; p._disposeIme = disposeIme; p._disposeTouchSel = disposeTouchSel; p._disposeTouchScroll = disposeTouchScroll; p._reconnectTimer = null;
  const self = p;              // bind this connection lifecycle to THIS pane
  const gen = p.gen;           // ...and to THIS mount of it
  const stale = () => self.gen !== gen;

  let backoff = 1000;
  function connect() {
    // Guard on the PANE being alive (and this mount still current), not on it
    // being focused — background panes must keep streaming while you work
    // in another split.
    if (stale() || self.dead || self.closedByUser) return;
    setStatus("connecting", "连接中", self);
    const ws = new WebSocket(wsUrl("/ws/term/" + tab.id));
    ws.binaryType = "arraybuffer";
    self.ws = ws;
    ws.onopen = () => {
      if (stale() || self.dead) { try { ws.close(); } catch (e) {} return; }
      setStatus("connected", "运行中", self); backoff = 1000; refit(self);
      if (active === self) { try { term.focus(); } catch (e) {} }
    };
    ws.onmessage = (e) => {
      if (stale() || self.dead) return;
      const bytes = new Uint8Array(e.data);
      if (self.echoProbeUntil) noteMouseEcho(self, bytes);
      term.write(bytes);
    };
    ws.onclose = () => {
      if (stale()) return;                       // superseded mount: stay quiet
      if (self.dead || self.closedByUser) { setStatus("closed", "已停止", self); return; }
      setStatus("reconnecting", "重连中…", self);
      self._reconnectTimer = setTimeout(() => { if (!stale() && !self.dead && !self.closedByUser) connect(); }, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }
  // NOTE: click/tap focusing is wired once in makePane() on the pane element —
  // re-adding it per mount stacked stale listeners holding disposed terminals.
  connect();
  layoutPanes(); savePaneLayout(); updateSelectBtn();
  // Defer focus one frame: on a synchronous tab-switch the xterm textarea isn't
  // laid out yet, so an immediate focus() silently no-ops (worked only after a
  // refresh, which mounts async). rAF + a timeout backstop makes it stick.
  requestAnimationFrame(() => { if (active === p) try { term.focus(); } catch (e) {} });
  setTimeout(() => { if (active === p && p.term) try { p.term.focus(); } catch (e) {} }, 80);
  window.ccAppearance?.sync();
  window.ccNativeInput?.sync();
}

function closeAllPanes() {
  panes.forEach((p) => teardownPane(p));
  panes = []; active = null; maximizedPane = null;
  updateQuickCommandState();
  updateRestartControls();
  clearTimeout(codexUsageTimer); codexUsageTimer = null;
  ctrlArmed = false; updateCtrlCap();
  document.getElementById("panes").innerHTML = "";
  document.getElementById("topbar-status").textContent = "";
  savePaneLayout();
  for (const id of ["btn-split", "header-split"]) document.getElementById(id).disabled = false;
}
function closeActiveView() {
  toggleTools(false);
  closeAllPanes();
  document.getElementById("term-view").classList.add("hidden");
  document.getElementById("empty").classList.remove("hidden");
  setTitlebar();
}
document.getElementById("btn-stop").onclick = () => { requestStopActive(); };
document.getElementById("btn-interrupt").onclick = requestInterruptActive;
document.getElementById("btn-restart").onclick = () => { if (active) requestRestartTab(active.tab); };

// ---- fullscreen + aux-key bar toggle ---------------------------------------
function isFs() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
function toggleFullscreen() {
  try {
    if (isFs()) {
      const r = (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      if (r && r.catch) r.catch(() => {});
    } else {
      const el = document.documentElement;
      const r = (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
      if (r && r.catch) r.catch(() => showToast("此浏览器不支持网页全屏"));
    }
  } catch (e) { showToast("此浏览器不支持网页全屏"); }
}
function updateFsBtn() {
  const b = document.getElementById("btn-fs");
  if (b) {
    b.textContent = isFs() ? "⤢" : "⛶";
    setCommandIcon(b, isFs() ? "Minimize" : "Maximize");
    b.title = isFs() ? "退出全屏" : "全屏";
    b.setAttribute("aria-label", b.title);
  }
  const titleButton = document.getElementById("tl-green");
  if (titleButton) {
    titleButton.textContent = isFs() ? "⤢" : "⛶";
    setCommandIcon(titleButton, isFs() ? "Minimize" : "Maximize");
    titleButton.title = isFs() ? "退出全屏" : "全屏";
    titleButton.setAttribute("aria-label", titleButton.title);
  }
}
function onFsChange() { updateFsBtn(); setTimeout(refitAll, 80); }
document.addEventListener("fullscreenchange", onFsChange);
document.addEventListener("webkitfullscreenchange", onFsChange);
document.getElementById("btn-fs").onclick = toggleFullscreen;
document.getElementById("tl-green").onclick = toggleFullscreen;

function toggleAux() {
  closeQuickCommands(false);
  const bar = document.getElementById("auxbar");
  const visible = getComputedStyle(bar).display !== "none";
  document.body.classList.remove("aux-shown", "aux-hidden");
  document.body.classList.add(visible ? "aux-hidden" : "aux-shown");
  setTimeout(refitAll, 80);
}
document.getElementById("btn-aux").onclick = toggleAux;
document.getElementById("btn-split").onclick = splitPane;
document.getElementById("btn-dir").onclick = cyclePaneDir;

// ---- sidebar collapse (desktop) --------------------------------------------
function applySidebarState() {
  const hidden = localStorage.getItem("cc_sb_hidden") === "1";
  document.body.classList.toggle("sb-collapsed", hidden);
  const b = document.getElementById("btn-sidebar");
  if (b) {
    b.textContent = "☰";
    setCommandIcon(b, hidden ? "PanelLeftOpen" : "PanelLeftClose");
    b.title = hidden ? "显示侧边栏" : "隐藏侧边栏";
    b.setAttribute("aria-label", b.title);
    b.setAttribute("aria-expanded", String(!hidden));
  }
}
function setSidebarHidden(hidden) {
  localStorage.setItem("cc_sb_hidden", hidden ? "1" : "0");
  applySidebarState();
  // the terminals just got wider/narrower — re-fit after the CSS transition
  setTimeout(() => { applyPaneDir(); refitAll(); }, 210);
}
function toggleSidebar() { setSidebarHidden(localStorage.getItem("cc_sb_hidden") !== "1"); }
document.getElementById("window-minimise").onclick = () => { if (mqMobile.matches) closeDrawer(); else toggleSidebar(); };
document.getElementById("window-close").onclick = closeActiveView;
document.getElementById("btn-sidebar").onclick = toggleSidebar;
applySidebarState();
// Also covers browsers without ResizeObserver and viewport breakpoint changes.
window.addEventListener("resize", () => scheduleWorkspaceFit(true));
mqMobile.addEventListener("change", (e) => { if (!e.matches) closeDrawer(); });
updateDirBtn();

// ---- send image into the terminal ------------------------------------------
// The PTY is a byte stream, so we can't feed raw image bytes through it. Instead
// upload the image to <cwd>/.cc-web-images/ and TYPE its path into the terminal,
// which claude (and codex at launch) reads as an attached image. A dedicated
// modal collects images via pick / paste / drag so nothing races xterm's own
// keyboard/paste handling.
function imageFilesFrom(list) {
  return Array.from(list || []).filter((f) => f && f.type && f.type.indexOf("image/") === 0);
}
async function uploadOneImage(file, cwd) {
  const fd = new FormData();
  fd.append("cwd", cwd);
  fd.append("file", file, file.name || "image.png");
  const headers = getToken() ? { Authorization: "Bearer " + getToken() } : {};
  const r = await fetch("/api/term/image", { method: "POST", body: fd, headers, credentials: "same-origin" });
  if (r.status === 401) { setTokenPrompt(); throw new Error("需要有效 Token"); }
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch (e) {} throw new Error(m); }
  return (await r.json()).path;
}

// --- image modal (pick / paste / drag) ---
let imgStaged = []; // [{ file, url }]
let imgTarget = null;
function openImgModal(target) {
  if (!active || !active.tab) { showToast("请先打开一个终端"); return; }
  const pane = target && target.pane ? target.pane : active;
  imgTarget = { pane, gen: pane.gen };
  imgStaged.forEach((s) => { try { URL.revokeObjectURL(s.url); } catch (e) {} });
  imgStaged = [];
  renderImgStaged();
  openLayer(document.getElementById("img-modal"), true);
  setTimeout(() => { try { document.getElementById("img-drop").focus(); } catch (e) {} }, 30);
}
function closeImgModal(returnToTerminal) {
  const modal = document.getElementById("img-modal");
  if (returnToTerminal === true) modal.__ccReturnFocus = active && active.term ? active.term.textarea : null;
  closeLayer(modal, () => {
    imgStaged.forEach((s) => { try { URL.revokeObjectURL(s.url); } catch (e) {} });
    imgStaged = [];
    renderImgStaged();
  });
}
function imgModalOpen() { return layerOpen(document.getElementById("img-modal")); }
function addStagedImages(files) {
  const imgs = imageFilesFrom(files);
  if (!imgs.length) { if (files && files.length) showToast("请选择图片文件"); return; }
  imgs.forEach((f) => imgStaged.push({ file: f, url: URL.createObjectURL(f) }));
  renderImgStaged();
}
function renderImgStaged() {
  const box = document.getElementById("img-previews");
  box.innerHTML = "";
  imgStaged.forEach((s, i) => {
    const d = document.createElement("div");
    d.className = "img-thumb";
    d.innerHTML = '<img src="' + s.url + '" alt="" /><button class="rm" title="移除">✕</button>';
    d.querySelector(".rm").onclick = () => {
      try { URL.revokeObjectURL(s.url); } catch (e) {}
      imgStaged.splice(i, 1); renderImgStaged();
    };
    box.appendChild(d);
  });
  document.getElementById("img-send").disabled = imgStaged.length === 0;
  document.getElementById("img-hint").textContent = imgStaged.length
    ? ("已选 " + imgStaged.length + " 张,点「发送到终端」")
    : "支持 png / jpg / gif / webp,可一次多张";
}
async function sendStagedImages() {
  const target = imgTarget;
  const pane = target && target.pane;
  if (!imgStaged.length) return;
  if (!pane || !pane.tab || pane.gen !== target.gen || !pane.term) {
    showToast("原终端已关闭,请选择终端后重新添加图片"); closeImgModal(); return;
  }
  if (!pane.ws || pane.ws.readyState !== 1) { showToast("终端未连接,图片已保留"); return; }
  const cwd = pane.tab.cwd || "";
  if (!cwd) { showToast("此终端没有工作目录,无法存图"); return; }
  const btn = document.getElementById("img-send");
  setButtonBusy(btn, true);
  document.getElementById("img-hint").textContent = "上传中…";
  const paths = [];
  for (const s of imgStaged) {
    try { paths.push(await uploadOneImage(s.file, cwd)); }
    catch (e) { showToast("有图片上传失败 · " + e.message); }
  }
  if (paths.length && pane.gen === target.gen && pane.term) {
    const text = paths.join(" ") + " ";
    if (!pane.ws || pane.ws.readyState !== 1) { showToast("图片已上传,终端已断线,未插入路径"); }
    else { sendInputTo(pane, text); showToast("已插入 " + paths.length + " 张图片路径"); }
  } else if (paths.length) {
    showToast("图片已上传,原终端已关闭,未插入路径");
  }
  setButtonBusy(btn, false);
  closeImgModal(true);
}

// wiring: toolbar button opens the modal
document.getElementById("btn-img").onclick = openImgModal;
document.getElementById("img-close").onclick = closeImgModal;
document.getElementById("img-send").onclick = sendStagedImages;
document.getElementById("img-modal").addEventListener("mousedown", (e) => {
  if (e.target.id === "img-modal") closeImgModal(); // click backdrop to close
});
// drop-zone: click to pick
const _imgDrop = document.getElementById("img-drop");
const _imgInput = document.getElementById("img-file-input");
_imgDrop.onclick = () => _imgInput.click();
_imgInput.onchange = (e) => { addStagedImages(e.target.files); e.target.value = ""; };
// drop-zone: drag & drop
["dragenter", "dragover"].forEach((t) => _imgDrop.addEventListener(t, (e) => {
  e.preventDefault(); _imgDrop.classList.add("drag-over");
}));
["dragleave", "dragend"].forEach((t) => _imgDrop.addEventListener(t, () => _imgDrop.classList.remove("drag-over")));
_imgDrop.addEventListener("drop", (e) => {
  e.preventDefault(); _imgDrop.classList.remove("drag-over");
  addStagedImages(e.dataTransfer && e.dataTransfer.files);
});
// paste: when the modal is open, capture image paste into the staging area
document.addEventListener("paste", (ev) => {
  if (!imgModalOpen()) return;
  const items = (ev.clipboardData && ev.clipboardData.items) || [];
  const imgs = [];
  for (const it of items) {
    if (it.kind === "file" && it.type && it.type.indexOf("image/") === 0) {
      const f = it.getAsFile(); if (f) imgs.push(f);
    }
  }
  if (imgs.length) { ev.preventDefault(); ev.stopPropagation(); addStagedImages(imgs); }
}, true);
// Esc closes the modal
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && imgModalOpen()) closeImgModal(); });

// ---- presence (leak monitoring) --------------------------------------------
function getClientId() {
  let c = localStorage.getItem("cc_client");
  if (!c) { c = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2); localStorage.setItem("cc_client", c); }
  return c;
}
function renderPresence(s) {
  // The alert is about STRANGERS, not headcount: your own laptop + tablet being
  // online is normal, an IP you've never named is the thing worth noticing.
  const alarm = (s.strangers || 0) > 0;
  document.getElementById("presence-n").textContent = s.count;
  const btn = document.getElementById("presence-btn");
  btn.classList.toggle("alert", alarm);
  btn.querySelector(".pdot").className = "pdot" + (alarm ? " alert" : "");
  const tp = document.getElementById("topbar-presence");
  tp.textContent = "● " + s.count + (alarm ? " ⚠" : "");
  tp.classList.toggle("alert", alarm);
  document.getElementById("pp-list").innerHTML = s.ips.map((ip) => {
    const known = ip.trust === "known";
    const tags = [];
    if (ip.you) tags.push('<span class="tag you">你</span>');
    if (!known && !ip.you) tags.push('<span class="tag warn">陌生</span>');
    if (ip.trust === "blocked") tags.push('<span class="tag warn">已标记</span>');
    if (ip.clients > 1) tags.push('<span class="tag">' + ip.clients + " 个页面</span>");
    if (ip.terminals) tags.push('<span class="tag">' + ip.terminals + " 终端</span>");
    // Through the frp TCP tunnel every public visitor shares one IP, so the
    // device label is the only thing that separates them.
    const dev = (ip.devices || []).length ? '<span class="pp-dev">' + esc(ip.devices.join(" · ")) + "</span>" : "";
    const title = known ? '<span class="pp-name">' + esc(ip.name) + "</span>" : "";
    return '<div class="pp-row' + (known || ip.you ? "" : " other") + '" data-ip="' + esc(ip.ip) + '">' +
      title + '<span class="pp-ip">' + esc(ip.label || ip.ip) + "</span>" + dev +
      '<span class="pp-tags">' + tags.join("") + "</span>" +
      '<button class="pp-edit" data-ip="' + esc(ip.ip) + '" title="备注这个 IP">✎</button></div>';
  }).join("") || '<div class="pp-note">暂无</div>';
  document.querySelectorAll("#pp-list .pp-edit").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); nameIp(b.dataset.ip); }; });
}
async function nameIp(ip, current) {
  const name = await uiPrompt("备注 " + ip, current || "", "✎");
  if (name === undefined) return;
  try {
    await api("/api/ips", { method: "POST", body: JSON.stringify({ ip, name }) });
    showToast(name ? "已记为熟人:" + name : "已取消备注");
    heartbeat(); if (ipsModalOpen()) loadIps();
  } catch (e) { showToast(e.message || "保存失败"); }
}

// ---- IP ledger (熟人 / 陌生人) ----------------------------------------------
function ipsModalOpen() { return layerOpen(document.getElementById("ips-modal")); }
function openIpsModal() { openLayer(document.getElementById("ips-modal"), true); loadIps(); }
function closeIpsModal() { closeLayer(document.getElementById("ips-modal")); }
function ago(ts) {
  if (!ts) return "—";
  const d = Math.max(0, Date.now() / 1000 - ts);
  if (d < 60) return "刚刚";
  if (d < 3600) return Math.floor(d / 60) + " 分钟前";
  if (d < 86400) return Math.floor(d / 3600) + " 小时前";
  return Math.floor(d / 86400) + " 天前";
}
async function loadIps() {
  const body = document.getElementById("ips-body");
  try {
    const d = await api("/api/ips");
    const rows = d.ips || [];
    if (!rows.length) { body.innerHTML = '<div class="pp-note">还没有记录</div>'; return; }
    body.innerHTML = rows.map((e) => {
      const known = e.trust === "known";
      return '<div class="ip-row' + (known ? " known" : e.trust === "blocked" ? " blocked" : " unknown") + '">' +
        '<div class="ip-main"><span class="ip-addr">' + esc(e.ip) + "</span>" +
        (e.name ? '<span class="ip-name">' + esc(e.name) + "</span>" : '<span class="ip-tag warn">陌生</span>') +
        (e.trust === "blocked" ? '<span class="ip-tag warn">已标记</span>' : "") + "</div>" +
        '<div class="ip-meta">' + esc((e.devices || []).join(" · ") || "—") +
        " · 首次 " + ago(e.first_seen) + " · 最近 " + ago(e.last_seen) + " · " + (e.hits || 0) + " 次</div>" +
        '<div class="ip-acts">' +
        '<button class="btn-sm" data-act="name" data-ip="' + esc(e.ip) + '">✎ 备注</button>' +
        '<button class="btn-sm" data-act="block" data-ip="' + esc(e.ip) + '">⚑ 标记可疑</button>' +
        '<button class="btn-sm" data-act="forget" data-ip="' + esc(e.ip) + '">✕ 删除</button>' +
        "</div></div>";
    }).join("");
    body.querySelectorAll("[data-act]").forEach((b) => {
      b.onclick = async () => {
        const ip = b.dataset.ip;
        if (b.dataset.act === "name") return nameIp(ip, (rows.find((x) => x.ip === ip) || {}).name);
        if (b.dataset.act === "forget" && !(await uiConfirm("删除 " + ip + " 的记录?", "它下次出现时会重新算作陌生。", true))) return;
        try {
          await api("/api/ips", { method: "POST", body: JSON.stringify(
            b.dataset.act === "forget" ? { action: "forget", ip } : { ip, trust: "blocked" }) });
          loadIps(); heartbeat();
        } catch (e) { showToast(e.message || "操作失败"); }
      };
    });
  } catch (e) { body.innerHTML = '<div class="pp-note">读取失败:' + esc(String(e.message || e)) + "</div>"; }
}
document.getElementById("ips-open").onclick = openIpsModal;
document.getElementById("ips-close").onclick = closeIpsModal;
document.getElementById("ips-modal").addEventListener("click", (e) => { if (e.target.id === "ips-modal") closeIpsModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ipsModalOpen()) closeIpsModal(); });
async function heartbeat() {
  try { renderPresence(await api("/api/presence", { method: "POST", body: JSON.stringify({ clientId: getClientId() }) })); }
  catch (e) { /* silent — don't spam toasts on a poll */ }
}
document.getElementById("presence-btn").onclick = () => {
  const panel = document.getElementById("presence-panel");
  const open = !layerOpen(panel);
  if (open) openLayer(panel, true); else closeLayer(panel);
  document.getElementById("presence-btn").setAttribute("aria-expanded", String(open));
};

// ---- theme -----------------------------------------------------------------
function currentTheme() {
  const saved = localStorage.getItem("cc_theme");
  return saved === "light" || saved === "dark" ? saved : (mqDark.matches ? "dark" : "light");
}
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.setAttribute("content", t === "dark" ? "#111417" : "#e8edf0");
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = t === "dark" ? "◐ 浅色" : "◐ 深色";
  setCommandIcon(btn, t === "dark" ? "Sun" : "Moon", t === "dark" ? "浅色" : "深色");
  if (btn) btn.setAttribute("aria-label", t === "dark" ? "切换浅色主题" : "切换深色主题");
  panes.forEach((p) => {
    if (p.term) p.term.options.theme = termTheme(t);
  });
  window.ccAppearance?.sync(true);
}
function toggleTheme() {
  const t = currentTheme() === "dark" ? "light" : "dark";
  localStorage.setItem("cc_theme", t);
  applyTheme(t);
}
document.getElementById("theme-toggle").onclick = toggleTheme;
mqDark.addEventListener("change", () => applyTheme(currentTheme()));
window.addEventListener("storage", (event) => {
  if (event.storageArea === localStorage && (event.key === "cc_theme" || event.key === null)) applyTheme(currentTheme());
});
applyTheme(currentTheme());

function showSessions(show) {
  body.classList.toggle("sessions-open", show);
  document.getElementById("nav-global").classList.toggle("selected", show);
  document.getElementById("nav-current").classList.toggle("selected", !show);
  document.getElementById("nav-global").setAttribute("aria-pressed", String(show));
  document.getElementById("nav-current").setAttribute("aria-pressed", String(!show));
}
function toggleTools(force) {
  const open = typeof force === "boolean" ? force : !body.classList.contains("tools-open");
  body.classList.toggle("tools-open", open);
  localStorage.setItem("cc_tools_hidden", open ? "0" : "1");
  for (const id of ["btn-tools", "topbar-tools"]) {
    const button = document.getElementById(id);
    button.setAttribute("aria-expanded", String(open));
    button.title = open ? "收起功能栏" : "展开功能栏";
    button.setAttribute("aria-label", button.title);
  }
  requestAnimationFrame(refitAll);
}
document.getElementById("btn-tools").onclick = () => toggleTools();
document.getElementById("topbar-tools").onclick = () => toggleTools();
document.getElementById("header-new").onclick = openDirModal;
document.getElementById("header-split").onclick = splitPane;
document.getElementById("nav-global").onclick = () => showSessions(true);
document.getElementById("nav-current").onclick = () => { showSessions(false); if (active && active.term) active.term.focus(); closeDrawer(); };
document.getElementById("nav-files").onclick = () => { closeDrawer(); openFilesModal(); };
document.getElementById("nav-resources").onclick = () => { closeDrawer(); openGpuModal(); };
document.getElementById("nav-access").onclick = () => { closeDrawer(); openIpsModal(); };
document.getElementById("nav-storage").onclick = () => { closeDrawer(); openGpuModal(); setResTab("disk"); };
document.getElementById("btn-search").onclick = () => {
  if (localStorage.getItem("cc_sb_hidden") === "1") setSidebarHidden(false);
  showSessions(true); document.getElementById("session-search").focus();
};
document.getElementById("session-search").oninput = renderTabs;
toggleTools(localStorage.getItem("cc_tools_hidden") !== "1");

// ---- misc wiring -----------------------------------------------------------
document.getElementById("set-token").onclick = setTokenPrompt;
document.getElementById("refresh").onclick = async () => {
  const button = document.getElementById("refresh");
  setButtonBusy(button, true);
  try { await loadTabs(); }
  finally { setButtonBusy(button, false); }
};
document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadTabs(); heartbeat(); } });

// ---- boot ------------------------------------------------------------------
async function ensureCookieSession() {
  const token = getToken();
  if (!token) return;
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (r.ok) localStorage.removeItem("cc_token");
  } catch (e) {}
}
async function loadConfig() {
  try { const c = await api("/api/config"); state.defaultDir = c.defaultDir || ""; state.types = c.types || {}; applyTypeAvail(); } catch (e) {}
}
function applyTypeAvail() {
  const cx = document.getElementById("mode-codex");
  if (cx) cx.style.display = (state.types && state.types.codex === true) ? "" : "none";
  const oc = document.getElementById("mode-opencode");
  if (oc) oc.style.display = (state.types && state.types.opencode === true) ? "" : "none";
}
// ---- copy ------------------------------------------------------------------
// xterm paints the selection onto a canvas, so it is NOT a DOM selection and the
// browser's own Ctrl+C/长按复制 has nothing to grab — the text has to come from
// term.getSelection(). And navigator.clipboard only exists in a secure context,
// which a plain HTTP LAN entrance is not, so the legacy
// execCommand path is a required fallback here, not a nicety.
async function copyText(text) {
  if (!text) return false;
  try {
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to execCommand */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;";
    document.body.appendChild(ta);
    // iOS ignores select() on a plain textarea; it only copies from a
    // contenteditable range.
    if (/iP(ad|hone|od)|Macintosh/.test(navigator.userAgent) && "ontouchend" in document) {
      ta.contentEditable = "true";
      ta.readOnly = false;
      const range = document.createRange();
      range.selectNodeContents(ta);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    ta.focus();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (e) { return false; }
}
// A touch device pops the on-screen keyboard the instant something takes
// focus, so restoring a terminal on page load threw the keyboard in your face
// before you asked for anything. On touch we focus only on a real tap (the pane
// click handler already does that); on desktop the deferred focus stays, since
// that is what fixed "had to refresh before you could type".
const COARSE = !!(window.matchMedia && window.matchMedia("(any-pointer: coarse)").matches);

// On a phone the terminal fills the screen, so ANY tap landed on it — and xterm
// focuses its hidden textarea from its own mousedown handler, so the on-screen
// keyboard shot up on every touch and there was no way back out. Suppressing
// our focus call was not enough; `inputmode="none"` is the actual lever: the
// textarea still focuses (a hardware keyboard on an iPad keeps working) but iOS
// does not raise the virtual keyboard. The ⌨ button is what raises it.
let kbdOn = false;
function applyKbdMode(term) {
  if (!COARSE || !term || !term.textarea) return;
  if (kbdOn) term.textarea.removeAttribute("inputmode");
  else term.textarea.setAttribute("inputmode", "none");
}
function updateKbdBtn() {
  const b = document.getElementById("btn-kbd");
  if (b) {
    b.classList.toggle("on", kbdOn);
    b.title = kbdOn ? "收起键盘" : "打开键盘";
    b.setAttribute("aria-label", b.title);
    b.setAttribute("aria-pressed", String(kbdOn));
  }
}
function toggleKeyboard() {
  const p = active;
  if (!p || !p.term || !p.term.textarea) { showToast("还没有打开的终端"); return; }
  kbdOn = !kbdOn;
  panes.forEach((x) => x.term && applyKbdMode(x.term));
  const ta = p.term.textarea;
  // inputmode only takes effect on the next focus, so bounce it.
  try { ta.blur(); if (kbdOn) ta.focus(); } catch (e) {}
  updateKbdBtn();
  showToast(kbdOn ? "键盘已打开 · 再点一次收起" : "键盘已收起");
}

// ---- selection mode --------------------------------------------------------
// When an app turns on mouse reporting (claude, codex), xterm disables its
// selection service outright and hands every drag to the app — so you cannot
// select anything, which is why "选中了却复制不了" is really "从来没选中过".
// xterm's own escape hatch is shouldForceSelection(); we widen it to "always
// true while 选择模式 is on". That reuses xterm's designed path, which also
// stopPropagation()s the event so the app never sees the drag.
let selectMode = localStorage.getItem("cc_select_mode") === "1";
function isMouseWheelReport(data) {
  let button;
  if (data.startsWith("\x1b[M") && data.length === 6) {
    button = data.charCodeAt(3) - 32;
  } else {
    const match = /^\x1b\[(<)?(\d+);\d+;\d+[Mm]$/.exec(data);
    if (!match) return false;
    button = Number(match[2]) - (match[1] ? 0 : 32);
  }
  // Remove Shift/Alt/Ctrl bits, retaining wheel vs pointer-motion bits.
  button &= ~28;
  return button >= 64 && button <= 67;
}
function installSelectMode(term) {
  let ok = false;
  try {
    const core = term._core;
    const ss = core && core._selectionService;
    if (ss && !ss.__ccPatched) {
      const orig = ss.shouldForceSelection.bind(ss);
      ss.shouldForceSelection = (ev) => selectMode || orig(ev);
      ss.__ccPatched = true;
      ok = true;
    }
    // Forcing selection on mousedown is not enough. With ?1003h (any-motion
    // tracking — what claude uses) merely MOVING the mouse still reports to the
    // app, and xterm treats anything it sends as user input:
    //     coreService.onUserInput(() => hasSelection && clearSelection())
    // So the selection died the moment you let go and moved toward the button —
    // the highlight vanished and the copy button then honestly said "没有选中".
    // Suppress pointer reports while selecting, but keep wheel reports: TUIs
    // such as Claude own their history and need these to scroll it.
    // The reporting listeners are (re)registered on protocol change and don't
    // re-check the flag above on every event, so a few reports still slipped
    // through and killed the selection. Close it at the exit instead: drop
    // non-wheel mouse-report sequences while 选择模式 is on. Keyboard input
    // and scrolling remain available in all three mouse encodings.
    const cs = core && core.coreService;
    if (cs && !cs.__ccPatched) {
      const origTrigger = cs.triggerDataEvent.bind(cs);
      const MOUSE_SEQ = /^\x1b\[(?:M[\s\S]{3}|<?\d+;\d+;\d+[Mm])$/;
      cs.triggerDataEvent = (data, wasUserInput) => {
        if (selectMode && typeof data === "string" && MOUSE_SEQ.test(data) && !isMouseWheelReport(data)) return;
        return origTrigger(data, wasUserInput);
      };
      cs.__ccPatched = true;
      ok = true;
    }
    const cms = core && core.coreMouseService;
    if (cms && !cms.__ccPatched) {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(cms), "areMouseEventsActive");
      if (desc && desc.get) {
        Object.defineProperty(cms, "areMouseEventsActive", {
          configurable: true,
          get() { return selectMode ? false : desc.get.call(this); },
        });
        cms.__ccPatched = true;
        ok = true;
      }
    }
  } catch (e) { return false; }
  return ok;
}
function updateSelectBtn() {
  const b = document.getElementById("btn-select");
  if (!b) return;
  b.classList.toggle("on", selectMode);
  b.title = selectMode ? (COARSE ? "选择模式:开(长按后拖动选字,滑动仍可滚动)" : "选择模式:开(拖拽选中文字,滚轮仍可滚动)") : "选择模式:关(拖拽交给程序,如 claude 的点击)";
  b.setAttribute("aria-pressed", String(selectMode));
  document.querySelectorAll(".pane").forEach((el) => el.classList.toggle("selecting", selectMode));
}
function toggleSelectMode() {
  selectMode = !selectMode;
  localStorage.setItem("cc_select_mode", selectMode ? "1" : "0");
  updateSelectBtn();
  showToast(selectMode ? "选择模式已开:拖拽选字,滚轮仍可滚动" : "选择模式已关:鼠标恢复交给程序");
  if (active && active.term) { try { active.term.focus(); } catch (e) {} }
}

// Single-finger swipes always scroll. Selection requires a stationary hold so
// a saved selection preference cannot turn every phone swipe into text selection.
const TOUCH_DRAG_PX = 8;
const TOUCH_SELECT_MS = 400;
function attachTouchScroll(term, host, pane) {
  let lastY = null, acc = 0, origin = null, dragging = false;
  const reset = () => { lastY = null; acc = 0; origin = null; dragging = false; };
  const onStart = (ev) => {
    reset();
    if (ev.touches.length !== 1) return;
    const touch = ev.touches[0];
    lastY = touch.clientY;
    origin = { x: touch.clientX, y: lastY };
  };
  const onMove = (ev) => {
    if (ev.touches.length !== 1) { reset(); return; }
    if (!origin || lastY == null || (pane && pane.touchSelecting)) return;
    const touch = ev.touches[0];
    if (!dragging) {
      const dx = Math.abs(touch.clientX - origin.x), dy = Math.abs(touch.clientY - origin.y);
      if (dx >= TOUCH_DRAG_PX && dx > dy) { reset(); return; }
      if (dy < TOUCH_DRAG_PX) return;
      dragging = true;
    }
    if (ev.cancelable) ev.preventDefault();
    ev.stopPropagation();
    const y = touch.clientY;
    acc += lastY - y;                 // finger up => positive => wheel down
    lastY = y;
    const h = rowPx(term);
    // Emit whole LINES, not pixels: both consumers (our tmux copy-mode path and
    // xterm's own forwarding to mouse-reporting apps) take DOM_DELTA_LINE
    // literally, so the terminal scrolls exactly as far as the finger moved
    // whatever the font size. The sub-row remainder is carried over.
    const lines = acc > 0 ? Math.floor(acc / h) : Math.ceil(acc / h);
    if (!lines) return;
    acc -= lines * h;
    const screen = host.querySelector(".xterm-screen");
    if (!screen) return;
    const r = screen.getBoundingClientRect();
    screen.dispatchEvent(new WheelEvent("wheel", {
      deltaY: lines, deltaMode: 1, bubbles: true, cancelable: true,
      clientX: origin ? origin.x : r.left + r.width / 2, clientY: origin ? origin.y : r.top + r.height / 2,
    }));
  };
  const onEnd = (ev) => {
    if (dragging && ev.cancelable) { ev.preventDefault(); ev.stopPropagation(); }
    reset();
  };
  host.addEventListener("touchstart", onStart, { passive: true, capture: true });
  host.addEventListener("touchmove", onMove, { passive: false, capture: true });
  host.addEventListener("touchend", onEnd, { passive: false, capture: true });
  host.addEventListener("touchcancel", onEnd, { passive: true, capture: true });
  return () => {
    host.removeEventListener("touchstart", onStart, true);
    host.removeEventListener("touchmove", onMove, true);
    host.removeEventListener("touchend", onEnd, true);
    host.removeEventListener("touchcancel", onEnd, true);
  };
}

function attachTouchSelection(term, host, pane) {
  let start = null, origin = null, timer = null;
  const reset = () => {
    clearTimeout(timer); timer = null; start = null; origin = null;
    if (pane) pane.touchSelecting = false;
  };
  function cellAt(t) {
    const screen = host.querySelector(".xterm-screen");
    if (!screen || !term.cols || !term.rows) return null;
    const r = screen.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const col = Math.max(0, Math.min(term.cols - 1, Math.floor((t.clientX - r.left) / (r.width / term.cols))));
    const row = Math.max(0, Math.min(term.rows - 1, Math.floor((t.clientY - r.top) / (r.height / term.rows))));
    return { col, row: term.buffer.active.viewportY + row };
  }
  const onStart = (ev) => {
    reset();
    if (!selectMode || ev.touches.length !== 1) return;
    origin = { clientX: ev.touches[0].clientX, clientY: ev.touches[0].clientY };
    timer = setTimeout(() => {
      if (!selectMode || !origin) return;
      start = cellAt(origin);
      if (start) {
        if (pane) pane.touchSelecting = true;
        try { term.select(start.col, start.row, 1); } catch (e) {}
      }
    }, TOUCH_SELECT_MS);
  };
  const onMove = (ev) => {
    if (!selectMode || ev.touches.length !== 1) { reset(); return; }
    if (!origin) return;
    if (!start) {
      if (Math.hypot(ev.touches[0].clientX - origin.clientX, ev.touches[0].clientY - origin.clientY) >= TOUCH_DRAG_PX) reset();
      return;
    }
    const now = cellAt(ev.touches[0]);
    if (!now) return;
    ev.preventDefault();                       // a selecting drag must not scroll
    ev.stopPropagation();
    try {
      if (now.row === start.row) {
        const a = Math.min(start.col, now.col), b = Math.max(start.col, now.col);
        term.select(a, start.row, b - a + 1);
      } else {
        term.selectLines(Math.min(start.row, now.row), Math.max(start.row, now.row));
      }
    } catch (e) {}
  };
  const onEnd = (ev) => { if (start && ev.cancelable) ev.preventDefault(); reset(); };
  host.addEventListener("touchstart", onStart, { passive: true, capture: true });
  host.addEventListener("touchmove", onMove, { passive: false, capture: true });
  host.addEventListener("touchend", onEnd, { passive: false, capture: true });
  host.addEventListener("touchcancel", onEnd, { passive: true, capture: true });
  return () => {
    reset();
    host.removeEventListener("touchstart", onStart, true);
    host.removeEventListener("touchmove", onMove, true);
    host.removeEventListener("touchend", onEnd, true);
    host.removeEventListener("touchcancel", onEnd, true);
  };
}

function allText(term) {
  try {
    const buf = term.buffer.active;
    const out = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      out.push(line ? line.translateToString(true) : "");
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join("\n");
  } catch (e) { return ""; }
}
function screenText(term) {
  try {
    const buf = term.buffer.active;
    const out = [];
    for (let i = 0; i < term.rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      out.push(line ? line.translateToString(true) : "");
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join("\n");
  } catch (e) { return ""; }
}
// Where a selection can live, in priority order. Reading only the focused
// pane's term.getSelection() was too narrow: xterm uses the DOM renderer here
// (rows are real elements), so a native drag or an iOS long-press produces a
// perfectly visible browser selection that term.getSelection() cannot see —
// which is how you end up being told "没有选中" while looking at highlighted
// text. Selections in an unfocused split cell were missed for the same reason.
// Tapping the copy button collapses the browser's native selection before our
// click handler runs, so grab it on pointerdown — the last moment it still
// exists. Not a "remembered selection": it is snapshotted inside the very
// interaction that consumes it, and cleared right after.
let _domSnap = "";
function snapDomSelection() {
  _domSnap = "";
  try {
    const sel = window.getSelection();
    const text = String(sel || "");
    const box = document.getElementById("panes");
    if (text.trim() && sel.anchorNode && box && box.contains(sel.anchorNode)) _domSnap = text;
  } catch (e) {}
}
function domSelectionNow() {
  try {
    const sel = window.getSelection();
    const text = String(sel || "");
    const box = document.getElementById("panes");
    if (text.trim() && sel.anchorNode && box && box.contains(sel.anchorNode)) return text;
  } catch (e) {}
  return "";
}
function currentSelection() {
  const ordered = active ? [active].concat(panes.filter((p) => p !== active)) : panes.slice();
  for (const p of ordered) {
    if (!p || !p.term) continue;
    let s = "";
    try { s = p.term.getSelection() || ""; } catch (e) {}
    if (s.trim()) return { text: s, pane: p };
  }
  const live = domSelectionNow();
  const text = live || _domSnap;
  if (text.trim()) {
    let owner = null;
    try {
      const node = window.getSelection() && window.getSelection().anchorNode;
      if (node) owner = panes.find((p) => p.el && p.el.contains(node)) || null;
    } catch (e) {}
    return { text, pane: owner || active };
  }
  return null;
}

async function copyTerminalSelection(pane) {
  ctrlArmed = false; updateCtrlCap();
  const term = pane?.term;
  if (!term) return;
  let text = term.getSelection() || "";
  if (!text) {
    const selection = window.getSelection();
    if (selection?.anchorNode && pane.el.contains(selection.anchorNode)) text = String(selection);
  }
  if (!text) { showToast("请先选中要复制的内容"); return; }
  const focused = document.activeElement, ok = await copyText(text);
  showToast(ok ? "已复制选中内容 (" + text.length + " 字)" : "复制失败,浏览器拒绝了剪贴板访问");
  // The HTTP fallback briefly focuses a textarea. Do not steal focus back if
  // the user switched panes or opened another field during an async copy.
  if (active === pane && pane.term === term && focused === term.textarea && document.activeElement === document.body) {
    try { term.focus(); } catch (_) {}
  }
}

async function copyFromTerminal() {
  const hit = currentSelection();
  const p = (hit && hit.pane) || active;
  if (!p || !p.term) { showToast("还没有打开的终端"); return; }
  let text = hit ? hit.text : "";
  const fromSelection = !!text.trim();
  if (!fromSelection) text = screenText(p.term);
  if (!text.trim()) { showToast("没有可复制的内容"); return; }
  const ok = await copyText(text);
  _domSnap = "";
  if (!ok) { showToast("复制失败,浏览器拒绝了剪贴板访问"); return; }
  showToast(fromSelection
    ? "已复制选中内容 (" + text.length + " 字)"
    : "没有选中,已复制当前屏幕 " + text.split("\n").length + " 行");
  try { p.term.focus(); } catch (e) {}
}
async function copyAllHistory() {
  const p = active;
  if (!p || !p.term) { showToast("还没有打开的终端"); return; }
  const text = allText(p.term);
  if (!text.trim()) { showToast("没有可复制的内容"); return; }
  const ok = await copyText(text);
  showToast(ok ? "已复制全部历史 " + text.split("\n").length + " 行" : "复制失败,浏览器拒绝了剪贴板访问");
  try { p.term.focus(); } catch (e) {}
}

const _copyBtn = document.getElementById("btn-copy");
// Don't let the button steal focus — that would drop the xterm selection we are
// about to read.
_copyBtn.addEventListener("mousedown", (e) => e.preventDefault());
// Long-press (or right-click) grabs the whole scrollback instead.
let _copyHold = null, _copyHeld = false;
function copyHoldStart() {
  snapDomSelection();
  _copyHeld = false;
  _copyHold = setTimeout(() => { _copyHeld = true; copyAllHistory(); }, 550);
}
function copyHoldEnd() { if (_copyHold) { clearTimeout(_copyHold); _copyHold = null; } }
_copyBtn.addEventListener("pointerdown", copyHoldStart);
_copyBtn.addEventListener("pointerup", copyHoldEnd);
_copyBtn.addEventListener("pointercancel", copyHoldEnd);
_copyBtn.addEventListener("pointerleave", copyHoldEnd);
_copyBtn.addEventListener("contextmenu", (e) => { e.preventDefault(); copyHoldEnd(); copyAllHistory(); });
_copyBtn.addEventListener("click", () => { if (_copyHeld) { _copyHeld = false; return; } copyFromTerminal(); });

const _kbdBtn = document.getElementById("btn-kbd");
if (_kbdBtn) { _kbdBtn.addEventListener("mousedown", (e) => e.preventDefault()); _kbdBtn.addEventListener("click", toggleKeyboard); }
updateKbdBtn();

const _selBtn = document.getElementById("btn-select");
_selBtn.addEventListener("mousedown", (e) => e.preventDefault());
_selBtn.addEventListener("click", toggleSelectMode);
updateSelectBtn();

// ---- GPU monitor -----------------------------------------------------------
let gpuTimer = null;
let gpuBusy = false;
function gpuModalOpen() { return layerOpen(document.getElementById("gpu-modal")); }
function openGpuModal() {
  openLayer(document.getElementById("gpu-modal"), true);
  loadGpu(true);
  // Poll while it's on screen only — each refresh shells out to ssh.
  if (gpuTimer) clearInterval(gpuTimer);
  gpuTimer = setInterval(() => { if (gpuModalOpen() && resTab === "gpu") loadGpu(false); }, 5000);
}
function closeGpuModal() {
  closeLayer(document.getElementById("gpu-modal"));
  if (gpuTimer) { clearInterval(gpuTimer); gpuTimer = null; }
  if (diskTimer) { clearTimeout(diskTimer); diskTimer = null; }
}
async function loadGpu(force) {
  if (gpuBusy) return;
  gpuBusy = true;
  const body = document.getElementById("gpu-body");
  const reload = document.getElementById("gpu-reload");
  if (force) setButtonBusy(reload, true);
  try {
    const d = await api("/api/gpu" + (force ? "?refresh=1" : ""));
    renderGpu(d.hosts || []);
    document.getElementById("gpu-age").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  } catch (e) {
    body.innerHTML = '<div class="gpu-err">读取失败:' + esc(String(e.message || e)) + "</div>";
  } finally {
    gpuBusy = false;
    if (force) setButtonBusy(reload, false);
  }
}
// ---- storage monitor -------------------------------------------------------
// `df` is instant; `du` is not (1.8 TB at depth 1 is ~35s), so directory sizes
// come from a backend background scan and this just polls until it lands.
let resTab = "gpu";
let diskHosts = [];
let duState = {};            // addr -> { path, data, loading }
let diskTimer = null;

function fmtBytes(n) {
  if (n == null) return "—";
  const u = ["B", "K", "M", "G", "T", "P"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + u[i];
}
function setResTab(tab) {
  resTab = tab;
  document.getElementById("tab-gpu").classList.toggle("on", tab === "gpu");
  document.getElementById("tab-disk").classList.toggle("on", tab === "disk");
  document.getElementById("tab-gpu").setAttribute("aria-selected", String(tab === "gpu"));
  document.getElementById("tab-disk").setAttribute("aria-selected", String(tab === "disk"));
  document.getElementById("gpu-body").classList.toggle("hidden", tab !== "gpu");
  document.getElementById("disk-body").classList.toggle("hidden", tab !== "disk");
  document.getElementById("gpu-foot").classList.toggle("hidden", tab !== "gpu");
  document.getElementById("disk-foot").classList.toggle("hidden", tab !== "disk");
  document.getElementById("gpu-reload").textContent = tab === "gpu" ? "↻ 刷新" : "↻ 重新扫描";
  if (tab === "disk") loadDisk();
}
async function loadDisk() {
  try {
    const d = await api("/api/disk");
    diskHosts = d.hosts || [];
    renderDisk();
    diskHosts.forEach((h) => { if (h.ok && !duState[h.addr] && (h.roots || []).length) openDu(h.addr, h.roots[0].path); });
  } catch (e) {
    document.getElementById("disk-body").innerHTML = '<div class="gpu-err">读取失败:' + esc(String(e.message || e)) + "</div>";
  }
}
async function openDu(addr, path, refresh) {
  duState[addr] = Object.assign({}, duState[addr], { path, loading: true });
  renderDisk();
  try {
    const d = await api("/api/disk/usage?addr=" + encodeURIComponent(addr) +
      "&path=" + encodeURIComponent(path) + (refresh ? "&refresh=1" : ""));
    duState[addr] = { path, data: d, loading: false };
  } catch (e) {
    duState[addr] = { path, data: { error: String(e.message || e) }, loading: false };
  }
  renderDisk();
  scheduleDuPoll();
}
function scheduleDuPoll() {
  if (diskTimer) { clearTimeout(diskTimer); diskTimer = null; }
  const busy = Object.keys(duState).filter((a) => duState[a].data && duState[a].data.scanning);
  if (!busy.length || !gpuModalOpen()) return;
  diskTimer = setTimeout(() => { busy.forEach((a) => openDu(a, duState[a].path)); }, 2000);
}
function crumbs(root, path) {
  const rel = path.slice(root.length).split("/").filter(Boolean);
  const out = ['<a data-go="' + esc(root) + '">' + esc(root) + "</a>"];
  let acc = root;
  rel.forEach((seg) => { acc += "/" + seg; out.push('<a data-go="' + esc(acc) + '">' + esc(seg) + "</a>"); });
  return out.join('<span class="du-sep">/</span>');
}
function renderDisk() {
  const body = document.getElementById("disk-body");
  if (!diskHosts.length) { body.innerHTML = '<div class="gpu-loading">读取中…</div>'; return; }
  body.innerHTML = diskHosts.map((h) => {
    if (!h.ok) {
      return '<section class="gpu-host"><div class="gpu-host-head"><b>' + esc(h.name) + "</b></div>" +
        '<div class="gpu-err">' + esc(h.error || "读取失败") + "</div></section>";
    }
    const mounts = (h.mounts || []).map((m) =>
      '<div class="mnt"><div class="mnt-head"><span class="mnt-target">' + esc(m.target) + "</span>" +
      '<span class="mnt-src">' + esc(m.source) + "</span>" +
      '<span class="mnt-free' + (m.pct >= 90 ? " hot" : m.pct >= 75 ? " warm" : "") + '">剩 ' + fmtBytes(m.avail) + "</span></div>" +
      '<span class="gpu-bar"><i class="' + barClass(m.pct) + '" style="width:' + m.pct + '%"></i></span>' +
      '<div class="mnt-sub">' + fmtBytes(m.used) + " / " + fmtBytes(m.size) + " · " + m.pct + "%</div></div>").join("");

    const st = duState[h.addr] || {};
    const roots = (h.roots || []).map((r) =>
      '<button class="du-root' + (st.path && st.path.indexOf(r.path) === 0 ? " on" : "") + '" data-addr="' + esc(h.addr) + '" data-go="' + esc(r.path) + '">' +
      esc(r.path) + (r.total != null ? ' <b>' + fmtBytes(r.total) + "</b>" : "") + "</button>").join("");

    let du = "";
    if (st.path) {
      const d = st.data || {};
      const root = (h.roots || []).map((r) => r.path).filter((r) => st.path.indexOf(r) === 0)[0] || st.path;
      const head = '<div class="du-crumb" data-addr="' + esc(h.addr) + '">' + crumbs(root, st.path) + "</div>";
      let rows;
      if (d.error) rows = '<div class="gpu-err">' + esc(d.error) + "</div>";
      else if (d.scanning) rows = '<div class="du-scan">正在扫描 <b>' + esc(st.path) + "</b> …大目录可能要几十秒,扫完会自动出结果</div>";
      else if (!(d.children || []).length) rows = '<div class="pp-note">这个目录下没有子目录</div>';
      else {
        const max = d.children[0].size || 1;
        rows = d.children.map((c) =>
          '<div class="du-row" data-addr="' + esc(h.addr) + '" data-go="' + esc(c.path) + '">' +
          '<span class="du-size">' + fmtBytes(c.size) + "</span>" +
          '<span class="du-bar"><i style="width:' + Math.max(1, Math.round(c.size * 100 / max)) + '%"></i></span>' +
          '<span class="du-name">' + esc(c.name) + "</span>" +
          '<span class="du-pct">' + (d.total ? (c.size * 100 / d.total).toFixed(1) + "%" : "") + "</span></div>").join("") +
          (d.dropped ? '<div class="pp-note">还有 ' + d.dropped + " 个较小的目录未列出</div>" : "");
      }
      const meta = d.scanning ? "扫描中…"
        : d.at ? "上次扫描 " + ago(d.at) + (d.duration ? " · 耗时 " + d.duration + "s" : "") + (d.stale ? " · 可能已过时" : "")
        : "";
      du = '<div class="du-area">' + head +
        '<div class="du-meta"><span>合计 <b>' + fmtBytes(d.total) + "</b>" + (meta ? " · " + esc(meta) : "") + "</span>" +
        '<button class="btn-sm du-rescan" data-addr="' + esc(h.addr) + '" data-go="' + esc(st.path) + '">↻ 重新扫描</button></div>' +
        rows + "</div>";
    }
    return '<section class="gpu-host"><div class="gpu-host-head"><b>' + esc(h.name) + "</b>" + why_addr(h) + "</div>" +
      '<div class="mnt-grid">' + mounts + "</div>" +
      (roots ? '<div class="du-roots">' + roots + "</div>" : "") + du + "</section>";
  }).join("");

  body.querySelectorAll("[data-go]").forEach((el) => {
    el.onclick = () => {
      const addr = el.dataset.addr || (el.closest("[data-addr]") || {}).dataset.addr;
      if (!addr) return;
      openDu(addr, el.dataset.go, el.classList.contains("du-rescan"));
    };
  });
}
document.getElementById("tab-gpu").onclick = () => setResTab("gpu");
document.getElementById("tab-disk").onclick = () => setResTab("disk");

function gb(mib) { return (mib / 1024).toFixed(1); }
function barClass(pct) { return pct >= 85 ? "hot" : pct >= 50 ? "warm" : "cool"; }
const GPU_STATE = { idle: ["空闲", "idle"], busy: ["运行中", "busy"], held: ["占着显存", "held"] };
function renderGpu(hosts) {
  const body = document.getElementById("gpu-body");
  if (!hosts.length) { body.innerHTML = '<div class="gpu-err">还没有配置服务器</div>'; return; }
  body.innerHTML = hosts.map((h) => {
    const rm = h.addr !== "local"
      ? '<button class="gpu-del" data-addr="' + esc(h.addr) + '" title="移除">✕</button>' : "";
    if (!h.ok) {
      return '<section class="gpu-host"><div class="gpu-host-head"><b>' + esc(h.name) + "</b>" +
why_addr(h) + rm + '</div><div class="gpu-err">' + esc(h.error || "读取失败") + "</div></section>";
    }
    const s = h.summary || {};
    const users = (s.users || []).map((u) =>
      '<span class="gpu-user"><b>' + esc(u.user) + "</b> " + gb(u.mem) + "G · 卡 " + u.gpus.join("/") + "</span>").join("");
    const cards = h.gpus.map((g) => {
      const st = GPU_STATE[g.state] || GPU_STATE.idle;
      const util = g.util == null ? 0 : g.util;
      const procs = g.procs.length
        ? '<div class="gpu-procs">' + g.procs.map((p) =>
            '<div class="gpu-proc"><span class="gpu-pu">' + esc(p.user) + '</span>' +
            '<span class="gpu-pm">' + gb(p.mem) + "G</span>" +
            '<span class="gpu-pc" title="' + esc(p.cmd) + '">' + esc(p.cmd || "?") + "</span>" +
            '<span class="gpu-pt">' + esc(p.etime) + "</span></div>").join("") + "</div>"
        : '<div class="gpu-procs empty">无进程</div>';
      return '<div class="gpu-card ' + st[1] + '">' +
        '<div class="gpu-card-head"><span class="gpu-idx">' + g.index + "</span>" +
        '<span class="gpu-name">' + esc(g.name.replace(/^NVIDIA\s+/, "")) + "</span>" +
        '<span class="gpu-state ' + st[1] + '">' + st[0] + "</span></div>" +
        '<div class="gpu-metric"><span class="gpu-lab">利用率</span>' +
        '<span class="gpu-bar"><i class="' + barClass(util) + '" style="width:' + util + '%"></i></span>' +
        '<span class="gpu-val">' + (g.util == null ? "—" : util + "%") + "</span></div>" +
        '<div class="gpu-metric"><span class="gpu-lab">显存</span>' +
        '<span class="gpu-bar"><i class="' + barClass(g.mem_pct) + '" style="width:' + g.mem_pct + '%"></i></span>' +
        '<span class="gpu-val">' + gb(g.mem_used) + "/" + gb(g.mem_total) + "G</span></div>" +
        '<div class="gpu-sub">' + (g.temp == null ? "" : g.temp + "℃") +
        (g.power == null ? "" : " · " + Math.round(g.power) + "W" + (g.power_limit ? "/" + Math.round(g.power_limit) + "W" : "")) +
        "</div>" + procs + "</div>";
    }).join("");
    return '<section class="gpu-host"><div class="gpu-host-head"><b>' + esc(h.name) + "</b>" +
      why_addr(h) +
      '<span class="gpu-sum">' + s.total + " 卡 · 空闲 " + s.idle + " · 运行 " + s.busy + " · 占用 " + s.held +
      " · 显存 " + gb(s.mem_used) + "/" + gb(s.mem_total) + "G</span>" + rm + "</div>" +
      (users ? '<div class="gpu-users">' + users + "</div>" : "") +
      '<div class="gpu-grid">' + cards + "</div></section>";
  }).join("");
  body.querySelectorAll(".gpu-del").forEach((b) => {
    b.onclick = async () => {
      if (!(await uiConfirm("不再监控 " + b.dataset.addr + " ?"))) return;
      try { await api("/api/gpu/hosts", { method: "POST", body: JSON.stringify({ action: "del", addr: b.dataset.addr }) }); loadGpu(true); }
      catch (e) { showToast(e.message || "移除失败"); }
    };
  });
}
function why_addr(h) { return h.addr === "local" ? "" : '<span class="gpu-addr">' + esc(h.addr) + "</span>"; }

function toggleGpuModal() { gpuModalOpen() ? closeGpuModal() : openGpuModal(); }
document.getElementById("btn-gpu").onclick = toggleGpuModal;
// The titlebar is hidden below 820px, which took the ▦ button with it and made
// the whole resource panel unreachable on a phone. The topbar carries a twin.
const _gpuBtnM = document.getElementById("btn-gpu-m");
if (_gpuBtnM) _gpuBtnM.onclick = toggleGpuModal;

// iOS keyboard: the visual viewport shrinks while the layout viewport does not,
// so without this the terminal keeps its full height and the cursor ends up
// behind the keyboard. Ignore pinch-zoom (scale > 1), which also shrinks it.
(function trackVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  let t = null;
  const apply = () => {
    if (vv.scale > 1.01) return;
    document.documentElement.style.setProperty("--vvh", Math.round(vv.height) + "px");
    // iOS scrolls the layout viewport to reveal the focused field when the
    // keyboard opens; nothing here is meant to scroll, and being left scrolled
    // put the header out of reach.
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    clearTimeout(t);
    // Two passes: one during the keyboard animation, one after it settles —
    // fitting only mid-animation is how the terminal ended up mis-sized.
    t = setTimeout(() => {
      try { refitAll(); } catch (e) {}
      setTimeout(() => { try { refitAll(); } catch (e) {} }, 320);
    }, 120);
  };
  vv.addEventListener("resize", apply);
  window.addEventListener("orientationchange", () => setTimeout(apply, 300));
  apply();
})();
document.getElementById("gpu-close").onclick = closeGpuModal;
document.getElementById("gpu-reload").onclick = () => {
  if (resTab === "gpu") return loadGpu(true);
  loadDisk();
  Object.keys(duState).forEach((a) => { if (duState[a].path) openDu(a, duState[a].path, true); });
};
document.getElementById("gpu-modal").addEventListener("click", (e) => { if (e.target.id === "gpu-modal") closeGpuModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && gpuModalOpen()) closeGpuModal(); });
document.getElementById("gpu-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const addr = document.getElementById("gpu-addr").value.trim();
  if (!addr) return;
  const name = document.getElementById("gpu-name").value.trim();
  try {
    await api("/api/gpu/hosts", { method: "POST", body: JSON.stringify({ action: "add", addr, name }) });
    document.getElementById("gpu-addr").value = ""; document.getElementById("gpu-name").value = "";
    loadGpu(true);
  } catch (err) { showToast(err.message || "添加失败"); }
});

// ---- file browser + previewer ----------------------------------------------
// Reuses /api/fs for listing and /api/fs/download for bytes. Preview needs the
// INLINE form of download (a `filename=` turns it into an attachment), and
// <video> seeking — plus playback at all on iOS — needs the Range support that
// Starlette's FileResponse already provides.
const IMG_EXT = ["png","jpg","jpeg","gif","webp","bmp","svg","avif","ico"];
const VID_EXT = ["mp4","webm","mov","m4v","ogv"];
const AUD_EXT = ["mp3","wav","ogg","m4a","flac","aac","opus"];
const TXT_EXT = ["txt","md","log","json","yaml","yml","toml","ini","cfg","conf","csv","tsv","xml","html","htm","css","js","ts","jsx","tsx","py","sh","bash","zsh","c","h","cpp","hpp","java","go","rs","rb","php","sql","lua","vim","dockerfile","gitignore","env","service","patch","diff"];
function extOf(name) { const i = (name || "").lastIndexOf("."); return i < 0 ? "" : name.slice(i + 1).toLowerCase(); }
function kindOf(name) {
  const e = extOf(name);
  if (IMG_EXT.includes(e)) return "image";
  if (VID_EXT.includes(e)) return "video";
  if (AUD_EXT.includes(e)) return "audio";
  if (e === "pdf") return "pdf";
  if (TXT_EXT.includes(e) || !e) return "text";
  return "other";
}
const KIND_ICON = { image: "▧", video: "▷", audio: "♪", pdf: "P", text: "≡", other: "◇" };
function fileUrl(path, inline) {
  return "/api/fs/download?path=" + encodeURIComponent(path) +
    (inline ? "&inline=1" : "");
}
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000), now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const md = (d.getMonth() + 1) + "-" + p(d.getDate());
  return d.getFullYear() === now.getFullYear() ? md + " " + p(d.getHours()) + ":" + p(d.getMinutes())
                                               : d.getFullYear() + "-" + md;
}

let filesPath = "";
let filesEntries = [];
let filesView = localStorage.getItem("cc_files_view") || "list";
let fvList = [];      // previewable files of the current dir, in display order
let fvIndex = -1;
let filesLoadSeq = 0;

function filesModalOpen() { return layerOpen(document.getElementById("files-modal")); }
function openFilesModal() {
  openLayer(document.getElementById("files-modal"), true);
  loadFiles(filesPath || localStorage.getItem("cc_files_path") || state.defaultDir || "");
}
function closeFilesModal() {
  closePreview();
  closeLayer(document.getElementById("files-modal"));
}
async function loadFiles(path) {
  const seq = ++filesLoadSeq;
  const box = document.getElementById("files-list");
  box.setAttribute("aria-busy", "true");
  box.innerHTML = '<div class="gpu-loading">读取中…</div>';
  try {
    const d = await api("/api/fs?path=" + encodeURIComponent(path || ""));
    if (seq !== filesLoadSeq) return;
    filesPath = d.path || "";
    filesEntries = d.entries || [];
    if (filesPath) localStorage.setItem("cc_files_path", filesPath);
    document.getElementById("files-search").value = "";
    renderFiles();
  } catch (e) {
    if (seq !== filesLoadSeq) return;
    box.innerHTML = '<div class="gpu-err">' + esc(String(e.message || e)) + "</div>";
  } finally {
    if (seq === filesLoadSeq) box.removeAttribute("aria-busy");
  }
}
function filesCrumb() {
  const el = document.getElementById("files-crumb");
  if (!filesPath) { el.innerHTML = '<span>选择一个根目录</span>'; return; }
  const parts = filesPath.split("/").filter(Boolean);
  let acc = "";
  const links = ['<a data-go="/">/</a>'];
  parts.forEach((seg) => { acc += "/" + seg; links.push('<a data-go="' + esc(acc) + '">' + esc(seg) + "</a>"); });
  // The root link is already "/", so it must butt straight against the first
  // segment — joining every link with a separator produced "//tmp/...".
  el.innerHTML = links[0] + links.slice(1).join('<span class="du-sep">/</span>');
  el.querySelectorAll("[data-go]").forEach((a) => { a.onclick = () => loadFiles(a.dataset.go); });
}
function renderFiles() {
  filesCrumb();
  const q = (document.getElementById("files-search").value || "").toLowerCase();
  const rows = filesEntries.filter((e) => !q || e.name.toLowerCase().includes(q));
  const box = document.getElementById("files-list");
  box.className = "files-list " + (filesView === "grid" ? "grid" : "list");
  document.getElementById("files-view").textContent = filesView === "grid" ? "▤ 列表" : "▦ 网格";
  setCommandIcon("files-view", filesView === "grid" ? "List" : "LayoutGrid", filesView === "grid" ? "列表" : "网格");

  fvList = rows.filter((e) => e.type === "file");
  const note = document.getElementById("files-note");
  const dirs = rows.filter((e) => e.type === "dir").length;
  note.textContent = filesPath ? (dirs + " 个文件夹 · " + fvList.length + " 个文件") : "";

  if (!rows.length) { box.innerHTML = '<div class="pp-note">这里没有内容</div>'; return; }
  box.innerHTML = rows.map((e) => {
    const k = e.type === "dir" ? "dir" : kindOf(e.name);
    const kindIcon = uiIcon({ dir: "Folder", image: "Image", video: "Film", audio: "Music2", pdf: "FileText", text: "FileCode2" }[k] || "File");
    if (filesView === "grid") {
      // No server-side thumbnails, so lazy-load and let CSS crop: only what is
      // actually scrolled into view ever gets fetched.
      const thumb = k === "image"
        ? '<img loading="lazy" decoding="async" src="' + fileUrl(e.path, 1) + '" alt="">'
        : '<span class="fg-ic">' + (kindIcon || (e.type === "dir" ? "▸" : KIND_ICON[k])) + "</span>";
      return '<div class="fg-cell" data-path="' + esc(e.path) + '" data-type="' + e.type + '">' +
        '<div class="fg-thumb">' + thumb + "</div>" +
        '<div class="fg-name">' + esc(e.name) + "</div></div>";
    }
    return '<div class="fl-row" data-path="' + esc(e.path) + '" data-type="' + e.type + '">' +
      '<span class="fl-ic">' + (kindIcon || (e.type === "dir" ? "▸" : KIND_ICON[k])) + "</span>" +
      '<span class="fl-name">' + esc(e.name) + "</span>" +
      '<span class="fl-size">' + (e.type === "dir" ? "" : fmtBytes(e.size)) + "</span>" +
      '<span class="fl-time">' + fmtTime(e.mtime) + "</span></div>";
  }).join("");
  box.querySelectorAll("[data-path]").forEach((el) => {
    const open = () => {
      if (el.dataset.type === "dir") return loadFiles(el.dataset.path);
      openPreview(fvList.findIndex((f) => f.path === el.dataset.path));
    };
    el.onclick = open;
    keyboardClickable(el, open, (el.dataset.type === "dir" ? "打开目录 " : "预览文件 ") + el.dataset.path.split("/").pop());
  });
}

// ---- previewer -------------------------------------------------------------
function previewOpen() { return layerOpen(document.getElementById("fv")); }
function closePreview() {
  const body = document.getElementById("fv-body");
  closeLayer(document.getElementById("fv"), () => { body.innerHTML = ""; });
  fvIndex = -1;
}
async function openPreview(i) {
  if (i < 0 || i >= fvList.length) return;
  fvIndex = i;
  const f = fvList[i];
  const k = kindOf(f.name);
  openLayer(document.getElementById("fv"), true);
  document.getElementById("fv-name").textContent = f.name;
  document.getElementById("fv-meta").textContent = fmtBytes(f.size) + " · " + fmtTime(f.mtime) +
    "  (" + (i + 1) + "/" + fvList.length + ")";
  document.getElementById("fv-dl").href = fileUrl(f.path, 0);
  const body = document.getElementById("fv-body");
  const url = fileUrl(f.path, 1);
  if (k === "image") {
    body.innerHTML = '<img class="fv-img" src="' + url + '" alt="">';
  } else if (k === "video") {
    body.innerHTML = '<video class="fv-vid" src="' + url + '" controls playsinline preload="metadata"></video>';
  } else if (k === "audio") {
    body.innerHTML = '<div class="fv-audio"><div class="fg-ic">♪</div><audio src="' + url + '" controls preload="metadata"></audio></div>';
  } else if (k === "pdf") {
    body.innerHTML = '<iframe class="fv-pdf" src="' + url + '"></iframe>';
  } else {
    body.innerHTML = '<div class="gpu-loading">读取中…</div>';
    try {
      const d = await api("/api/fs/text?path=" + encodeURIComponent(f.path));
      if (fvIndex !== i) return;              // user already moved on
      body.innerHTML = '<pre class="fv-text">' + esc(d.text) + "</pre>" +
        (d.truncated ? '<div class="pp-note">文件较大,只显示了前 512 KB</div>' : "");
    } catch (e) {
      if (fvIndex !== i) return;
      body.innerHTML = '<div class="fv-none"><div class="fg-ic">' + KIND_ICON[k] + "</div>" +
        '<div class="pp-note">' + esc(String(e.message || e)) + "</div>" +
        '<a class="btn-sm" href="' + fileUrl(f.path, 0) + '" download>⬇ 下载这个文件</a></div>';
    }
  }
}
function previewNav(step) {
  const n = fvIndex + step;
  if (n < 0 || n >= fvList.length) { showToast(step > 0 ? "已经是最后一个" : "已经是第一个"); return; }
  openPreview(n);
}

document.getElementById("btn-files").onclick = () => (filesModalOpen() ? closeFilesModal() : openFilesModal());
const _filesBtnM = document.getElementById("btn-files-m");
if (_filesBtnM) _filesBtnM.onclick = () => (filesModalOpen() ? closeFilesModal() : openFilesModal());
document.getElementById("files-close").onclick = closeFilesModal;
document.getElementById("files-reload").onclick = () => loadFiles(filesPath);
document.getElementById("files-up").onclick = () => {
  if (!filesPath || filesPath === "/") return;
  loadFiles(filesPath.replace(/\/[^/]+\/?$/, "") || "/");
};
document.getElementById("files-home").onclick = () => loadFiles(state.defaultDir || "");
document.getElementById("files-view").onclick = () => {
  filesView = filesView === "grid" ? "list" : "grid";
  localStorage.setItem("cc_files_view", filesView);
  renderFiles();
};
document.getElementById("files-search").addEventListener("input", renderFiles);
document.getElementById("fv-close").onclick = closePreview;
document.getElementById("fv-prev").onclick = () => previewNav(-1);
document.getElementById("fv-next").onclick = () => previewNav(1);
document.getElementById("files-modal").addEventListener("click", (e) => {
  if (e.target.id === "files-modal") closeFilesModal();
});
document.addEventListener("keydown", (e) => {
  if (!filesModalOpen()) return;
  if (e.key === "Escape") { previewOpen() ? closePreview() : closeFilesModal(); return; }
  if (!previewOpen()) return;
  if (e.key === "ArrowLeft") previewNav(-1);
  if (e.key === "ArrowRight") previewNav(1);
});

async function boot() {
  document.getElementById("size-val").textContent = getFont();
  await ensureCookieSession();
  loadConfig();
  loadTabs();
  heartbeat();
}
buildAux();
loadTerminalFonts();
boot();
setInterval(heartbeat, 10000);
document.addEventListener("visibilitychange", () => {
  renderAllCodexUsage();
  scheduleCodexUsageRefresh();
  if (document.visibilityState === "visible") refreshCodexUsage(false);
});
