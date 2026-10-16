"use strict";

(() => {
  if (document.documentElement.dataset.ui !== "bridge") return;
  TERM_THEME.dark = { ...TERM_THEME.dark, foreground: "#EFEEEC", cursor: "#E8A33D", cursorAccent: "#151517" };
  TERM_THEME.light = { ...TERM_THEME.light, foreground: "#242426", cursor: "#986313", cursorAccent: "#FAFAFA" };
  applyTheme(currentTheme());
  const $ = id => document.getElementById(id);
  const phases = { online: "在线", offline: "已停止", idle: "就绪", working: "处理中", needs_attention: "需要处理", complete: "已完成", error: "出错" };
  const displayName = tab => tab.name || tab.title || tabName(tab);
  const statusOf = tab => tab.activity || { phase: tab.alive ? "online" : "offline", source: "tmux" };
  let workspaces = [], current = null, view = null, switching = false, selecting = false, initialized = false, applyingLayout = false;
  let refreshing = false, dirty = false, saving = null, saveTimer = null, conflict = false;
  let panel = "fleet", globalFleet = false, fleet = [], events = [], deckSequence = 0;
  let editor = null, filePath = "", gitRoot = "", gitStaged = false, lastRefresh = 0;
  let identity = localStorage.getItem("cc_workspace_device");
  if (!identity || !/^[a-zA-Z0-9_-]{1,48}$/.test(identity)) {
    identity = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    localStorage.setItem("cc_workspace_device", identity);
  }
  const deviceKey = () => (mqMobile.matches ? "mobile_" : "desktop_") + identity;
  let device = deviceKey();
  const button = (icon, title, action, cls = "ws-icon") => {
    const el = document.createElement("button");
    el.className = cls; el.type = "button"; el.title = title; el.setAttribute("aria-label", title);
    el.innerHTML = uiIcon(icon); el.onclick = action;
    return el;
  };
  const notify = error => showToast(error.message || String(error));
  const treeGroups = new Map();
  let treeState = readTreeState(), treeSaveTimer = null, restoreTreeScroll = true, navigationPending = false;
  function readTreeState(targetDevice = deviceKey()) {
    try {
      const value = JSON.parse(localStorage.getItem("cc_workspace_tree_" + targetDevice) || "null");
      return { expanded: { ...value?.expanded }, stopped: { ...value?.stopped }, scroll: Math.max(0, Number(value?.scroll) || 0) };
    } catch (_) { return { expanded: {}, stopped: {}, scroll: 0 }; }
  }
  function saveTreeState() {
    clearTimeout(treeSaveTimer);
    try { localStorage.setItem("cc_workspace_tree_" + device, JSON.stringify(treeState)); } catch (_) {}
  }
  const sidebar = document.createElement("section");
  sidebar.className = "ws-sidebar";
  sidebar.innerHTML = '<div class="ws-section-head"><span>工作区</span><div id="ws-space-tools"></div></div><label class="ws-tree-search">' + uiIcon("Search") + '<input id="ws-session-search" type="search" placeholder="搜索会话" aria-label="搜索工作区或会话" autocomplete="off"></label><nav id="ws-workspace-list" class="ws-workspace-list" aria-label="工作区与终端"></nav><div id="ws-save-indicator" class="ws-save-indicator" role="status"></div><div id="ws-sidebar-actions" class="ws-sidebar-actions"></div>';
  $("sidebar").insertBefore(sidebar, $("sidebar").querySelector(".workspace-nav"));
  $("ws-space-tools").append(button("Plus", "新建工作区", createWorkspace));
  $("ws-sidebar-actions").append(button("Terminal", "新终端", openDirModal), button("Search", "命令与会话", openPalette), button("Settings2", "设置", () => openPanel("settings")));
  $("ws-session-search").oninput = renderNavigation;
  $("ws-session-search").onkeydown = event => {
    if (event.key === "Escape") { event.stopPropagation(); event.target.value = ""; renderNavigation(); }
  };
  $("ws-workspace-list").addEventListener("scroll", () => {
    if (restoreTreeScroll || $("ws-session-search").value) return;
    treeState.scroll = $("ws-workspace-list").scrollTop;
    clearTimeout(treeSaveTimer); treeSaveTimer = setTimeout(saveTreeState, 150);
  });
  $("ws-workspace-list").addEventListener("keydown", treeKeydown);
  const sidebarResize = document.createElement("div");
  sidebarResize.className = "ws-sidebar-resize"; sidebarResize.tabIndex = 0;
  sidebarResize.setAttribute("role", "separator"); sidebarResize.setAttribute("aria-orientation", "vertical");
  sidebarResize.setAttribute("aria-label", "侧栏宽度"); sidebarResize.title = "调整侧栏宽度";
  $("sidebar").append(sidebarResize);
  let sidebarWidth = Number(localStorage.getItem("cc_workspace_sidebar_width")) || null;
  const maxSidebarWidth = () => Math.max(200, Math.min(420, innerWidth - (document.body.classList.contains("deck-closed") ? 0 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--deck-w"))) - 320));
  function resizeSidebar(value, save = false) {
    const width = Math.round(Math.max(200, Math.min(maxSidebarWidth(), value)));
    document.documentElement.style.setProperty("--sb-w", width + "px");
    sidebarResize.setAttribute("aria-valuemin", "200"); sidebarResize.setAttribute("aria-valuemax", String(maxSidebarWidth()));
    sidebarResize.setAttribute("aria-valuenow", String(width));
    if (save) { sidebarWidth = width; localStorage.setItem("cc_workspace_sidebar_width", String(width)); }
    scheduleWorkspaceFit(true);
  }
  sidebarResize.onpointerdown = event => {
    if (event.button !== 0 || mqMobile.matches) return;
    event.preventDefault(); sidebarResize.setPointerCapture(event.pointerId);
    const start = event.clientX, width = $("sidebar").getBoundingClientRect().width;
    document.body.classList.add("ws-sidebar-dragging");
    sidebarResize.onpointermove = move => resizeSidebar(width + move.clientX - start);
    sidebarResize.onpointerup = sidebarResize.onpointercancel = () => {
      sidebarResize.onpointermove = sidebarResize.onpointerup = sidebarResize.onpointercancel = null;
      document.body.classList.remove("ws-sidebar-dragging");
      resizeSidebar($("sidebar").getBoundingClientRect().width, true);
    };
  };
  sidebarResize.onkeydown = event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    resizeSidebar(event.key === "Home" ? 200 : event.key === "End" ? maxSidebarWidth() : $("sidebar").getBoundingClientRect().width + (event.key === "ArrowRight" ? 16 : -16), true);
  };
  sidebarResize.ondblclick = () => resizeSidebar(240, true);
  window.addEventListener("resize", () => { if (sidebarWidth && !mqMobile.matches) resizeSidebar(sidebarWidth); });
  if (sidebarWidth && !mqMobile.matches) resizeSidebar(sidebarWidth);
  else { sidebarResize.setAttribute("aria-valuemin", "200"); sidebarResize.setAttribute("aria-valuemax", String(maxSidebarWidth())); sidebarResize.setAttribute("aria-valuenow", "240"); }
  const summary = document.createElement("div");
  summary.className = "ws-summary";
  summary.innerHTML = '<button id="ws-working" hidden></button><button id="ws-attention" class="attention" hidden></button>';
  $("workspace-header").insertBefore(summary, $("workspace-header").querySelector(".workspace-actions"));
  const paletteButton = button("Command", "命令与会话", openPalette, "tb-btn");
  paletteButton.id = "ws-command";
  $("workspace-header").querySelector(".workspace-actions").prepend(paletteButton);
  const deckButton = button("PanelRight", "任务面板", () => toggleDeck(), "tb-btn");
  deckButton.id = "ws-deck-toggle"; deckButton.setAttribute("aria-controls", "ws-deck");
  $("workspace-header").querySelector(".workspace-actions").append(deckButton);
  const mobileDeck = button("PanelRight", "任务与工作区", () => openPanel("fleet"), "icon-btn ws-mobile-deck");
  mobileDeck.id = "ws-mobile-deck";
  $("topbar").insertBefore(mobileDeck, $("topbar-tools"));
  const searchButton = button("TextSearch", "搜索终端历史", openHistory, "hdr-btn");
  searchButton.id = "ws-history";
  $("term-header").insertBefore(searchButton, $("btn-copy"));
  const deck = document.createElement("aside");
  deck.id = "ws-deck"; deck.className = "ws-deck"; deck.setAttribute("aria-label", "任务面板");
  deck.innerHTML = '<div class="ws-deck-head"><span class="ws-deck-title" id="ws-deck-title">任务</span><span id="ws-deck-updated" class="ws-count"></span><div id="ws-deck-actions"></div></div><div id="ws-deck-tabs" class="ws-deck-tabs" role="tablist" aria-label="工作区面板"></div><div id="ws-deck-content" class="ws-deck-content" role="tabpanel"></div>';
  $("body").append(deck);
  $("ws-deck-actions").append(button("X", "收起任务面板", () => toggleDeck(false)));
  for (const [id, icon, label] of [["fleet", "Bot", "任务"], ["files", "FolderTree", "文件"], ["git", "GitBranch", "Git"], ["activity", "Bell", "活动"], ["settings", "Settings2", "设置"]]) {
    const el = button(icon, label, () => openPanel(id));
    el.dataset.panel = id; el.setAttribute("role", "tab"); el.setAttribute("aria-selected", String(panel === id));
    $("ws-deck-tabs").append(el);
  }
  const palette = document.createElement("div");
  palette.id = "ws-palette-modal"; palette.className = "modal hidden"; palette.setAttribute("role", "dialog"); palette.setAttribute("aria-modal", "true"); palette.setAttribute("aria-label", "命令与会话");
  palette.innerHTML = '<div class="modal-box ws-palette"><input id="ws-palette-input" type="search" autocomplete="off" placeholder="搜索命令、工作区或会话" aria-label="搜索命令、工作区或会话"><div id="ws-palette-list" class="ws-palette-list" role="listbox"></div></div>';
  document.body.append(palette);
  const historyModal = document.createElement("div");
  historyModal.id = "ws-history-modal"; historyModal.className = "modal hidden"; historyModal.setAttribute("role", "dialog"); historyModal.setAttribute("aria-modal", "true"); historyModal.setAttribute("aria-labelledby", "ws-history-title");
  historyModal.innerHTML = '<div class="modal-box ws-search-box"><div class="modal-head"><h3 id="ws-history-title">终端历史</h3><div id="ws-history-close"></div></div><form id="ws-history-form" class="ws-search-controls"><input id="ws-history-input" type="search" maxlength="160" autocomplete="off" aria-label="历史搜索"><button class="ws-icon" type="submit" title="搜索" aria-label="搜索">' + uiIcon("Search") + '</button></form><div id="ws-history-results" class="ws-search-results"></div><div id="ws-history-state" class="ws-save-state" role="status"></div></div>';
  document.body.append(historyModal);
  $("ws-history-close").append(button("X", "关闭历史搜索", () => closeLayer(historyModal)));
  const splitModal = document.createElement("div");
  splitModal.id = "ws-split-modal"; splitModal.className = "modal hidden";
  splitModal.setAttribute("role", "dialog"); splitModal.setAttribute("aria-modal", "true"); splitModal.setAttribute("aria-labelledby", "ws-split-title");
  splitModal.innerHTML = '<div class="modal-box ws-split-box"><div class="modal-head"><h3 id="ws-split-title">选择分屏终端</h3><div id="ws-split-close"></div></div><div class="ws-split-controls"><input id="ws-split-search" type="search" placeholder="搜索终端或目录" aria-label="搜索分屏终端"><div id="ws-split-directions" class="ws-segments" role="group" aria-label="分屏方向"></div></div><div id="ws-split-list" class="ws-split-list"></div><div class="modal-foot"><span id="ws-split-state" role="status"></span><div id="ws-split-backup"></div><button id="ws-split-apply" class="btn-sm primary">' + uiIcon("PanelsTopLeft") + '<span>分屏显示</span></button></div></div>';
  document.body.append(splitModal);
  $("ws-split-close").append(button("X", "取消分屏选择", () => closeLayer(splitModal)));
  const replaceModal = document.createElement("div");
  replaceModal.id = "ws-replace-modal"; replaceModal.className = "modal hidden";
  replaceModal.setAttribute("role", "dialog"); replaceModal.setAttribute("aria-modal", "true"); replaceModal.setAttribute("aria-labelledby", "ws-replace-title");
  replaceModal.innerHTML = '<div class="modal-box ws-replace-box"><div class="modal-head"><h3 id="ws-replace-title">选择要替换的窗格</h3><div id="ws-replace-close"></div></div><div id="ws-replace-list"></div></div>';
  document.body.append(replaceModal);
  $("ws-replace-close").append(button("X", "取消替换", () => closeLayer(replaceModal)));
  replaceModal.addEventListener("click", event => { if (event.target === replaceModal && !splitPending) closeLayer(replaceModal); });
  let splitSelection = [], splitDirection = "auto", splitPending = false;
  for (const [value, label] of [["auto", "自动"], ["row", "左右"], ["col", "上下"]]) {
    const el = document.createElement("button"); el.type = "button"; el.textContent = label; el.dataset.direction = value;
    el.onclick = () => { splitDirection = value; renderSplitPicker(); };
    $("ws-split-directions").append(el);
  }
  $("ws-split-search").oninput = renderSplitPicker;
  $("ws-split-apply").onclick = async () => {
    const el = $("ws-split-apply");
    if (el.disabled || applyingLayout || switching || splitPending || device !== deviceKey()) return;
    const selected = [...splitSelection], limit = mqMobile.matches ? 1 : MAX_PANES;
    if (!selected.length || selected.length > limit) return;
    const targetDevice = device;
    splitPending = true;
    renderNavigation();
    splitModal.querySelectorAll("input,button").forEach(control => { control.disabled = true; });
    setButtonBusy(el, true);
    try {
      if (!(await persist())) return;
      if (targetDevice !== deviceKey()) return;
      if (selected.some(id => !state.tabs.some(tab => tab.id === id && tab.alive))) throw new Error("所选终端状态已变化，请重新选择");
      applyingLayout = true;
      reconcilePanes({ ...snapshot(), panes: selected, active: selected.includes(active?.tab?.id) ? active.tab.id : selected[0], direction: splitDirection });
      applyingLayout = false;
      layoutChanged();
      if (await persist()) closeLayer(splitModal);
    } catch (error) { notify(error); }
    finally {
      applyingLayout = false; splitPending = false; setButtonBusy(el, false);
      splitModal.querySelectorAll("button,input").forEach(control => { control.disabled = false; });
      renderSplitPicker();
      renderNavigation();
      if (device !== deviceKey()) await restoreDeviceLayout();
    }
  };
  splitModal.addEventListener("click", event => { if (event.target === splitModal && !applyingLayout && !splitPending) closeLayer(splitModal); });
  for (const id of ["header-split", "btn-split"]) {
    $(id).onclick = openSplitPicker;
    $(id).title = "选择分屏终端"; $(id).setAttribute("aria-label", "选择分屏终端");
  }
  let historyTarget = null, historySequence = 0;
  $("ws-history-form").onsubmit = async event => {
    event.preventDefault();
    const q = $("ws-history-input").value.trim(), target = historyTarget, seq = ++historySequence;
    if (!q || !target) return;
    $("ws-history-state").textContent = "搜索中";
    try {
      const result = await api("/api/sessions/" + encodeURIComponent(target) + "/history?q=" + encodeURIComponent(q), {}, 0);
      if (seq !== historySequence || target !== historyTarget) return;
      $("ws-history-results").innerHTML = (result.matches || []).map(hit => '<div class="ws-search-hit"><small>' + hit.line + '</small><pre>' + esc(hit.text) + '</pre></div>').join("");
      $("ws-history-state").textContent = result.total + " 处匹配 · " + result.lines + " 行" + (result.truncated ? " · 结果已截断" : "");
    } catch (error) { if (seq === historySequence) $("ws-history-state").textContent = error.message; }
  };

  function toggleDeck(force) {
    const open = typeof force === "boolean" ? force : document.body.classList.contains("deck-closed");
    document.body.classList.toggle("deck-closed", !open);
    deckButton.setAttribute("aria-expanded", String(open));
    mobileDeck.setAttribute("aria-expanded", String(open));
    if (!mqMobile.matches) localStorage.setItem("cc_workspace_deck", open ? "1" : "0");
    if (sidebarWidth && !mqMobile.matches) resizeSidebar(sidebarWidth);
    requestAnimationFrame(refitAll);
  }

  async function createWorkspace() {
    const name = await uiPrompt("新建工作区", "", "▣");
    if (!name?.trim()) return;
    try {
      const workspace = await api("/api/workspaces", { method: "POST", body: JSON.stringify({ name, cwd: active?.tab?.cwd || current?.cwd || state.defaultDir, members: [] }) });
      workspaces.push(workspace); renderNavigation(); await selectWorkspace(workspace.id);
    } catch (error) { notify(error); }
  }

  async function changeWorkspace(fields) {
    if (!current) return;
    const result = await api("/api/workspaces/" + current.id, { method: "PATCH", body: JSON.stringify({ ...fields, revision: current.revision }) });
    workspaces = workspaces.map(workspace => workspace.id === result.id ? result : workspace);
    current = result; renderNavigation();
  }

  function indicator(text, failed = false) {
    $("ws-save-indicator").textContent = text;
    $("ws-save-indicator").classList.toggle("error", failed);
  }

  function snapshot() {
    return { panes: panes.map(p => p.tab?.id || null), active: active?.tab?.id || null,
      direction: paneDirMode(), ratios: { cols: [...(gridFr.cols || [])], rows: [...(gridFr.rows || [])] } };
  }

  function backupSplits(value, targetDevice) {
    if (value.panes.filter(Boolean).length > 1) {
      try { localStorage.setItem("cc_split_backup_" + targetDevice, JSON.stringify({ device: targetDevice, layout: value })); } catch (_) {}
    }
  }

  function readSplitBackup() {
    try {
      const data = JSON.parse(localStorage.getItem("cc_split_backup_" + device) || localStorage.getItem("cc_workspace_recovery") || "null");
      if (data?.device !== device || !Array.isArray(data.layout?.panes)) return null;
      const ids = [...new Set(data.layout.panes)].filter(id => state.tabs.some(tab => tab.id === id && tab.alive));
      return ids.length > 1 ? { ...data.layout, panes: ids.slice(0, MAX_PANES) } : null;
    } catch (_) { return null; }
  }

  function openSplitPicker() {
    if (!initialized || navigationPending || switching || applyingLayout || splitPending || device !== deviceKey()) return;
    splitSelection = panes.map(p => p.tab?.id).filter(id => state.tabs.some(tab => tab.id === id && tab.alive)).slice(0, mqMobile.matches ? 1 : MAX_PANES);
    splitDirection = paneDirMode(); $("ws-split-search").value = "";
    $("ws-split-backup").replaceChildren();
    const backup = readSplitBackup();
    if (backup && !mqMobile.matches) $("ws-split-backup").append(button("History", "选择上次多窗分屏", () => { splitSelection = backup.panes; splitDirection = backup.direction || "auto"; renderSplitPicker(); }));
    renderSplitPicker(); openLayer(splitModal, true);
  }

  function renderSplitPicker() {
    const query = $("ws-split-search").value.trim().toLowerCase(), limit = mqMobile.matches ? 1 : MAX_PANES;
    splitSelection = splitSelection.filter(id => state.tabs.some(tab => tab.id === id && tab.alive)).slice(0, limit);
    $("ws-split-list").replaceChildren();
    const tabs = state.tabs.filter(tab => (displayName(tab) + " " + tab.cwd).toLowerCase().includes(query));
    for (const tab of tabs.sort((a, b) => Number(b.alive) - Number(a.alive) || Number(splitSelection.includes(b.id)) - Number(splitSelection.includes(a.id)))) {
      const row = document.createElement("label"); row.className = "ws-split-row";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.dataset.session = tab.id;
      checkbox.checked = splitSelection.includes(tab.id); checkbox.disabled = !tab.alive;
      checkbox.setAttribute("aria-label", displayName(tab));
      checkbox.onchange = () => {
        if (checkbox.checked && splitSelection.length >= limit) { checkbox.checked = false; $("ws-split-state").textContent = "最多 " + limit + " 个终端"; return; }
        splitSelection = checkbox.checked ? [...splitSelection, tab.id] : splitSelection.filter(id => id !== tab.id);
        updateSplitCounter();
      };
      row.append(checkbox);
      const description = document.createElement("span"); description.className = "ws-split-name";
      description.innerHTML = '<b>' + esc(displayName(tab)) + '</b><small>' + esc(typeLabel(tab.type)) + ' · ' + esc(tab.cwd || "") + '</small>';
      row.append(description);
      const status = document.createElement("small"); status.textContent = tab.alive ? "在线" : "已停止"; row.append(status);
      $("ws-split-list").append(row);
    }
    for (const el of $("ws-split-directions").children) el.setAttribute("aria-pressed", String(el.dataset.direction === splitDirection));
    updateSplitCounter();
  }

  function updateSplitCounter() {
    $("ws-split-state").textContent = splitSelection.length + " / " + (mqMobile.matches ? 1 : MAX_PANES);
    $("ws-split-apply").disabled = !splitSelection.length;
  }

  async function openTreeSession(id) {
    if (navigationPending || splitPending || switching || applyingLayout) return;
    const tab = state.tabs.find(item => item.id === id);
    if (!tab) return;
    navigationPending = true; renderNavigation();
    try { await openTab(tab); }
    catch (error) { notify(error); }
    finally { navigationPending = false; renderNavigation(); }
  }

  async function addSessionSplit(id, replacePane = null) {
    if (!initialized || navigationPending || splitPending || switching || applyingLayout || device !== deviceKey()) return;
    const tab = state.tabs.find(item => item.id === id);
    if (!tab?.alive) { showToast("终端已停止，请先启动"); return; }
    const existing = paneOfTab(id);
    if (existing) { focusPane(existing, !COARSE); return; }
    if (mqMobile.matches) { await openTreeSession(id); return; }
    if (!replacePane && panes.length >= MAX_PANES && !panes.some(p => !p.tab)) {
      $("ws-replace-title").textContent = "将「" + displayName(tab) + "」放入哪个窗格？";
      $("ws-replace-list").replaceChildren();
      for (const [index, pane] of panes.entries()) {
        const el = button("Columns2", "替换窗格 " + (index + 1), () => addSessionSplit(id, pane), "ws-row");
        el.dataset.replaceSession = pane.tab?.id || "";
        const label = document.createElement("span"); label.textContent = "窗格 " + (index + 1) + " · " + (pane.tab ? displayName(pane.tab) : "空白分屏");
        el.append(label); $("ws-replace-list").append(el);
      }
      openLayer(replaceModal, true);
      $("ws-replace-list").querySelector("button")?.focus();
      return;
    }
    const targetDevice = device;
    splitPending = true; renderNavigation();
    replaceModal.querySelectorAll("button").forEach(el => { el.disabled = true; });
    try {
      if (!(await persist()) || targetDevice !== deviceKey()) return;
      if (!state.tabs.some(item => item.id === id && item.alive)) throw new Error("终端状态已变化，请重新选择");
      if (replacePane && !panes.includes(replacePane)) throw new Error("窗格已变化，请重新选择");
      const next = snapshot(), index = replacePane ? panes.indexOf(replacePane) : next.panes.indexOf(null);
      if (index >= 0) next.panes[index] = id;
      else if (next.panes.length < MAX_PANES) next.panes.push(id);
      else throw new Error("分屏已满，请重新选择");
      applyingLayout = true;
      reconcilePanes({ ...next, active: id });
      applyingLayout = false;
      layoutChanged();
      if (await persist()) closeLayer(replaceModal);
    } catch (error) { notify(error); }
    finally {
      applyingLayout = false; splitPending = false; renderNavigation();
      replaceModal.querySelectorAll("button").forEach(el => { el.disabled = false; });
      if (device !== deviceKey()) await restoreDeviceLayout();
    }
  }

  function reconcilePanes(value) {
    const ids = value.panes.filter(id => id === null || state.tabs.some(tab => tab.id === id && tab.alive)).slice(0, mqMobile.matches ? 1 : MAX_PANES);
    const existing = [...panes], used = new Set(), wanted = ids.map(id => {
      const pane = existing.find(p => !used.has(p) && (id ? p.tab?.id === id && p.term : !p.tab));
      if (pane) used.add(pane);
      return { id, pane };
    });
    maximizedPane = null;
    for (const pane of existing) if (!used.has(pane)) teardownPane(pane);
    panes = existing.filter(p => used.has(p));
    active = null; ctrlArmed = false; updateCtrlCap();
    localStorage.setItem("cc_pane_dir", value.direction || "auto");
    gridFr = { cols: [0, 1].map(i => value.ratios?.cols?.[i] || 1), rows: [0, 1, 2, 3].map(i => value.ratios?.rows?.[i] || 1) };
    localStorage.setItem("cc_pane_fr", JSON.stringify(gridFr));
    const ordered = wanted.map(({ id, pane }) => {
      if (pane) return pane;
      const next = makePane();
      if (id) attachTerminal(state.tabs.find(tab => tab.id === id), next);
      return next;
    });
    panes = ordered; panes.forEach(p => $("panes").append(p.el));
    $("term-view").classList.toggle("hidden", !panes.length); $("empty").classList.toggle("hidden", !!panes.length);
    active = null;
    if (panes.length) focusPane(paneOfTab(value.active) || panes.find(p => p.tab) || panes[0], false);
    else { state.activeId = null; setTitlebar(); updateQuickCommandState(); updateRestartControls(); }
    layoutPanes(); savePaneLayout();
  }

  async function restoreDeviceLayout() {
    if (switching || applyingLayout || splitPending) return;
    switching = true;
    let migrated = false;
    try {
      const targetDevice = deviceKey();
      const saved = await api("/api/layouts/" + targetDevice);
      if (!Array.isArray(saved.panes)) throw new Error("分屏布局不可用");
      const initial = snapshot();
      backupSplits(initial, device);
      let value = saved;
      if (saved.revision === 0) {
        value = { ...initial, revision: 0 };
        if (mqMobile.matches) {
          const id = initial.panes.includes(initial.active) ? initial.active : initial.panes.find(Boolean);
          value = { ...value, panes: id ? [id] : [], active: id || null };
        }
        migrated = true;
      }
      if (device !== targetDevice) {
        saveTreeState(); device = targetDevice; treeState = readTreeState(targetDevice); restoreTreeScroll = true;
      }
      view = saved; device = targetDevice; dirty = false; conflict = false;
      reconcilePanes(value);
      initialized = true; indicator("已保存"); renderNavigation();
    } catch (error) { notify(error); }
    finally { switching = false; renderNavigation(); }
    if (migrated) layoutChanged();
  }

  async function persist() {
    clearTimeout(saveTimer);
    if (saving) { await saving; return dirty && !conflict ? persist() : !conflict; }
    if (!dirty || !view || switching || conflict) return !conflict;
    const targetDevice = device, value = snapshot();
    dirty = false;
    indicator("保存中");
    saving = (async () => {
      try {
        const result = await api("/api/layouts/" + targetDevice, { method: "PUT", body: JSON.stringify({ ...value, revision: view.revision }) });
        if (device === targetDevice) view = result;
        backupSplits(value, targetDevice);
        indicator("已保存");
        return true;
      } catch (error) {
        conflict = true;
        localStorage.setItem("cc_workspace_recovery", JSON.stringify({ device: targetDevice, layout: value, time: Date.now() }));
        indicator("布局未保存", true); notify(error);
        return false;
      }
    })();
    const ok = await saving;
    saving = null;
    if (dirty && ok) return persist();
    return ok;
  }

  function layoutChanged() {
    if (!initialized || switching || applyingLayout || !view) return;
    dirty = true;
    clearTimeout(saveTimer); saveTimer = setTimeout(persist, 400);
    renderNavigation();
  }

  async function selectWorkspace(wid, force = false) {
    const next = workspaces.find(workspace => workspace.id === wid);
    if (!next || selecting) return false;
    if (!force && current?.id === wid) return true;
    selecting = true;
    try {
      if (!(await leaveEditor())) return false;
      current = next;
      localStorage.setItem("cc_workspace_active", wid);
      if (!Object.prototype.hasOwnProperty.call(treeState.expanded, wid)) treeState.expanded[wid] = true;
      renderNavigation(); saveTreeState();
      filePath = next.cwd; editor = null;
      await renderPanel();
      return true;
    } catch (error) { notify(error); }
    finally { selecting = false; }
  }

  async function beforeOpen(tab) {
    return !switching && !applyingLayout && !splitPending;
  }

  // Keep keyed rows mounted so status polling cannot reset focus or list scroll.
  function orderChildren(parent, children) {
    for (const [index, child] of children.entries()) if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] || null);
    while (parent.children.length > children.length) parent.lastElementChild.remove();
  }

  function makeTreeGroup(id) {
    const root = document.createElement("section"); root.className = "ws-tree-group"; root.dataset.group = id;
    const header = button("ChevronRight", "", async () => {
      const expand = !treeState.expanded[id];
      if (!workspaces.some(space => space.id === id) || await selectWorkspace(id)) {
        treeState.expanded[id] = expand; saveTreeState(); renderNavigation();
      }
    }, "ws-workspace");
    header.dataset.workspace = id; header.id = "ws-tree-heading-" + id;
    const body = document.createElement("div"); body.className = "ws-tree-children"; body.id = "ws-tree-children-" + id;
    header.setAttribute("aria-controls", body.id); body.setAttribute("aria-labelledby", header.id);
    const live = document.createElement("div"), stopped = document.createElement("div");
    const stoppedToggle = button("ChevronRight", "", () => {
      treeState.stopped[id] = !treeState.stopped[id]; saveTreeState(); renderNavigation();
    }, "ws-stopped-toggle");
    stoppedToggle.setAttribute("aria-controls", "ws-tree-stopped-" + id); stopped.id = "ws-tree-stopped-" + id;
    body.append(live, stoppedToggle, stopped); root.append(header, body);
    return { root, header, body, live, stoppedToggle, stopped, rows: new Map() };
  }

  function updateSessionRow(group, tab) {
    let row = group.rows.get(tab.id);
    if (!row) {
      row = document.createElement("div"); row.className = "ws-session"; row.dataset.session = tab.id;
      row.append(button("Terminal", "", () => openTreeSession(tab.id), "ws-session-open"), button("Columns2", "在分屏打开", () => addSessionSplit(tab.id), "ws-icon ws-session-split"));
      group.rows.set(tab.id, row);
    }
    const pane = paneOfTab(tab.id), index = panes.indexOf(pane), phase = tab.alive ? statusOf(tab).phase : "offline";
    row.classList.toggle("is-active", !!pane && pane === active);
    const signature = JSON.stringify([displayName(tab), tab.cwd, tab.type, tab.alive, phase, index, pane === active, navigationPending, splitPending, switching, applyingLayout]);
    if (row.dataset.signature === signature) return row;
    row.dataset.signature = signature; row.dataset.phase = phase; row.classList.toggle("is-visible", !!pane);
    const open = row.firstElementChild, split = row.lastElementChild;
    const status = phases[phase] || "未知";
    open.innerHTML = '<span class="ws-session-dot" aria-hidden="true"></span><span class="ws-session-main"><span class="ws-session-name">' + esc(displayName(tab)) + '</span><small>' + esc(typeLabel(tab.type)) + ' · ' + esc(status) + '</small></span>' + (pane ? '<span class="ws-pane-badge">' + (index + 1) + '</span>' : "");
    open.title = displayName(tab) + " · " + typeLabel(tab.type) + " · " + status + (pane ? " · 窗格 " + (index + 1) : "") + "\n" + (tab.cwd || "");
    open.setAttribute("aria-label", (tab.alive ? "打开 " : "启动并恢复 ") + displayName(tab) + "，" + typeLabel(tab.type) + "，" + status + (pane ? "，窗格 " + (index + 1) : ""));
    open.setAttribute("aria-current", String(!!pane && pane === active));
    open.disabled = navigationPending || splitPending || switching || applyingLayout;
    split.hidden = !tab.alive; split.disabled = open.disabled;
    split.title = pane ? "聚焦窗格 " + (index + 1) : "在分屏打开"; split.setAttribute("aria-label", split.title);
    if (pane) open.querySelector(".ws-pane-badge").title = "窗格 " + (index + 1);
    return row;
  }

  function renderNavigation() {
    const list = $("ws-workspace-list"), query = $("ws-session-search").value.trim().toLowerCase();
    const groups = [...workspaces].sort((a, b) => Number(b.pinned) - Number(a.pinned));
    const assigned = new Set(workspaces.flatMap(space => space.members));
    const unassigned = state.tabs.filter(tab => !assigned.has(tab.id));
    if (unassigned.length) groups.push({ id: "_unassigned", name: "未分组", cwd: "", members: unassigned.map(tab => tab.id) });
    const wanted = [];
    for (const space of groups) {
      let group = treeGroups.get(space.id);
      if (!group) { group = makeTreeGroup(space.id); treeGroups.set(space.id, group); }
      const members = state.tabs.filter(tab => space.members.includes(tab.id));
      const matchesGroup = space.name.toLowerCase().includes(query);
      const tabs = members.filter(tab => !query || matchesGroup || (displayName(tab) + " " + tab.cwd + " " + typeLabel(tab.type)).toLowerCase().includes(query));
      group.root.hidden = !!query && !matchesGroup && !tabs.length;
      const expanded = !!query || !!treeState.expanded[space.id];
      const count = members.filter(tab => tab.alive).length, attention = members.filter(tab => ["needs_attention", "error"].includes(statusOf(tab).phase)).length;
      const heading = uiIcon(expanded ? "ChevronDown" : "ChevronRight") + uiIcon(space.pinned ? "Pin" : "Folder") + '<span class="ws-workspace-main"><b>' + esc(space.name) + '</b><small>' + count + ' 在线 · ' + members.length + ' 个窗口</small></span>' + (attention ? '<span class="ws-count attention" title="需要处理">' + attention + '</span>' : "");
      if (group.header.innerHTML !== heading) group.header.innerHTML = heading;
      group.header.title = space.name + (space.cwd ? "\n" + space.cwd : ""); group.header.setAttribute("aria-label", space.name);
      group.header.setAttribute("aria-current", String(space.id === current?.id)); group.header.setAttribute("aria-expanded", String(expanded));
      group.body.hidden = !expanded;
      const live = tabs.filter(tab => tab.alive), stopped = tabs.filter(tab => !tab.alive);
      orderChildren(group.live, live.map(tab => updateSessionRow(group, tab)));
      orderChildren(group.stopped, stopped.map(tab => updateSessionRow(group, tab)));
      const showStopped = !!query || !!treeState.stopped[space.id];
      group.stopped.hidden = !showStopped; group.stoppedToggle.hidden = !stopped.length;
      group.stoppedToggle.setAttribute("aria-expanded", String(showStopped));
      group.stoppedToggle.setAttribute("aria-label", "已停止 · " + stopped.length);
      const stoppedLabel = uiIcon(showStopped ? "ChevronDown" : "ChevronRight") + '<span>已停止 · ' + stopped.length + '</span>';
      if (group.stoppedToggle.innerHTML !== stoppedLabel) group.stoppedToggle.innerHTML = stoppedLabel;
      for (const [id, row] of group.rows) if (!members.some(tab => tab.id === id)) { row.remove(); group.rows.delete(id); }
      wanted.push(group.root);
    }
    for (const [id, group] of treeGroups) if (!groups.some(space => space.id === id)) { group.root.remove(); treeGroups.delete(id); }
    orderChildren(list, wanted);
    list.dataset.empty = String(!wanted.some(el => !el.hidden));
    if (restoreTreeScroll && initialized && (current || !workspaces.length)) {
      list.scrollTop = treeState.scroll; restoreTreeScroll = false;
    }
    const focused = active?.tab;
    $("workspace-project").textContent = focused ? displayName(focused) : "终端";
    $("workspace-project").title = focused?.cwd || "";
    for (const [index, pane] of panes.entries()) {
      let badge = pane.el.querySelector(".ws-pane-number");
      if (!badge) { badge = document.createElement("span"); badge.className = "ws-pane-number"; pane.el.querySelector(".pane-name").before(badge); }
      badge.textContent = String(index + 1); badge.title = "窗格 " + (index + 1);
    }
  }

  function treeKeydown(event) {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = [...$("ws-workspace-list").querySelectorAll("button")].filter(el => !el.disabled && !el.hidden && el.getClientRects().length);
    const index = buttons.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    const group = event.target.closest(".ws-tree-group"), header = group.querySelector(".ws-workspace");
    if (event.key === "ArrowRight" && event.target === header) {
      if (header.getAttribute("aria-expanded") === "false") header.click();
      else buttons[index + 1]?.focus();
    } else if (event.key === "ArrowLeft") {
      if (event.target !== header) header.focus();
      else if (header.getAttribute("aria-expanded") === "true") header.click();
    } else if (event.key !== "ArrowRight") buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  }

  async function sessionsChanged() {
    if (!state.sessionsLoaded) return;
    renderNavigation();
    if (refreshing || document.hidden || tokenPromptOpen) return;
    refreshing = true;
    try {
      const data = await api("/api/workspaces", {}, 0);
      if (!Array.isArray(data.workspaces)) return;
      workspaces = data.workspaces;
      if (!initialized) {
        const previous = localStorage.getItem("cc_workspace_active");
        const target = workspaces.find(space => space.id === previous) || workspaces.find(space => space.members.includes(active?.tab?.id)) || workspaces[0];
        await restoreDeviceLayout();
        if (target) await selectWorkspace(target.id);
      } else {
        const latest = workspaces.find(space => space.id === current?.id);
        if (latest) current = latest;
        else { current = null; if (workspaces[0]) await selectWorkspace(workspaces[0].id); }
      }
      if (Date.now() - lastRefresh > 5000) {
        const data = await api("/api/fleet", {}, 0);
        fleet = data.sessions || []; events = data.events || []; lastRefresh = Date.now();
        for (const tab of state.tabs) { const fresh = fleet.find(item => item.id === tab.id); if (fresh) tab.activity = fresh.activity; }
        $("ws-deck-updated").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        $("ws-deck-updated").title = "本地状态检查时间";
      }
      const working = state.tabs.filter(tab => statusOf(tab).phase === "working").length;
      const attention = state.tabs.filter(tab => ["needs_attention", "error"].includes(statusOf(tab).phase)).length;
      $("ws-working").hidden = !working; $("ws-working").textContent = working + " 处理中";
      $("ws-attention").hidden = !attention; $("ws-attention").textContent = attention + " 需要处理";
      renderNavigation();
      if (panel === "fleet" || panel === "activity") await renderPanel();
    } catch (error) { $("ws-deck-updated").textContent = "离线"; }
    finally { refreshing = false; }
  }

  function message(text, failed = false) {
    $("ws-deck-content").innerHTML = '<div class="ws-message' + (failed ? ' error' : '') + '">' + esc(text) + '</div>';
  }

  async function leaveEditor() {
    if (!editor?.dirty) return true;
    return !!(await uiConfirm("放弃未保存的修改？", editor.path));
  }

  async function openPanel(next) {
    if (next !== panel && !(await leaveEditor())) return;
    if (next !== panel) editor = null;
    panel = next; toggleDeck(true); closeDrawer();
    for (const el of $("ws-deck-tabs").children) el.setAttribute("aria-selected", String(el.dataset.panel === panel));
    await renderPanel();
  }

  async function renderPanel() {
    const seq = ++deckSequence, target = current?.id;
    const valid = () => seq === deckSequence && target === current?.id;
    $("ws-deck-title").textContent = { fleet: "任务", files: "文件", git: "Git", activity: "活动", settings: "设置" }[panel];
    if (panel === "fleet") { renderFleet(); return; }
    if (panel === "activity") { renderEvents(); return; }
    $("ws-deck-content").dataset.panel = panel;
    if (panel === "settings") { renderSettings(); return; }
    if (!current?.cwd) { message("未选择工作区"); return; }
    if (panel === "files" && editor) return;
    message("读取中");
    try {
      if (panel === "files") {
        const data = await api("/api/fs?path=" + encodeURIComponent(filePath || current.cwd), {}, 0);
        if (!valid()) return;
        renderFilesPanel(data);
      } else if (panel === "git") {
        const data = await api("/api/git/status?path=" + encodeURIComponent(current.cwd), {}, 0);
        if (!valid()) return;
        gitRoot = data.root; renderGit(data);
      }
    } catch (error) { if (valid()) message(error.message, true); }
  }

  function renderFleet() {
    const content = $("ws-deck-content");
    const tabs = state.tabs.filter(tab => globalFleet || !current || current.members.includes(tab.id));
    const signature = JSON.stringify([globalFleet, current?.id, current?.name, tabs.map(tab => [tab.id, displayName(tab), tab.cwd, tab.alive, statusOf(tab)])]);
    if (content.dataset.panel === "fleet" && content.dataset.signature === signature) return;
    content.dataset.panel = "fleet"; content.dataset.signature = signature;
    content.innerHTML = '<div class="ws-panel-toolbar"><span>' + esc(globalFleet ? "全部终端" : current?.name || "工作区") + '</span><div class="ws-segments"><button id="ws-fleet-current" aria-pressed="' + !globalFleet + '">当前</button><button id="ws-fleet-all" aria-pressed="' + globalFleet + '">全部</button></div></div>';
    $("ws-fleet-current").onclick = () => { globalFleet = false; renderFleet(); };
    $("ws-fleet-all").onclick = () => { globalFleet = true; renderFleet(); };
    const priority = { needs_attention: 0, error: 1, working: 2, complete: 3, idle: 4, online: 5, offline: 6 };
    for (const tab of [...tabs].sort((a, b) => priority[statusOf(a).phase] - priority[statusOf(b).phase])) {
      const status = statusOf(tab), row = document.createElement("section");
      row.className = "ws-agent"; row.dataset.session = tab.id;
      row.innerHTML = '<div class="ws-agent-head">' + uiIcon(tab.type === "shell" ? "Terminal" : "Bot") + '<span class="ws-agent-name">' + esc(displayName(tab)) + '</span><span class="ws-phase" data-phase="' + esc(status.phase) + '" title="' + esc(status.source) + '">' + esc(phases[status.phase] || "未知") + '</span></div><div class="ws-agent-meta"><span title="' + esc(tab.cwd) + '">' + esc(typeLabel(tab.type)) + ' · ' + esc(tabBasename(tab.cwd)) + '</span><div class="ws-agent-actions"></div></div>';
      const actions = row.querySelector(".ws-agent-actions");
      actions.append(button("ArrowUpRight", "打开会话", async () => { await openTab(tab); if (mqMobile.matches) toggleDeck(false); }), button("RotateCw", "重启并恢复原会话", () => requestRestartTab(tab)), button("Pencil", "重命名终端", () => renameTab(tab)));
      content.append(row);
    }
    if (!tabs.length) content.insertAdjacentHTML("beforeend", '<div class="ws-message">暂无终端</div>');
  }

  function renderEvents() {
    const content = $("ws-deck-content");
    const signature = JSON.stringify([events, state.tabs.map(tab => [tab.id, displayName(tab)])]);
    if (content.dataset.panel === "activity" && content.dataset.signature === signature) return;
    content.dataset.panel = "activity"; content.dataset.signature = signature;
    content.innerHTML = '<div class="ws-panel-toolbar"><span>最近活动</span><div id="ws-events-actions"></div></div>';
    $("ws-events-actions").append(button("CheckCheck", "全部标为已读", async () => {
      try { await api("/api/fleet/ack", { method: "POST", body: JSON.stringify({ ids: events.filter(e => !e.seen).map(e => e.id) }) }); events.forEach(e => { e.seen = 1; }); renderEvents(); }
      catch (error) { notify(error); }
    }));
    for (const event of events) {
      const tab = state.tabs.find(item => item.id === event.sid);
      if (!tab) continue;
      const el = document.createElement("button"); el.className = "ws-row"; el.dataset.seen = event.seen;
      el.innerHTML = uiIcon(event.phase === "complete" ? "Check" : "Bell") + '<span>' + esc(displayName(tab)) + ' · ' + esc(phases[event.phase]) + '</span><small>' + esc(new Date(event.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) + '</small>';
      el.onclick = async () => {
        try { await api("/api/fleet/ack", { method: "POST", body: JSON.stringify({ ids: [event.id] }) }); event.seen = 1; await openTab(tab); if (mqMobile.matches) toggleDeck(false); else renderEvents(); }
        catch (error) { notify(error); }
      };
      content.append(el);
    }
    if (!events.some(e => state.tabs.some(tab => tab.id === e.sid))) content.insertAdjacentHTML("beforeend", '<div class="ws-message">暂无活动</div>');
  }

  function renderFilesPanel(data) {
    filePath = data.path;
    const content = $("ws-deck-content");
    content.innerHTML = '<div class="ws-panel-toolbar"><span title="' + esc(filePath) + '">' + esc(tabBasename(filePath)) + '</span><div id="ws-files-actions"></div></div>';
    const up = button("ArrowUp", "上一级", () => { filePath = data.parent; renderPanel(); });
    up.disabled = filePath === current?.cwd || !data.parent;
    $("ws-files-actions").append(up, button("RefreshCw", "刷新文件", renderPanel), button("FolderOpen", "完整文件管理", openFilesModal));
    for (const entry of data.entries || []) {
      const el = document.createElement("button"); el.className = "ws-row"; el.dataset.file = entry.path;
      el.innerHTML = uiIcon(entry.type === "dir" ? "Folder" : "FileText") + '<span>' + esc(entry.name) + '</span>';
      el.onclick = async () => {
        if (!(await leaveEditor())) return;
        if (entry.type === "dir") { filePath = entry.path; await renderPanel(); }
        else await editFile(entry.path);
      };
      content.append(el);
    }
  }

  async function editFile(path) {
    const seq = ++deckSequence;
    try {
      const file = await api("/api/fs/edit?path=" + encodeURIComponent(path), {}, 0);
      if (seq !== deckSequence || panel !== "files") return;
      editor = { path, etag: file.etag, dirty: false, newline: file.newline || "lf" };
      const content = $("ws-deck-content");
      content.innerHTML = '<div class="ws-editor"><div class="ws-panel-toolbar"><span title="' + esc(path) + '">' + esc(tabBasename(path)) + '</span><div id="ws-editor-actions"></div></div><textarea id="ws-editor-text" spellcheck="false" aria-label="文件内容"></textarea><div id="ws-editor-state" class="ws-save-state" role="status">UTF-8 · 已保存</div></div>';
      $("ws-editor-text").value = file.text;
      $("ws-editor-text").oninput = () => { if (editor) editor.dirty = true; $("ws-editor-state").textContent = "未保存"; };
      $("ws-editor-actions").append(button("Save", "保存文件", saveFile), button("X", "关闭文件", async () => { if (await leaveEditor()) { editor = null; renderPanel(); } }));
    } catch (error) { if (seq === deckSequence) message(error.message, true); }
  }

  async function saveFile() {
    if (!editor?.dirty) return;
    const target = editor, value = $("ws-editor-text").value;
    $("ws-editor-state").textContent = "保存中";
    try {
      const text = target.newline === "crlf" ? value.replace(/\r?\n/g, "\r\n") : value;
      const result = await api("/api/fs/edit", { method: "PUT", body: JSON.stringify({ path: target.path, text, etag: target.etag }) });
      if (editor !== target) return;
      target.etag = result.etag; target.dirty = $("ws-editor-text").value !== value;
      $("ws-editor-state").textContent = target.dirty ? "未保存" : "UTF-8 · 已保存";
      $("ws-editor-state").classList.remove("error");
    } catch (error) { if (editor === target) { $("ws-editor-state").textContent = error.message; $("ws-editor-state").classList.add("error"); } }
  }

  function renderGit(data) {
    const content = $("ws-deck-content");
    content.innerHTML = '<div class="ws-panel-toolbar"><span>' + uiIcon("GitBranch") + ' ' + esc(data.branch) + '</span><div class="ws-segments"><button id="ws-git-work" aria-pressed="' + !gitStaged + '">工作区</button><button id="ws-git-staged" aria-pressed="' + gitStaged + '">暂存</button></div><div id="ws-git-actions"></div></div>';
    $("ws-git-work").onclick = () => { gitStaged = false; renderGit(data); };
    $("ws-git-staged").onclick = () => { gitStaged = true; renderGit(data); };
    $("ws-git-actions").append(button("RefreshCw", "刷新 Git", renderPanel));
    for (const change of data.changes || []) {
      if (gitStaged ? !change.status[0]?.trim() || change.status === "??" : !change.status[1]?.trim()) continue;
      const el = document.createElement("button"); el.className = "ws-row";
      el.innerHTML = '<small>' + esc(change.status.trim()) + '</small><span>' + esc(change.path) + '</span>';
      el.onclick = async () => {
        const seq = ++deckSequence;
        try {
          const diff = await api("/api/git/diff?path=" + encodeURIComponent(gitRoot) + "&file=" + encodeURIComponent(change.path) + "&staged=" + gitStaged, {}, 0);
          if (seq !== deckSequence || panel !== "git") return;
          content.querySelector(".ws-diff")?.remove();
          const pre = document.createElement("pre"); pre.className = "ws-diff";
          const text = diff.text || (change.status === "??" ? "未跟踪文件" : "无文本差异");
          pre.innerHTML = text.split("\n").map(line => '<span class="' + (line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "") + '">' + esc(line) + '</span>').join("\n") + (diff.truncated ? "\n[截断]" : "");
          content.append(pre);
        } catch (error) { notify(error); }
      };
      content.append(el);
    }
    if (!data.changes.length) content.insertAdjacentHTML("beforeend", '<div class="ws-message">工作树干净</div>');
  }

  function renderSettings() {
    const content = $("ws-deck-content"); content.innerHTML = '<div class="ws-settings" id="ws-settings"></div>';
    const add = (label, text, action) => {
      const row = document.createElement("div"); row.className = "ws-setting";
      const name = document.createElement("span"); name.textContent = label;
      const el = document.createElement("button"); el.textContent = text; el.onclick = action;
      row.append(name, el); $("ws-settings").append(row);
    };
    add("主题", currentTheme() === "dark" ? "浅色" : "深色", () => { toggleTheme(); renderSettings(); });
    window.ccAppearance?.mountSettings($("ws-settings"));
    add("终端版本", "检测与更新", () => $("btn-versions").click());
    add("资源监控", "打开", openGpuModal);
    add("文件管理", "打开", openFilesModal);
    add("访问记录", "打开", openIpsModal);
    add("界面", "回退到旧版", () => { localStorage.setItem("cc_ui", "legacy"); location.href = "/?ui=legacy"; });
    add("分屏布局", "重新载入", restoreDeviceLayout);
    if (current) {
      add("工作区名称", "重命名", async () => { const name = await uiPrompt("重命名工作区", current.name); if (name) { try { await changeWorkspace({ name }); renderSettings(); } catch (error) { notify(error); } } });
      add("固定工作区", current.pinned ? "取消固定" : "固定", async () => { try { await changeWorkspace({ pinned: !current.pinned }); renderSettings(); } catch (error) { notify(error); } });
      add("删除工作区", "删除", async () => {
        if (!(await uiConfirm("删除工作区「" + current.name + "」？", "仅移除工作区分组，当前分屏和终端任务保持不变。", true))) return;
        try {
          const id = current.id; await api("/api/workspaces/" + id + "?revision=" + current.revision, { method: "DELETE" });
          workspaces = workspaces.filter(space => space.id !== id); current = null;
          if (workspaces[0]) await selectWorkspace(workspaces[0].id); else { renderNavigation(); renderSettings(); }
        } catch (error) { notify(error); }
      });
    }
  }

  let paletteActions = [], paletteIndex = 0;
  function renderPalette() {
    const q = $("ws-palette-input").value.trim().toLowerCase();
    const commands = [
      ["新终端", "Terminal", openDirModal], ["新建工作区", "Plus", createWorkspace], ["分屏", "Columns2", openSplitPicker],
      ["搜索终端历史", "TextSearch", openHistory], ["版本与更新", "PackageSearch", () => $("btn-versions").click()],
      ["文件", "FolderTree", () => openPanel("files")], ["Git", "GitBranch", () => openPanel("git")],
      ["活动", "Bell", () => openPanel("activity")], ["资源监控", "Activity", openGpuModal],
      ["重启并恢复原会话", "RotateCw", () => active?.tab && requestRestartTab(active.tab)],
      ["显示或隐藏侧栏", "PanelLeft", toggleSidebar], ["切换主题", "SunMoon", toggleTheme],
    ];
    paletteActions = [...commands.map(([label, icon, action]) => ({ label, icon, action })),
      ...workspaces.map(space => ({ label: space.name, icon: "Folder", kind: "工作区", action: () => selectWorkspace(space.id) })),
      ...state.tabs.map(tab => ({ label: displayName(tab), icon: "Terminal", kind: typeLabel(tab.type), action: () => openTab(tab) }))].filter(item => item.label.toLowerCase().includes(q));
    paletteIndex = Math.min(paletteIndex, Math.max(0, paletteActions.length - 1));
    $("ws-palette-list").replaceChildren();
    paletteActions.forEach((item, index) => {
      const row = document.createElement("button"); row.className = "ws-row"; row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(index === paletteIndex));
      row.innerHTML = uiIcon(item.icon) + '<span>' + esc(item.label) + '</span><small>' + esc(item.kind || "命令") + '</small>';
      row.onclick = () => { closeLayer(palette); Promise.resolve(item.action()).catch(notify); };
      $("ws-palette-list").append(row);
    });
  }
  function openPalette() { paletteIndex = 0; $("ws-palette-input").value = ""; renderPalette(); openLayer(palette); setTimeout(() => $("ws-palette-input").focus(), 20); }
  function openHistory() {
    if (!active?.tab?.alive) { showToast("未连接活动终端"); return; }
    historyTarget = active.tab.id; historySequence++;
    $("ws-history-title").textContent = "终端历史 · " + displayName(active.tab);
    $("ws-history-input").value = ""; $("ws-history-results").replaceChildren(); $("ws-history-state").textContent = "";
    openLayer(historyModal); setTimeout(() => $("ws-history-input").focus(), 20);
  }
  $("ws-palette-input").oninput = () => { paletteIndex = 0; renderPalette(); };
  palette.addEventListener("click", event => { if (event.target === palette) closeLayer(palette); });
  historyModal.addEventListener("click", event => { if (event.target === historyModal) closeLayer(historyModal); });
  document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "p") {
      event.preventDefault(); event.stopImmediatePropagation(); openPalette(); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault(); event.stopImmediatePropagation(); openHistory(); return;
    }
    if (!replaceModal.classList.contains("hidden") && event.key === "Escape") {
      event.preventDefault(); event.stopImmediatePropagation(); if (!splitPending) closeLayer(replaceModal);
    }
    else if (!splitModal.classList.contains("hidden") && event.key === "Escape" && !applyingLayout && !splitPending) { event.preventDefault(); closeLayer(splitModal); }
    else if (!palette.classList.contains("hidden")) {
      if (event.key === "Escape") { event.preventDefault(); closeLayer(palette); }
      if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); paletteIndex = Math.max(0, Math.min(paletteActions.length - 1, paletteIndex + (event.key === "ArrowDown" ? 1 : -1))); renderPalette(); $("ws-palette-list").children[paletteIndex]?.scrollIntoView({ block: "nearest" }); }
      if (event.key === "Enter") { event.preventDefault(); $("ws-palette-list").children[paletteIndex]?.click(); }
    } else if (!historyModal.classList.contains("hidden") && event.key === "Escape") { event.preventDefault(); closeLayer(historyModal); }
    else if (event.key === "Escape" && mqMobile.matches && !document.body.classList.contains("deck-closed")) { toggleDeck(false); }
  }, true);
  $("ws-working").onclick = () => { globalFleet = true; openPanel("fleet"); };
  $("ws-attention").onclick = async () => {
    const tab = state.tabs.find(item => ["needs_attention", "error"].includes(statusOf(item).phase));
    if (tab) await openTab(tab); else openPanel("activity");
  };
  let deviceChange = Promise.resolve();
  mqMobile.addEventListener("change", () => {
    closeLayer(splitModal);
    closeLayer(replaceModal);
    deviceChange = deviceChange.then(async () => { if (device !== deviceKey() && await persist()) await restoreDeviceLayout(); }).catch(notify);
    toggleDeck(!mqMobile.matches && localStorage.getItem("cc_workspace_deck") !== "0");
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { saveTreeState(); persist(); } else sessionsChanged(); });
  window.addEventListener("pagehide", saveTreeState);
  window.addEventListener("beforeunload", event => { if (editor?.dirty) { event.preventDefault(); event.returnValue = ""; } });
  window.ccWorkspace = {
    sessionsChanged, layoutChanged, beforeOpen, openSplitPicker,
    async terminalCreated(tab) {
      if (current && !current.members.includes(tab.id)) {
        try { await changeWorkspace({ members: [...current.members, tab.id] }); } catch (error) { notify(error); }
      }
    },
    focusChanged() { renderNavigation(); layoutChanged(); },
    get current() { return current; }, get ready() { return initialized; }, persist,
  };
  toggleDeck(!mqMobile.matches && (localStorage.getItem("cc_workspace_deck") === "1" || (window.innerWidth >= 1280 && localStorage.getItem("cc_workspace_deck") !== "0")));
  renderFleet();
  sessionsChanged();
  setInterval(() => { if (!document.hidden) sessionsChanged(); }, 10000);
})();
