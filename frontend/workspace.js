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
  let workspaces = [], workspacesLoaded = false, current = null, view = null, switching = false, selecting = false, initialized = false, applyingLayout = false;
  let refreshing = false, dirty = false, saving = null, saveTimer = null, conflict = false;
  let layoutOffline = false, restoreRetryAt = 0;
  let layoutBase = null, resolvingLayout = false;
  let screens = [], activeScreen = null, changeVersion = 0;
  const writer = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  let tokenBinding = null, checkpointKey = "", checkpointSaving = null;
  const validUser = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(value);
  const validIdentity = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,48}$/.test(value);
  let remembered = {};
  try { remembered = JSON.parse(decodeURIComponent(document.cookie.split("; ").find(value => value.startsWith("cc_layout_binding="))?.split("=").slice(1).join("=") || "{}")); } catch (_) {}
  if (!remembered || typeof remembered !== "object" || Array.isArray(remembered)) remembered = {};
  const address = new URL(location.href), addressUser = address.searchParams.get("layoutUser"), addressDevice = address.searchParams.get("layoutDevice");
  let layoutUser = validUser(addressUser) ? addressUser : validIdentity(addressDevice) ? "" : localStorage.getItem("cc_layout_user") ?? remembered.user ?? "";
  if (!validUser(layoutUser)) layoutUser = "";
  layoutUser = layoutUser.toLowerCase();
  let panel = "fleet", globalFleet = false, fleet = [], events = [], deckSequence = 0;
  let editor = null, filePath = "", gitRoot = "", gitStaged = false, lastRefresh = 0;
  let identity = validIdentity(addressDevice) && !validUser(addressUser) ? addressDevice : localStorage.getItem("cc_workspace_device") || remembered.identity;
  if (!validIdentity(identity)) {
    identity = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
  const deviceKey = (user = layoutUser, id = identity) => (mqMobile.matches ? "mobile_" : "desktop_") + (user ? "user_" + user : id);
  let device = deviceKey();
  function rememberLayoutBinding() {
    localStorage.setItem("cc_layout_user", layoutUser);
    localStorage.setItem("cc_workspace_device", identity);
    try { document.cookie = "cc_layout_binding=" + encodeURIComponent(JSON.stringify({ user: layoutUser, identity })) + "; Path=/; Max-Age=31536000; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : ""); } catch (_) {}
    const url = new URL(location.href);
    url.searchParams.delete("layoutUser"); url.searchParams.delete("layoutDevice");
    url.searchParams.set(layoutUser ? "layoutUser" : "layoutDevice", layoutUser || identity);
    try { history.replaceState(history.state, "", url); } catch (_) {}
  }
  rememberLayoutBinding();
  async function layoutRequest(path, options = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try { return await api(path, { ...options, cache: "no-store", signal: controller.signal }, 0); }
    finally { clearTimeout(timer); }
  }
  function bindingIdentity(target, kind) {
    if (typeof target !== "string" || !target.startsWith(kind + "_")) throw new Error("布局绑定不可用");
    const suffix = target.slice(kind.length + 1), user = suffix.startsWith("user_") ? suffix.slice(5) : "";
    if (suffix.startsWith("user_") ? !validUser(user) : !validIdentity(suffix)) throw new Error("布局绑定不可用");
    return { user, identity: user ? identity : suffix };
  }
  async function resolveTokenBinding() {
    const kind = mqMobile.matches ? "mobile" : "desktop", path = "/api/layout-binding/" + kind;
    const candidate = deviceKey();
    let binding = await layoutRequest(path);
    if (kind !== (mqMobile.matches ? "mobile" : "desktop")) return false;
    if (binding.enabled === false) { tokenBinding = null; return true; }
    if (binding.enabled !== true || !Number.isInteger(binding.revision)) throw new Error("后台尚不支持 Token 布局恢复，请更新后台后重试");
    const explicit = new URL(location.href).searchParams.get("restoreLayout") === "1";
    if (!binding.device || (explicit && candidate !== binding.device)) {
      if (binding.device) {
        const saved = await layoutRequest("/api/layouts/" + candidate);
        if (!saved.revision) throw new Error("恢复链接中的布局不存在，原布局未更改");
      }
      try {
        binding = await layoutRequest(path, { method: "PUT", body: JSON.stringify({ device: candidate, revision: binding.revision }) });
      } catch (error) {
        // Read after an uncertain response; never repeat a binding write blindly.
        const confirmed = await layoutRequest(path);
        if (!confirmed.device || (explicit && confirmed.device !== candidate)) throw error;
        binding = confirmed;
      }
    }
    const selected = bindingIdentity(binding.device, kind);
    if (kind !== (mqMobile.matches ? "mobile" : "desktop")) return false;
    tokenBinding = { ...binding, kind };
    layoutUser = selected.user; identity = selected.identity;
    const url = new URL(location.href); url.searchParams.delete("restoreLayout");
    history.replaceState(history.state, "", url);
    rememberLayoutBinding();
    return true;
  }
  const button = (icon, title, action, cls = "ws-icon") => {
    const el = document.createElement("button");
    el.className = cls; el.type = "button"; el.title = title; el.setAttribute("aria-label", title);
    el.innerHTML = uiIcon(icon); el.onclick = action;
    return el;
  };
  const notify = error => showToast(error.message || String(error));
  const screenBar = document.createElement("section");
  screenBar.id = "ws-screen-bar";
  screenBar.setAttribute("aria-label", "屏幕与布局用户");
  screenBar.innerHTML = '<div id="ws-screen-strip"><div id="ws-screen-tabs" role="tablist" aria-label="屏幕"></div></div><div id="ws-screen-tools"></div><button id="ws-layout-user" type="button"></button>';
  $("main").insertBefore(screenBar, $("empty"));
  const addScreenButton = button("Plus", "新建屏幕", createScreen);
  addScreenButton.id = "ws-screen-add";
  $("ws-screen-strip").append(addScreenButton);
  const renameScreenButton = button("Pencil", "重命名屏幕", () => renameScreen(), "ws-icon ws-screen-rename");
  const renameScreenLabel = document.createElement("span"); renameScreenLabel.textContent = "重命名";
  renameScreenButton.append(renameScreenLabel);
  $("ws-screen-tools").append(renameScreenButton,
    button("Trash2", "删除当前屏幕", deleteScreen), button("RefreshCw", "重新载入屏幕布局", reloadScreens));
  const orderScreenButton = button("ListOrdered", "屏幕排序", openScreenOrder);
  orderScreenButton.id = "ws-screen-order";
  $("ws-screen-tools").append(orderScreenButton);
  const saveLayoutButton = button("Save", "保存当前布局副本", saveCurrentLayout, "ws-icon ws-screen-save");
  saveLayoutButton.id = "ws-layout-save";
  const saveLayoutLabel = document.createElement("span"); saveLayoutLabel.textContent = "保存布局";
  saveLayoutButton.append(saveLayoutLabel); $("ws-screen-tools").append(saveLayoutButton);
  $("ws-layout-user").onclick = openLayoutUser;
  const userModal = document.createElement("div");
  userModal.id = "ws-user-modal"; userModal.className = "modal hidden";
  userModal.setAttribute("role", "dialog"); userModal.setAttribute("aria-modal", "true"); userModal.setAttribute("aria-labelledby", "ws-user-title");
  userModal.innerHTML = '<form id="ws-user-form" class="modal-box ws-user-box"><div class="modal-head"><h3 id="ws-user-title">绑定布局用户</h3><div id="ws-user-close"></div></div><label for="ws-user-input">用户名</label><input id="ws-user-input" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="40" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}" placeholder="demo" required><p class="ws-user-notice">同名档案共享屏幕布局，电脑与手机分别保存。此名称不是登录账号，不隔离终端权限；仍需网页访问凭据。</p><div id="ws-user-state" role="status"></div><div class="modal-foot"><button id="ws-user-local" type="button" class="btn-sm">仅使用本机布局</button><button id="ws-user-bind" type="submit" class="btn-sm primary">绑定并恢复</button></div></form>';
  document.body.append(userModal);
  const recoveryTools = document.createElement("div"); recoveryTools.className = "ws-layout-recovery-tools";
  for (const [icon, title, action, id] of [["History", "找回已保存布局", loadSavedLayouts, "ws-layout-history"], ["Link", "复制恢复链接", copyLayoutLink, "ws-layout-link"]]) {
    const el = button(icon, title, action, "btn-sm"); el.id = id;
    const label = document.createElement("span"); label.textContent = title; el.append(label); recoveryTools.append(el);
  }
  $("ws-user-state").before(recoveryTools);
  const layoutCatalog = document.createElement("div"); layoutCatalog.id = "ws-layout-catalog"; layoutCatalog.className = "hidden";
  $("ws-user-state").before(layoutCatalog);
  $("ws-user-close").append(button("X", "关闭布局用户", () => { if (!splitPending) closeLayer(userModal); }));
  userModal.addEventListener("click", event => { if (event.target === userModal && !splitPending) closeLayer(userModal); });
  $("ws-user-form").onsubmit = event => { event.preventDefault(); bindLayoutUser($("ws-user-input").value.trim().toLowerCase()); };
  $("ws-user-local").onclick = () => bindLayoutUser("");
  $("ws-screen-tabs").addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && ["ArrowLeft", "ArrowRight"].includes(event.key) && event.target.matches('[role="tab"]')) {
      event.preventDefault(); event.stopPropagation();
      shiftScreen(event.target.dataset.screen, event.key === "ArrowLeft" ? -1 : 1); return;
    }
    if (event.key === "F2" && event.target.matches('[role="tab"]')) {
      event.preventDefault(); event.stopPropagation(); renameScreen(event.target.dataset.screen); return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const index = screens.findIndex(screen => screen.id === activeScreen);
    const next = event.key === "Home" ? 0 : event.key === "End" ? screens.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + screens.length) % screens.length;
    if (screens[next]) switchScreen(screens[next].id).then(() => $("ws-screen-tabs").querySelector('[aria-selected="true"]')?.focus());
  });
  const treeGroups = new Map();
  const renamingSessions = new Set();
  let revealFrame = null;
  let usage = {};
  try { usage = JSON.parse(localStorage.getItem("cc_workspace_usage") || "{}"); if (!usage || typeof usage !== "object" || Array.isArray(usage)) usage = {}; } catch (_) {}
  const usageWrites = new Map();
  function touchWorkspace(space) {
    if (!space || !initialized || switching || applyingLayout || document.hidden) return;
    const now = Date.now(), previous = usageWrites.get(space.id);
    if (previous && now - previous < 30000) return;
    usage[space.id] = now; usageWrites.set(space.id, now);
    try { localStorage.setItem("cc_workspace_usage", JSON.stringify(usage)); } catch (_) {}
    renderNavigation();
    api("/api/workspaces/" + space.id + "/activate", { method: "POST" }, 0).then(data => {
      const latest = workspaces.find(item => item.id === space.id);
      if (latest) latest.lastUsed = data.lastUsed;
    }).catch(() => {});
  }
  function interacted(sid) {
    for (const space of workspaces) if (space.members.includes(sid)) touchWorkspace(space);
  }
  function activeTime(space, now) {
    const validTime = value => Number.isFinite(Number(value)) ? Math.min(now, Math.max(0, Number(value))) : 0;
    return Math.max(validTime(usage[space.id]), validTime(space.lastUsed * 1000),
      ...state.tabs.filter(tab => space.members.includes(tab.id)).map(tab => validTime(statusOf(tab).updatedAt * 1000)));
  }
  const workspaceNames = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
  let treeState = readTreeState(), treeSaveTimer = null, restoreTreeScroll = true, navigationPending = false;
  function readTreeState(targetDevice = deviceKey()) {
    try {
      const value = JSON.parse(localStorage.getItem("cc_workspace_tree_" + targetDevice) || "null");
      return { expanded: { ...value?.expanded }, stopped: { ...value?.stopped }, scroll: Math.max(0, Number(value?.scroll) || 0), sort: value?.sort === "name" ? "name" : "activity" };
    } catch (_) { return { expanded: {}, stopped: {}, scroll: 0, sort: "activity" }; }
  }
  function saveTreeState() {
    clearTimeout(treeSaveTimer);
    try { localStorage.setItem("cc_workspace_tree_" + device, JSON.stringify(treeState)); } catch (_) {}
  }
  const sidebar = document.createElement("section");
  sidebar.className = "ws-sidebar";
  sidebar.innerHTML = '<div class="ws-section-head"><span>工作区</span><div id="ws-space-tools"></div></div><label class="ws-tree-search">' + uiIcon("Search") + '<input id="ws-session-search" type="search" placeholder="搜索会话" aria-label="搜索工作区或会话" autocomplete="off"></label><nav id="ws-workspace-list" class="ws-workspace-list" aria-label="工作区与终端"></nav><div id="ws-save-indicator" class="ws-save-indicator" role="status"></div><div id="ws-sidebar-actions" class="ws-sidebar-actions"></div>';
  $("sidebar").insertBefore(sidebar, $("sidebar").querySelector(".workspace-nav"));
  const workspaceSort = document.createElement("select"); workspaceSort.id = "ws-workspace-sort";
  workspaceSort.setAttribute("aria-label", "工作区排序"); workspaceSort.title = "工作区排序（置顶优先）";
  workspaceSort.innerHTML = '<option value="activity">最近活跃</option><option value="name">名称 A–Z</option>';
  workspaceSort.value = treeState.sort;
  workspaceSort.onchange = () => { treeState.sort = workspaceSort.value; saveTreeState(); renderNavigation(); };
  $("ws-space-tools").append(workspaceSort);
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
  sidebarResize.ondblclick = () => resizeSidebar(272, true);
  window.addEventListener("resize", () => { if (sidebarWidth && !mqMobile.matches) resizeSidebar(sidebarWidth); });
  if (sidebarWidth && !mqMobile.matches) resizeSidebar(sidebarWidth);
  else { sidebarResize.setAttribute("aria-valuemin", "200"); sidebarResize.setAttribute("aria-valuemax", String(maxSidebarWidth())); sidebarResize.setAttribute("aria-valuenow", String($("sidebar").getBoundingClientRect().width)); }
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
  // Move the original controls rather than mirroring actions or terminal state.
  const primaryActions = document.createElement("div");
  primaryActions.className = "ws-primary-actions"; primaryActions.setAttribute("role", "group");
  primaryActions.setAttribute("aria-label", "常用终端操作");
  $("workspace-header").querySelector(".workspace-actions").insertBefore(primaryActions, $("btn-versions"));
  const primaryControls = ["btn-copy", "btn-copy-session-id", "btn-img", "btn-reference", "btn-permissions"].filter(id => $(id)).map(id => {
    const el = $(id), marker = document.createComment(id); el.before(marker); return { el, marker };
  });
  function placePrimaryActions() {
    for (const { el, marker } of primaryControls) {
      if (mqMobile.matches && el.id === "btn-permissions") $("topbar").insertBefore(el, $("btn-files-m"));
      else if (mqMobile.matches) marker.after(el); else primaryActions.append(el);
    }
  }
  placePrimaryActions();
  mqMobile.addEventListener("change", placePrimaryActions);
  // Compact chrome for landscape and the visual viewport above a soft keyboard.
  function updateChromeHeight() {
    const viewport = window.visualViewport;
    if (viewport && viewport.scale > 1.05) return;
    document.body.classList.toggle("ws-compact-height", mqMobile.matches && (viewport?.height || innerHeight) < 560);
  }
  updateChromeHeight();
  window.visualViewport?.addEventListener("resize", updateChromeHeight);
  window.addEventListener("resize", updateChromeHeight);
  const deck = document.createElement("aside");
  deck.id = "ws-deck"; deck.className = "ws-deck"; deck.setAttribute("aria-label", "任务面板");
  deck.innerHTML = '<div class="ws-deck-head"><span class="ws-deck-title" id="ws-deck-title">任务</span><span id="ws-deck-updated" class="ws-count"></span><div id="ws-deck-actions"></div></div><div id="ws-deck-tabs" class="ws-deck-tabs" role="tablist" aria-label="工作区面板"></div><div id="ws-deck-content" class="ws-deck-content" role="tabpanel"></div>';
  $("body").append(deck);
  const deckScrim = document.createElement("div"); deckScrim.className = "ws-deck-scrim"; deckScrim.hidden = true;
  deckScrim.setAttribute("aria-hidden", "true"); deckScrim.onclick = () => toggleDeck(false); $("body").append(deckScrim);
  $("ws-deck-actions").append(button("X", "收起任务面板", () => toggleDeck(false)));
  for (const [id, icon, label] of [["fleet", "Bot", "任务"], ["files", "FolderTree", "文件"], ["git", "GitBranch", "Git"], ["activity", "Bell", "活动"], ["settings", "Settings2", "设置"]]) {
    const el = button(icon, label, () => openPanel(id));
    el.dataset.panel = id; el.id = "ws-panel-tab-" + id; el.setAttribute("role", "tab"); el.setAttribute("aria-selected", String(panel === id));
    el.setAttribute("aria-controls", "ws-deck-content"); el.tabIndex = panel === id ? 0 : -1;
    const name = document.createElement("span"); name.textContent = label; el.append(name);
    $("ws-deck-tabs").append(el);
  }
  $("ws-deck-content").setAttribute("aria-labelledby", "ws-panel-tab-" + panel);
  $("ws-deck-tabs").addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const items = [...$("ws-deck-tabs").children], index = items.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault(); event.stopPropagation();
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    openPanel(items[next].dataset.panel).then(() => { if (panel === items[next].dataset.panel) items[next].focus(); });
  });
  const palette = document.createElement("div");
  palette.id = "ws-palette-modal"; palette.className = "modal hidden"; palette.setAttribute("role", "dialog"); palette.setAttribute("aria-modal", "true"); palette.setAttribute("aria-label", "命令与会话");
  palette.innerHTML = '<div class="modal-box ws-palette"><input id="ws-palette-input" type="search" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="ws-palette-list" autocomplete="off" placeholder="搜索命令、工作区或会话" aria-label="搜索命令、工作区或会话"><div id="ws-palette-list" class="ws-palette-list" role="listbox" aria-label="命令与会话结果"></div><div id="ws-palette-empty" class="ws-message" role="status" hidden>没有匹配结果</div></div>';
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
  const splitCreate = button("Plus", "新建终端", createSplitTerminal, "btn-sm ws-split-create");
  splitCreate.id = "ws-split-create";
  const splitCreateLabel = document.createElement("span"); splitCreateLabel.textContent = "新建终端";
  splitCreate.append(splitCreateLabel);
  $("ws-split-close").before(splitCreate);
  $("ws-split-close").append(button("X", "取消分屏选择", () => closeLayer(splitModal)));
  const splitLookup = button("Hash", "按 ID 打开", () => closeLayer(splitModal, () => window.ccSessionLookup?.open()), "btn-sm");
  splitLookup.id = "ws-split-lookup";
  const splitLookupLabel = document.createElement("span"); splitLookupLabel.textContent = "按 ID 打开";
  splitLookup.append(splitLookupLabel); $("ws-split-directions").after(splitLookup);
  const replaceModal = document.createElement("div");
  replaceModal.id = "ws-replace-modal"; replaceModal.className = "modal hidden";
  replaceModal.setAttribute("role", "dialog"); replaceModal.setAttribute("aria-modal", "true"); replaceModal.setAttribute("aria-labelledby", "ws-replace-title");
  replaceModal.innerHTML = '<div class="modal-box ws-replace-box"><div class="modal-head"><h3 id="ws-replace-title">选择要替换的窗格</h3><div id="ws-replace-close"></div></div><div id="ws-replace-list"></div></div>';
  document.body.append(replaceModal);
  $("ws-replace-close").append(button("X", "取消替换", () => closeLayer(replaceModal)));
  replaceModal.addEventListener("click", event => { if (event.target === replaceModal && !splitPending) closeLayer(replaceModal); });
  const moveModal = document.createElement("div");
  moveModal.id = "ws-move-modal"; moveModal.className = "modal hidden";
  moveModal.setAttribute("role", "dialog"); moveModal.setAttribute("aria-modal", "true"); moveModal.setAttribute("aria-labelledby", "ws-move-title");
  moveModal.innerHTML = '<div class="modal-box ws-move-box"><div class="modal-head"><h3 id="ws-move-title">移到其他屏幕</h3><div id="ws-move-close"></div></div><div id="ws-move-session"></div><div id="ws-move-list"></div><div id="ws-move-state" role="status"></div></div>';
  document.body.append(moveModal);
  let moveContext = null, screenDrag = null;
  let tabDrag = null, suppressScreenClickUntil = 0, orderDevice = null;
  const orderModal = document.createElement("div");
  orderModal.id = "ws-order-modal"; orderModal.className = "modal hidden";
  orderModal.setAttribute("role", "dialog"); orderModal.setAttribute("aria-modal", "true"); orderModal.setAttribute("aria-labelledby", "ws-order-title");
  orderModal.innerHTML = '<div class="modal-box ws-order-box"><div class="modal-head"><h3 id="ws-order-title">屏幕排序</h3><div id="ws-order-close"></div></div><ol id="ws-order-list" aria-label="屏幕顺序"></ol><div id="ws-order-state" role="status"></div></div>';
  document.body.append(orderModal);
  $("ws-order-close").append(button("X", "关闭屏幕排序", () => closeLayer(orderModal)));
  orderModal.addEventListener("click", event => { if (event.target === orderModal) closeLayer(orderModal); });
  $("ws-move-close").append(button("X", "取消移动", () => { if (!splitPending) closeLayer(moveModal); }));
  moveModal.addEventListener("click", event => { if (event.target === moveModal && !splitPending) closeLayer(moveModal); });
  $("panes").addEventListener("dragstart", event => {
    const pane = dragSrcPane;
    screenDrag = pane && event.target === pane.el.querySelector(".pane-bar") ? paneMoveContext(pane) : null;
  });
  document.addEventListener("dragend", clearScreenDrag);
  document.addEventListener("dragend", clearTabDrag);
  window.addEventListener("blur", clearTabDrag);
  document.addEventListener("visibilitychange", () => { if (document.hidden) clearTabDrag(); });
  document.addEventListener("keydown", event => {
    if (tabDrag && event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); clearTabDrag(); }
  }, true);
  addScreenDropTarget(addScreenButton, null);
  $("ws-screen-strip").addEventListener("dragover", event => {
    if (!screenDrag && !tabDrag) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left + 24) event.currentTarget.scrollLeft -= 24;
    else if (event.clientX > rect.right - 24) event.currentTarget.scrollLeft += 24;
  });
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
      if (selected.some(id => !state.tabs.some(tab => tab.id === id))) throw new Error("所选终端已移除，请重新选择");
      applyingLayout = true;
      reconcilePanes({ ...snapshot(), panes: selected, active: selected.includes(active?.tab?.id) ? active.tab.id : selected[0], direction: splitDirection });
      applyingLayout = false;
      interacted(active?.tab?.id);
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
    const wasMobile = deck.hasAttribute("data-modal-layer"), modal = open && mqMobile.matches;
    const ownedFocus = deck.contains(document.activeElement) || document.activeElement === document.body;
    if (modal && !wasMobile) deck.__ccReturnFocus = document.activeElement;
    document.body.classList.toggle("deck-closed", !open);
    deckScrim.hidden = !modal;
    $("main").inert = modal; $("sidebar").inert = modal;
    if (modal) {
      deck.dataset.modalLayer = "true"; deck.setAttribute("role", "dialog"); deck.setAttribute("aria-modal", "true");
      if (!wasMobile) $("ws-deck-tabs").querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
    } else {
      deck.removeAttribute("data-modal-layer"); deck.removeAttribute("role"); deck.removeAttribute("aria-modal");
      if (wasMobile && ownedFocus) deck.__ccReturnFocus?.focus({ preventScroll: true });
      delete deck.__ccReturnFocus;
    }
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

  async function changeWorkspace(fields, target = current) {
    if (!target) return;
    const result = await api("/api/workspaces/" + target.id, { method: "PATCH", body: JSON.stringify({ ...fields, revision: target.revision }) });
    workspaces = workspaces.map(workspace => workspace.id === result.id ? result : workspace);
    if (current?.id === result.id) current = result;
    renderNavigation();
  }

  function indicator(text, failed = false) {
    $("ws-save-indicator").textContent = text;
    $("ws-save-indicator").classList.toggle("error", failed);
    conflictButton.hidden = !failed;
  }

  const conflictButton = button("GitMerge", "处理布局同步", async () => {
    if (splitPending || switching || applyingLayout || resolvingLayout) return;
    splitPending = true; renderScreens();
    try { await resolveLayoutConflict(); }
    finally { splitPending = false; renderNavigation(); }
  }, "btn-sm ws-layout-sync-action");
  conflictButton.append(document.createTextNode("处理布局同步"));
  conflictButton.hidden = true;
  $("ws-save-indicator").after(conflictButton);

  function rememberBase(value, target = device) {
    layoutBase = Array.isArray(value?.screens) ? { device: target, revision: value.revision, layout: screenSet(value, target.startsWith("mobile_")) } : null;
  }

  function sameLayout(a, b) {
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  }

  function mergeLayouts(base, local, remote) {
    const choose = (b, l, r) => sameLayout(l, r) || sameLayout(r, b) ? l : sameLayout(l, b) ? r : undefined;
    if (!base) return sameLayout(local.screens, remote.screens) ? local : null;
    const maps = [base, local, remote].map(value => new Map(value.screens.map(screen => [screen.id, screen])));
    const merged = new Map();
    for (const id of new Set([...maps[0].keys(), ...maps[1].keys(), ...maps[2].keys()])) {
      const [b, l, r] = maps.map(map => map.get(id));
      if (!l && !r) continue;
      const value = choose(b, l, r);
      if (value === undefined) {
        // A deletion is safe only if the other side kept the original intact.
        if ((!l && sameLayout(b, r)) || (!r && sameLayout(b, l))) continue;
        return null;
      }
      merged.set(id, value);
    }
    const common = base.screens.map(s => s.id).filter(id => merged.has(id));
    const order = value => value.screens.map(s => s.id).filter(id => common.includes(id));
    const chosenOrder = choose(common, order(local), order(remote));
    if (!chosenOrder || !merged.size || merged.size > 16 || !merged.has(local.activeScreen)) return null;
    const ids = [...chosenOrder, ...remote.screens.map(s => s.id), ...local.screens.map(s => s.id)];
    const result = [...new Set(ids)].filter(id => merged.has(id)).map(id => merged.get(id));
    const sessions = result.flatMap(s => s.panes.filter(Boolean));
    if (new Set(sessions).size !== sessions.length) return null;
    return screenSet({ screens: result, activeScreen: local.activeScreen });
  }

  function chooseConflict() {
    return new Promise(resolve => {
      const modal = document.createElement("div"); modal.className = "modal"; modal.id = "ws-conflict-modal";
      modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-labelledby", "ws-conflict-title");
      modal.innerHTML = '<div class="modal-box ws-user-box"><div class="modal-head"><h3 id="ws-conflict-title">选择要保留的布局</h3></div><p>本机与服务器的修改无法安全合并。本机布局会先备份，不会停止终端任务。</p><p>采用服务器布局会替换当前排列；另存并切换会保留独立副本，同一 Token 下次打开将恢复此副本。</p><div class="modal-foot"></div></div>';
      const done = choice => { closeLayer(modal); modal.remove(); document.removeEventListener("keydown", escape, true); resolve(choice); };
      const escape = event => { if (event.key === "Escape" && !event.isComposing && topModal() === modal) { event.preventDefault(); event.stopImmediatePropagation(); done(null); } };
      for (const [icon, label, choice] of [["X", "取消", null], ["CloudDownload", "采用服务器布局", "server"], ["CopyPlus", "另存并切换", "fork"]]) {
        const el = button(icon, label, () => done(choice), "btn-sm"); el.append(document.createTextNode(label)); modal.querySelector(".modal-foot").append(el);
      }
      modal.addEventListener("click", event => { if (event.target === modal) done(null); });
      document.body.append(modal); document.addEventListener("keydown", escape, true); openLayer(modal);
      modal.querySelector("button").focus();
    });
  }

  async function saveCurrentLayout() {
    if (!initialized || splitPending || switching || applyingLayout || resolvingLayout || tokenPromptOpen) return;
    splitPending = true; renderScreens();
    try {
      if (!(await uiConfirm("保存当前布局副本？", "保留当前屏幕、分屏与排列，不采用服务器旧布局。副本保存成功后切换到它，同一 Token 下次打开将恢复此副本；现有终端任务不重启。"))) return;
      if (await resolveLayoutConflict({ keepLocal: true })) showToast("当前布局已保存，可安全刷新页面");
    } finally { splitPending = false; renderNavigation(); }
  }

  async function resolveLayoutConflict({ keepLocal = false } = {}) {
    if (resolvingLayout || tokenPromptOpen) return false;
    resolvingLayout = true;
    try {
      if (saving) await saving;
      if (checkpointSaving) await checkpointSaving;
      const target = device, version = changeVersion, local = packedSnapshot();
      const valid = () => target === device && target === deviceKey() && version === changeVersion;
      const backup = { layout: local, pending: true, baseRevision: view?.revision || 0, time: Date.now() };
      // Do not discard local changes if storage is unavailable.
      localStorage.setItem("cc_screens_conflict_" + target, JSON.stringify(backup));
      const saved = keepLocal ? null : await layoutRequest("/api/layouts/" + target);
      if (!valid()) throw new Error("页面布局已变化，请重新处理同步");
      if (!keepLocal && (saved.screenSchema !== 1 || !Array.isArray(saved.screens))) throw new Error("服务器布局不可用，保留本机状态");
      const remote = keepLocal ? null : screenSet(saved), base = layoutBase?.device === target ? layoutBase.layout : null;
      let value = keepLocal ? null : mergeLayouts(base, local, remote), next = saved, nextTarget = target, nextIdentity = identity;
      if (!value) {
        const choice = keepLocal ? "fork" : await chooseConflict();
        if (!choice) return false;
        if (!valid()) throw new Error("页面布局已变化，请重新处理同步");
        if (choice === "server") value = remote;
        else {
          nextIdentity = "copy_" + (typeof crypto.randomUUID === "function" ? crypto.randomUUID().replace(/-/g, "") : Date.now().toString(36) + Math.random().toString(36).slice(2));
          nextTarget = deviceKey("", nextIdentity); value = local;
          next = await layoutRequest("/api/layouts/" + nextTarget, { method: "PUT", body: JSON.stringify({ ...value, revision: 0 }) });
          if (!valid()) throw new Error("布局副本已保存，页面已变化，请从已保存布局中找回");
          if (tokenBinding) {
            const binding = tokenBinding;
            const result = await layoutRequest("/api/layout-binding/" + binding.kind, { method: "PUT", body: JSON.stringify({ device: nextTarget, revision: binding.revision }) });
            if (result.device !== nextTarget) throw new Error("副本已保存，但绑定未确认，请重新载入");
            tokenBinding = { ...result, kind: binding.kind };
          }
        }
      } else if (!sameLayout(value, remote)) {
        // One compare-and-swap only: another intervening edit must not be overwritten.
        next = await layoutRequest("/api/layouts/" + target, { method: "PUT", body: JSON.stringify({ ...value, revision: saved.revision }) });
      }
      if (!valid()) throw new Error("页面布局已变化，保留本机副本，请重新处理同步");
      if (!sameLayout(screenSet(next), value)) throw new Error("布局保存未确认，保留本机状态");
      if (nextTarget !== target) {
        saveTreeState(); layoutUser = ""; identity = nextIdentity; device = nextTarget;
        rememberLayoutBinding(); treeState = readTreeState(device); restoreTreeScroll = true;
      }
      view = next; rememberBase(next); conflict = false; dirty = false; layoutOffline = false;
      if (!sameLayout(packedSnapshot(), value)) {
        applyingLayout = true; installScreens(value); applyingLayout = false;
      }
      journal(packedSnapshot(), false); indicator("已同步"); renderNavigation();
      return true;
    } catch (error) {
      indicator("布局未保存 · 可重试同步或保存副本", true); notify(error); return false;
    } finally { resolvingLayout = false; applyingLayout = false; }
  }

  function snapshot() {
    return { panes: panes.map(p => p.tab?.id || p.savedId || null), active: active?.tab?.id || active?.savedId || null,
      direction: paneDirMode(), ratios: { cols: [...(gridFr.cols || [])], rows: [...(gridFr.rows || [])] },
      maximized: maximizedPane ? panes.indexOf(maximizedPane) : null };
  }

  function screenSet(value, mobile = device.startsWith("mobile_")) {
    const source = Array.isArray(value.screens) ? value.screens : [{ ...value, id: "screen1", name: "屏幕1" }];
    if (!source.length || source.length > 16) throw new Error("屏幕布局不可用");
    const ids = new Set();
    const list = source.map(screen => {
      if (!screen || typeof screen.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(screen.id) || ids.has(screen.id) ||
          typeof screen.name !== "string" || !screen.name.trim() || screen.name.length > 80 ||
          !Array.isArray(screen.panes) || screen.panes.length > MAX_PANES ||
          screen.panes.some(id => id !== null && typeof id !== "string") || new Set(screen.panes.filter(Boolean)).size !== screen.panes.filter(Boolean).length) throw new Error("屏幕布局不可用");
      ids.add(screen.id);
      const visible = mobile ? (screen.active && screen.panes.includes(screen.active) ? [screen.active] : screen.panes.slice(0, 1)) : [...screen.panes];
      return { id: screen.id, name: screen.name, panes: visible, active: visible.includes(screen.active) ? screen.active : visible.find(Boolean) || null,
        direction: ["row", "col"].includes(screen.direction) ? screen.direction : "auto", ratios: screen.ratios || {},
        maximized: Number.isInteger(screen.maximized) && screen.maximized >= 0 && screen.maximized < visible.length ? screen.maximized : null };
    });
    const selected = list.find(screen => screen.id === value.activeScreen) || list[0];
    // The visible screen owns its sessions; older duplicates keep their first owner.
    const seen = new Set();
    for (const screen of [selected, ...list.filter(item => item !== selected)]) {
      const indexes = [];
      screen.panes.forEach((id, index) => {
        if (!id || !seen.has(id)) { indexes.push(index); if (id) seen.add(id); }
      });
      if (indexes.length === screen.panes.length) continue;
      screen.panes = indexes.map(index => screen.panes[index]);
      if (!screen.panes.includes(screen.active)) screen.active = screen.panes.find(Boolean) || null;
      const maximized = indexes.indexOf(screen.maximized);
      screen.maximized = maximized < 0 ? null : maximized;
      screen.ratios = {};
    }
    return { ...selected, screens: list, activeScreen: selected.id, screenSchema: 1 };
  }

  function packedSnapshot() {
    const selected = screens.find(screen => screen.id === activeScreen);
    if (selected) Object.assign(selected, snapshot());
    const value = screenSet({ screens: screens.length ? screens : [{ ...snapshot(), id: "screen1", name: "屏幕1" }], activeScreen });
    screens = value.screens;
    return value;
  }

  function journal(value, pending, target = device, revision = view?.revision || 0) {
    const prior = pending && changeVersion === 0 ? readJournal(target) : null;
    const stamp = prior?.pending && prior.baseRevision === revision ? { writer: prior.writer, sequence: prior.sequence } : { writer, sequence: changeVersion };
    const base = layoutBase?.device === target && layoutBase.revision === revision ? layoutBase.layout : prior?.base;
    try { localStorage.setItem("cc_screens_recovery_" + target, JSON.stringify({ layout: value, base, pending, baseRevision: revision, ...stamp, time: Date.now() })); }
    catch (_) { indicator("本机备份不可用", true); }
  }

  function readJournal(target) {
    try {
      const data = JSON.parse(localStorage.getItem("cc_screens_recovery_" + target) || "null");
      if (data && Number.isInteger(data.baseRevision) && data.baseRevision >= 0) return { ...data, layout: screenSet(data.layout, target.startsWith("mobile_")) };
    } catch (_) {}
    return null;
  }

  function installScreens(value) {
    const next = screenSet(value);
    screens = next.screens; activeScreen = next.activeScreen;
    reconcilePanes(next);
    renderScreens();
  }

  function renderScreens() {
    const tabs = $("ws-screen-tabs"), existing = new Map([...tabs.children].map(el => [el.dataset.screen, el]));
    const focused = tabs.contains(document.activeElement) ? document.activeElement : null;
    let index = 0;
    for (const screen of screens) {
      let el = existing.get(screen.id);
      if (!el) {
        el = document.createElement("button"); el.type = "button"; el.dataset.screen = screen.id;
        el.setAttribute("role", "tab"); el.onclick = () => { if (performance.now() >= suppressScreenClickUntil) switchScreen(screen.id); };
        el.ondblclick = () => renameScreen(screen.id); el.setAttribute("aria-keyshortcuts", "F2 Control+Shift+ArrowLeft Control+Shift+ArrowRight");
        el.oncontextmenu = event => { event.preventDefault(); openScreenOrder(screen.id); };
        addScreenReorderTarget(el, screen.id);
        addScreenDropTarget(el, screen.id);
        el.innerHTML = '<span class="ws-screen-name"></span><small></small>';
        tabs.append(el);
      }
      el.querySelector("span").textContent = screen.name;
      el.querySelector("small").textContent = screen.panes.filter(Boolean).length + " / " + (mqMobile.matches ? 1 : MAX_PANES);
      el.setAttribute("aria-selected", String(screen.id === activeScreen));
      el.tabIndex = screen.id === activeScreen ? 0 : -1;
      el.title = screen.name + " · 拖动排序 · 双击重命名"; el.disabled = switching || splitPending || navigationPending || !initialized;
      el.draggable = !mqMobile.matches && !screenOrderBlocked();
      if (tabs.children[index] !== el) tabs.insertBefore(el, tabs.children[index] || null);
      index++;
      existing.delete(screen.id);
    }
    for (const el of existing.values()) el.remove();
    if (focused?.isConnected && !focused.disabled && document.activeElement !== focused) focused.focus({ preventScroll: true });
    const tools = [...$("ws-screen-tools").children], busy = switching || splitPending || navigationPending || !initialized;
    tools.forEach(el => { el.disabled = busy; });
    addScreenButton.disabled = busy || screens.length >= 16;
    tools[1].disabled ||= screens.length <= 1;
    orderScreenButton.disabled ||= screens.length <= 1 || screenOrderBlocked();
    $("ws-layout-user").disabled = busy;
    $("ws-layout-user").innerHTML = uiIcon("UserRound") + '<span>' + esc(layoutUser || (tokenBinding ? "Token 布局" : "本机")) + '</span>';
    $("ws-layout-user").title = tokenBinding ? "此访问 Token 的布局 · 电脑与手机分别保存" : "布局用户 · " + (layoutUser || "仅本机");
    $("ws-user-local").textContent = tokenBinding ? "使用默认布局" : "仅使用本机布局";
    $("ws-layout-user").setAttribute("aria-label", "绑定布局用户");
    screenBar.classList.toggle("unsaved", conflict);
    for (const pane of panes) {
      paneCreated(pane);
      pane.el.querySelector(".ws-pane-move").disabled = busy || conflict || !(pane.tab?.id || pane.savedId);
    }
    moveModal.querySelectorAll("button").forEach(el => {
      el.disabled = busy || (el.hasAttribute("data-move-screen") && (conflict || !!moveBlockedReason(moveContext, el.dataset.moveScreen || null)));
    });
    if (!orderModal.classList.contains("hidden")) renderScreenOrder();
  }

  async function editScreens(edit, { reconcile = true, localNavigation = false } = {}) {
    if (!initialized || switching || applyingLayout || splitPending || navigationPending || openingTab || sessionLaunchBusy || device !== deviceKey()) return false;
    const originalDevice = device;
    splitPending = true; renderNavigation();
    try {
      let synchronized = await persist();
      if (!synchronized && !localNavigation && conflict) {
        synchronized = await resolveLayoutConflict();
        if (!synchronized) return false;
      }
      if (device !== originalDevice) { showToast("已另存并切换布局，请重新执行当前操作"); return false; }
      if (device !== deviceKey()) return false;
      // A conflicting layout must not be overwritten, but its existing screens
      // remain usable. Only screen selection can continue in the local journal.
      if (!synchronized && !(localNavigation && conflict && !tokenPromptOpen)) {
        showToast("布局尚未同步，请先使用“重新载入屏幕布局”处理后再修改");
        return false;
      }
      packedSnapshot();
      if (!edit()) return false;
      if (reconcile) {
        applyingLayout = true;
        reconcilePanes(screens.find(screen => screen.id === activeScreen));
        applyingLayout = false;
      }
      layoutChanged();
      let saved = await persist();
      if (!saved && !localNavigation && conflict) saved = await resolveLayoutConflict();
      if (!saved && localNavigation) showToast("已在本机切换屏幕；布局尚未同步，未覆盖服务器布局");
      if (reconcile) {
        $("ws-screen-tabs").querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
        if (activeScreen === screens[screens.length - 1]?.id) addScreenButton.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      return saved;
    } catch (error) { notify(error); return false; }
    finally { applyingLayout = false; splitPending = false; renderNavigation(); if (device !== deviceKey()) await restoreDeviceLayout(); syncTerminalContinuity(); }
  }

  async function switchScreen(id) {
    if (!screens.some(screen => screen.id === id)) return;
    if (id === activeScreen) { window.ccUnread?.enter(active); return; }
    const saved = await editScreens(() => { activeScreen = id; return true; }, { localNavigation: true });
    if (activeScreen === id) window.ccUnread?.enter(active);
    return saved;
  }

  function screenOrderBlocked() {
    return !initialized || switching || applyingLayout || splitPending || navigationPending || openingTab || sessionLaunchBusy || conflict || tokenPromptOpen || device !== deviceKey();
  }

  function screenOrderContext(id) {
    return { id, device, order: screens.map(screen => screen.id).join(",") };
  }

  function validScreenOrder(context) {
    return context && context.device === device && device === deviceKey() && context.order === screens.map(screen => screen.id).join(",");
  }

  async function reorderScreen(context, targetId, after = false) {
    if (screenOrderBlocked() || !validScreenOrder(context) || context.id === targetId) return false;
    const next = screens.map(screen => screen.id).filter(id => id !== context.id), target = next.indexOf(targetId);
    if (target < 0 || !screens.some(screen => screen.id === context.id)) return false;
    next.splice(target + Number(after), 0, context.id);
    if (next.join(",") === context.order) return false;
    const origin = document.activeElement;
    let moved = false;
    const saved = await editScreens(() => {
      if (!validScreenOrder(context)) return false;
      const byId = new Map(screens.map(screen => [screen.id, screen]));
      screens = next.map(id => byId.get(id)); moved = true;
      return true;
    }, { reconcile: false });
    if (moved && context.device === device) {
      const tab = [...$("ws-screen-tabs").children].find(el => el.dataset.screen === context.id);
      tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (topModal() === orderModal && !orderModal.classList.contains("is-closing")) {
        const row = [...$("ws-order-list").children].find(el => el.dataset.screenOrder === context.id);
        const focus = origin?.isConnected && !origin.disabled ? origin : row?.querySelector("button:not(:disabled)");
        focus?.focus({ preventScroll: true });
        row?.scrollIntoView({ block: "nearest" });
        $("ws-order-state").textContent = saved ? "已保存" : "顺序仅保存在本机，尚未同步";
      } else if (origin?.isConnected && origin.matches('#ws-screen-tabs > button') && !origin.disabled && document.activeElement === document.body) {
        origin.focus({ preventScroll: true });
      }
    }
    return saved;
  }

  function shiftScreen(id, step) {
    if (screenOrderBlocked()) return Promise.resolve(false);
    const index = screens.findIndex(screen => screen.id === id), target = screens[index + step];
    if (index < 0 || !target) return Promise.resolve(false);
    return reorderScreen(screenOrderContext(id), target.id, step > 0);
  }

  function openScreenOrder(targetId = activeScreen) {
    if (screenOrderBlocked() || screens.length < 2) return;
    if (typeof targetId !== "string") targetId = activeScreen;
    orderDevice = device;
    renderScreenOrder(); openLayer(orderModal, true);
    const row = [...$("ws-order-list").children].find(el => el.dataset.screenOrder === targetId);
    (row?.querySelector("button:not(:disabled)") || $("ws-order-close").querySelector("button"))?.focus();
  }

  function renderScreenOrder() {
    const list = $("ws-order-list"), existing = new Map([...list.children].map(el => [el.dataset.screenOrder, el]));
    const blocked = screenOrderBlocked() || orderDevice !== device;
    screens.forEach((screen, index) => {
      let row = existing.get(screen.id);
      if (!row) {
        row = document.createElement("li"); row.className = "ws-order-row"; row.dataset.screenOrder = screen.id;
        row.innerHTML = '<span class="ws-order-index" aria-hidden="true"></span><span class="ws-order-name"></span>';
        for (const [step, icon, label] of [[-1, "ArrowUp", "前移"], [1, "ArrowDown", "后移"]]) {
          const el = button(icon, label, () => { if (orderDevice === device) shiftScreen(screen.id, step); });
          el.dataset.step = step; row.append(el);
        }
      }
      row.querySelector(".ws-order-index").textContent = index + 1;
      row.querySelector(".ws-order-name").textContent = screen.name;
      row.querySelector(".ws-order-name").title = screen.name;
      row.classList.toggle("current", screen.id === activeScreen);
      row.querySelector('[data-step="-1"]').disabled = blocked || index === 0;
      row.querySelector('[data-step="1"]').disabled = blocked || index === screens.length - 1;
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
      existing.delete(screen.id);
    });
    for (const row of existing.values()) row.remove();
    $("ws-order-state").textContent = conflict ? "顺序未同步，请检查布局保存状态" : splitPending || saving ? "保存中" : "";
  }

  function clearTabDrag() {
    if (tabDrag) suppressScreenClickUntil = performance.now() + 200;
    tabDrag = null;
    screenBar.querySelectorAll(".ws-tab-dragging,.ws-order-before,.ws-order-after").forEach(el => el.classList.remove("ws-tab-dragging", "ws-order-before", "ws-order-after"));
  }

  function screenDropAfter(context, id) {
    return screens.findIndex(screen => screen.id === context.id) < screens.findIndex(screen => screen.id === id);
  }

  function addScreenReorderTarget(el, id) {
    el.addEventListener("dragstart", event => {
      if (screenOrderBlocked() || mqMobile.matches || !event.dataTransfer) { event.preventDefault(); return; }
      event.stopPropagation(); clearTabDrag();
      tabDrag = screenOrderContext(id);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-cc-screen", id);
      el.classList.add("ws-tab-dragging");
    });
    el.addEventListener("dragover", event => {
      if (!tabDrag || !event.dataTransfer) return;
      event.preventDefault();
      const allowed = !screenOrderBlocked() && validScreenOrder(tabDrag) && tabDrag.id !== id;
      event.dataTransfer.dropEffect = allowed ? "move" : "none";
      screenBar.querySelectorAll(".ws-order-before,.ws-order-after").forEach(node => node.classList.remove("ws-order-before", "ws-order-after"));
      if (allowed) {
        el.classList.add(screenDropAfter(tabDrag, id) ? "ws-order-after" : "ws-order-before");
      }
    });
    el.addEventListener("dragleave", event => {
      if (!event.relatedTarget || !el.contains(event.relatedTarget)) el.classList.remove("ws-order-before", "ws-order-after");
    });
    el.addEventListener("drop", event => {
      if (!tabDrag) return;
      event.preventDefault(); event.stopPropagation();
      const context = tabDrag, after = screenDropAfter(context, id);
      clearTabDrag(); reorderScreen(context, id, after);
    });
  }

  function appendScreen() {
    let number = 1;
    while (screens.some(screen => screen.name === "屏幕" + number)) number++;
    const id = "screen_" + (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    const screen = { id, name: "屏幕" + number, panes: [], active: null, direction: "auto", ratios: {}, maximized: null };
    screens.push(screen); return screen;
  }

  function createScreen() {
    return editScreens(() => {
      if (screens.length >= 16) return false;
      activeScreen = appendScreen().id; return true;
    });
  }

  function paneCreated(pane) {
    if (pane.el.querySelector(".ws-pane-move")) return;
    const el = button("MoveRight", "移到其他屏幕", event => { event.stopPropagation(); openMovePicker(pane); }, "ws-icon ws-pane-move");
    for (const type of ["mousedown", "touchstart"]) el.addEventListener(type, event => event.stopPropagation());
    el.addEventListener("dragstart", event => { event.preventDefault(); event.stopPropagation(); });
    pane.el.querySelector(".pane-expand").after(el);
    pane.el.querySelector(".pane-bar").title = "拖到其他窗格交换位置，或拖到屏幕标签移动";
  }

  function paneMoveContext(pane) {
    const sid = pane?.tab?.id || pane?.savedId;
    return sid && panes.includes(pane) ? { pane, sid, source: activeScreen, device } : null;
  }

  function moveBlockedReason(context, targetId) {
    if (!context || context.device !== device || device !== deviceKey() || context.source !== activeScreen ||
        !panes.includes(context.pane) || (context.pane.tab?.id || context.pane.savedId) !== context.sid) return "窗口或屏幕已变化，请重新选择";
    if (targetId === context.source) return "当前屏幕";
    if (targetId === null) return screens.length >= 16 ? "最多16个屏幕" : "";
    const target = screens.find(screen => screen.id === targetId);
    if (!target) return "目标屏幕已移除";
    const limit = mqMobile.matches ? 1 : MAX_PANES;
    return !target.panes.includes(context.sid) && !target.panes.includes(null) && target.panes.length >= limit ? "目标屏幕已满（最多" + limit + "个窗口）" : "";
  }

  function openMovePicker(pane = active) {
    if (!initialized || switching || applyingLayout || splitPending || navigationPending || openingTab || sessionLaunchBusy || conflict || device !== deviceKey()) return;
    moveContext = paneMoveContext(pane);
    if (!moveContext) { showToast("请选择一个终端窗口"); return; }
    $("ws-move-session").textContent = (pane.tab ? displayName(pane.tab) : pane.savedId) + " · " + (screens.find(screen => screen.id === activeScreen)?.name || "");
    $("ws-move-list").replaceChildren(); $("ws-move-state").textContent = "";
    for (const target of [...screens.filter(screen => screen.id !== activeScreen), null]) {
      const context = moveContext, id = target?.id || null, reason = moveBlockedReason(context, id);
      const row = button(target ? "PanelsTopLeft" : "Plus", target ? "移到「" + target.name + "」" : "新建屏幕并移入", () => movePaneToScreen(context, id), "ws-row");
      row.dataset.moveScreen = id || ""; row.disabled = !!reason;
      const name = document.createElement("span"), detail = document.createElement("small");
      name.textContent = target?.name || "新建屏幕并移入";
      detail.textContent = reason || (target?.panes.includes(context.sid) ? "已包含此窗口" : target ? target.panes.filter(Boolean).length + " / " + (mqMobile.matches ? 1 : MAX_PANES) : "");
      row.append(name, detail); $("ws-move-list").append(row);
    }
    openLayer(moveModal, true);
    $("ws-move-list").querySelector("button:not(:disabled)")?.focus();
  }

  async function movePaneToScreen(context, targetId) {
    let moved = false, name = "";
    const saved = await editScreens(() => {
      const reason = moveBlockedReason(context, targetId);
      if (reason) throw new Error(reason);
      const source = screens.find(screen => screen.id === context.source), index = source?.panes.indexOf(context.sid) ?? -1;
      if (index < 0) throw new Error("原窗口已变化，请重新选择");
      const target = targetId === null ? appendScreen() : screens.find(screen => screen.id === targetId);
      // Update both screens in the same revision, then reuse the moved live pane.
      source.panes.splice(index, 1);
      if (source.active === context.sid) source.active = source.panes[Math.min(index, source.panes.length - 1)] || null;
      if (Number.isInteger(source.maximized)) source.maximized = source.maximized === index ? null : source.maximized - Number(source.maximized > index);
      source.ratios = {};
      if (!target.panes.includes(context.sid)) {
        const empty = target.panes.indexOf(null);
        if (empty >= 0) target.panes[empty] = context.sid;
        else { target.panes.push(context.sid); target.ratios = {}; }
      }
      target.active = context.sid; target.maximized = null;
      activeScreen = target.id; name = target.name; moved = true;
      return true;
    });
    if (moved) {
      closeLayer(moveModal);
      showToast(saved ? "已移到「" + name + "」" : "已在本机移动，布局未同步，请重新载入前检查保存状态");
    } else if (!moveModal.classList.contains("hidden")) {
      $("ws-move-state").textContent = conflict ? "布局未同步，请先重新载入" : "未移动，请重新选择窗口或目标屏幕";
    }
  }

  function clearScreenDrag() {
    screenDrag = null;
    screenBar.querySelectorAll(".ws-drop-target,.ws-drop-blocked").forEach(el => el.classList.remove("ws-drop-target", "ws-drop-blocked"));
  }

  function addScreenDropTarget(el, targetId) {
    el.addEventListener("dragover", event => {
      if (!screenDrag || dragSrcPane !== screenDrag.pane) return;
      event.preventDefault();
      const blocked = switching || applyingLayout || splitPending || navigationPending || conflict || !!moveBlockedReason(screenDrag, targetId);
      event.dataTransfer.dropEffect = blocked ? "none" : "move";
      el.classList.toggle("ws-drop-target", !blocked); el.classList.toggle("ws-drop-blocked", !!blocked);
    });
    el.addEventListener("dragleave", event => {
      if (!event.relatedTarget || !el.contains(event.relatedTarget)) el.classList.remove("ws-drop-target", "ws-drop-blocked");
    });
    el.addEventListener("drop", event => {
      if (!screenDrag || dragSrcPane !== screenDrag.pane) return;
      event.preventDefault(); event.stopPropagation();
      const context = screenDrag;
      clearScreenDrag(); dragSrcPane = null; context.pane.el.classList.remove("dragging");
      movePaneToScreen(context, targetId);
    });
  }

  let renamingScreen = false;
  async function renameScreen(targetId) {
    if (renamingScreen || !initialized || switching || splitPending || applyingLayout || navigationPending) return;
    const id = typeof targetId === "string" ? targetId : activeScreen, selected = screens.find(screen => screen.id === id), targetDevice = device;
    if (!selected) return;
    renamingScreen = true;
    try {
      const name = await uiPrompt("重命名屏幕", selected.name);
      if (!name?.trim() || name.trim() === selected.name) return;
      if (name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(name)) { showToast("屏幕名称最多80个字符，不能包含控制字符"); return; }
      if (targetDevice !== device || targetDevice !== deviceKey()) { showToast("布局已切换，请重新选择屏幕"); return; }
      return await editScreens(() => {
        const screen = screens.find(item => item.id === id);
        if (!screen || targetDevice !== device || targetDevice !== deviceKey()) return false;
        screen.name = name.trim(); return true;
      });
    } finally { renamingScreen = false; }
  }

  async function deleteScreen() {
    const id = activeScreen, selected = screens.find(screen => screen.id === id);
    if (screens.length <= 1 || !selected || !(await uiConfirm("删除「" + selected.name + "」？", "仅删除此屏幕布局，不停止任何终端任务。", true))) return;
    return editScreens(() => {
      if (screens.length <= 1) return false;
      const index = screens.findIndex(screen => screen.id === id);
      if (index < 0) return false;
      screens.splice(index, 1);
      if (activeScreen === id) activeScreen = screens[Math.min(index, screens.length - 1)].id;
      return true;
    });
  }

  async function reloadScreens() {
    if (splitPending || switching) return;
    if (saving) await saving;
    if (checkpointSaving) await checkpointSaving;
    if ((dirty || conflict) && !(await uiConfirm("重新载入服务器布局？", "本机未同步的布局会保留为冲突副本，但不会覆盖服务器版本。"))) return;
    const local = readJournal(device);
    if (local?.pending) {
      try { localStorage.setItem("cc_screens_conflict_" + device, JSON.stringify(local)); localStorage.removeItem("cc_screens_recovery_" + device); } catch (_) {}
    }
    await restoreDeviceLayout();
  }

  function openLayoutUser() {
    if (switching || applyingLayout || splitPending || navigationPending || openingTab || sessionLaunchBusy || !initialized) return;
    $("ws-user-input").value = layoutUser;
    $("ws-user-state").textContent = "";
    layoutCatalog.classList.add("hidden");
    $("ws-user-local").disabled = !layoutUser;
    openLayer(userModal);
    setTimeout(() => $("ws-user-input").focus(), 20);
  }

  async function copyLayoutLink() {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set("ui", "bridge");
    url.searchParams.set(layoutUser ? "layoutUser" : "layoutDevice", layoutUser || identity);
    if (tokenBinding) url.searchParams.set("restoreLayout", "1");
    try { showToast(await copyText(url.href) ? "已复制恢复链接（仍需网页访问凭据）" : "复制失败，请检查浏览器剪贴板权限"); }
    catch (_) { showToast("复制失败，请检查浏览器剪贴板权限"); }
  }

  async function loadSavedLayouts() {
    const targetDevice = device;
    $("ws-layout-history").disabled = true; $("ws-user-state").textContent = "读取已保存布局";
    try {
      const kind = mqMobile.matches ? "mobile" : "desktop";
      const data = await layoutRequest("/api/layouts?kind=" + kind);
      if (targetDevice !== device || targetDevice !== deviceKey()) return;
      if (!Array.isArray(data.layouts)) throw new Error("后台尚未支持布局查找，请刷新后重试");
      layoutCatalog.replaceChildren(); layoutCatalog.classList.remove("hidden");
      for (const item of data.layouts) {
        if (typeof item.device !== "string" || !item.device.startsWith(kind + "_")) continue;
        const suffix = item.device.slice(kind.length + 1), user = suffix.startsWith("user_") ? suffix.slice(5) : "", id = user ? identity : suffix;
        if ((user && !validUser(user)) || !validIdentity(id)) continue;
        const row = button("PanelsTopLeft", "恢复此布局", () => bindLayoutUser(user, id, true), "ws-row");
        row.dataset.layout = item.device; row.disabled = item.device === device;
        const label = document.createElement("span"), detail = document.createElement("small");
        label.textContent = (user ? user + " · " : "") + (item.screenNames || []).join(" / ");
        detail.textContent = item.device === device ? "当前布局" : item.screenCount + "屏 · " + item.paneCount + "窗";
        row.append(label, detail); layoutCatalog.append(row);
      }
      $("ws-user-state").textContent = data.layouts.length ? "选择后恢复，不覆盖原档案" : "没有已保存布局";
    } catch (error) { $("ws-user-state").textContent = error.message; }
    finally { $("ws-layout-history").disabled = splitPending; }
  }

  async function bindLayoutUser(user, targetIdentity = identity, existingOnly = false) {
    if (splitPending || switching || applyingLayout || navigationPending || openingTab || sessionLaunchBusy || !initialized || (user && !validUser(user)) || !validIdentity(targetIdentity)) return;
    if (user === layoutUser && targetIdentity === identity) { closeLayer(userModal); return; }
    splitPending = true; renderNavigation();
    userModal.querySelectorAll("input,button").forEach(el => { el.disabled = true; });
    $("ws-user-state").textContent = "读取布局中";
    try {
      if (!(await persist())) throw new Error("当前布局未同步，请先重新载入或重试");
      const target = deviceKey(user, targetIdentity), saved = await layoutRequest("/api/layouts/" + target), recovery = readJournal(target);
      if (saved.screenSchema !== 1) throw new Error("后台尚不支持多屏，请更新后台后重试");
      if (existingOnly && !saved.revision) throw new Error("此布局已不存在，请重新读取列表");
      let value = screenSet(saved, target.startsWith("mobile_")), next = saved, pending = false;
      if (recovery?.pending) {
        if (recovery.baseRevision !== saved.revision && JSON.stringify(recovery.layout) !== JSON.stringify(value)) throw new Error("此用户在本机有未同步布局，请先在原标签页处理保存冲突");
        value = recovery.layout; pending = true;
      } else if (!saved.revision) {
        value = packedSnapshot();
        if (user && target.startsWith("mobile_")) {
          const desktop = await layoutRequest("/api/layouts/desktop_user_" + user);
          if (desktop.revision) value = screenSet(desktop, true);
        }
      }
      if (!saved.revision || pending) {
        next = await layoutRequest("/api/layouts/" + target, { method: "PUT", body: JSON.stringify({ ...value, revision: saved.revision }) });
        if (!Array.isArray(next.screens)) throw new Error("后台尚不支持多屏，请更新后台后重试");
      }
      if (target !== deviceKey(user, targetIdentity)) throw new Error("设备显示模式已变化，请重新绑定");
      if (tokenBinding) {
        const binding = tokenBinding;
        const result = await layoutRequest("/api/layout-binding/" + binding.kind, { method: "PUT", body: JSON.stringify({ device: target, revision: binding.revision }) });
        if (result.device !== target) throw new Error("布局绑定未确认，请重新载入");
        tokenBinding = { ...result, kind: binding.kind };
        if (target !== deviceKey(user, targetIdentity)) throw new Error("设备显示模式已变化，请重新载入");
      }
      // Commit the binding only after the target was read/created successfully.
      saveTreeState(); layoutUser = user; identity = targetIdentity; device = target; view = next; dirty = false; conflict = false; layoutOffline = false;
      rememberBase(next, target);
      rememberLayoutBinding();
      treeState = readTreeState(target); restoreTreeScroll = true;
      applyingLayout = true; installScreens(value); applyingLayout = false;
      journal(packedSnapshot(), false); indicator("已保存"); renderNavigation(); closeLayer(userModal);
    } catch (error) { $("ws-user-state").textContent = error.message; }
    finally {
      applyingLayout = false; splitPending = false;
      userModal.querySelectorAll("input,button").forEach(el => { el.disabled = false; });
      $("ws-user-local").disabled = !layoutUser;
      renderNavigation();
      if (device !== deviceKey()) await restoreDeviceLayout();
    }
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
      const ids = [...new Set(data.layout.panes)].filter(id => state.tabs.some(tab => tab.id === id));
      return ids.length > 1 ? { ...data.layout, panes: ids.slice(0, MAX_PANES) } : null;
    } catch (_) { return null; }
  }

  function openSplitPicker() {
    if (!initialized || navigationPending || switching || applyingLayout || splitPending || device !== deviceKey()) return;
    splitSelection = panes.map(p => p.tab?.id || p.savedId).filter(id => state.tabs.some(tab => tab.id === id)).slice(0, mqMobile.matches ? 1 : MAX_PANES);
    splitDirection = paneDirMode(); $("ws-split-search").value = "";
    $("ws-split-backup").replaceChildren();
    const backup = readSplitBackup();
    if (backup && !mqMobile.matches) $("ws-split-backup").append(button("History", "选择上次多窗分屏", () => { splitSelection = backup.panes; splitDirection = backup.direction || "auto"; renderSplitPicker(); }));
    renderSplitPicker(); openLayer(splitModal, true);
  }

  function createSplitTerminal() {
    if (!initialized || navigationPending || switching || applyingLayout || splitPending || sessionLaunchBusy || device !== deviceKey()) return;
    const targetDevice = device, selected = [...splitSelection], direction = splitDirection, query = $("ws-split-search").value;
    const cwd = active?.tab?.cwd || current?.cwd || state.defaultDir;
    const restorePicker = tab => {
      if (targetDevice !== deviceKey() || device !== targetDevice) {
        if (tab) showToast("终端已创建，请在当前布局重新选择");
        return;
      }
      splitSelection = selected.filter(id => state.tabs.some(item => item.id === id));
      const limit = mqMobile.matches ? 1 : MAX_PANES;
      if (tab && splitSelection.length < limit) splitSelection.push(tab.id);
      splitDirection = direction; $("ws-split-search").value = tab ? "" : query;
      renderSplitPicker(); openLayer(splitModal, true);
      if (tab && !splitSelection.includes(tab.id)) showToast("终端已创建，分屏已满，请先取消一个选择");
      requestAnimationFrame(() => $(tab ? "ws-split-apply" : "ws-split-create").focus());
    };
    closeLayer(splitModal, () => openDirModal({ cwd, onCreated: restorePicker, onCancel: () => restorePicker() }));
  }

  function renderSplitPicker() {
    const query = $("ws-split-search").value.trim().toLowerCase(), limit = mqMobile.matches ? 1 : MAX_PANES;
    splitSelection = splitSelection.filter(id => state.tabs.some(tab => tab.id === id)).slice(0, limit);
    $("ws-split-list").replaceChildren();
    const tabs = state.tabs.filter(tab => (displayName(tab) + " " + tab.cwd).toLowerCase().includes(query));
    const openedHere = new Set(panes.map(pane => pane.tab?.id || pane.savedId).filter(Boolean));
    for (const tab of tabs.sort((a, b) => Number(b.alive) - Number(a.alive) || Number(splitSelection.includes(b.id)) - Number(splitSelection.includes(a.id)))) {
      const row = document.createElement("label"); row.className = "ws-split-row";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.dataset.session = tab.id;
      checkbox.checked = splitSelection.includes(tab.id);
      checkbox.setAttribute("aria-label", displayName(tab));
      checkbox.onchange = () => {
        if (checkbox.checked && splitSelection.length >= limit) { checkbox.checked = false; $("ws-split-state").textContent = "最多 " + limit + " 个终端"; return; }
        splitSelection = checkbox.checked ? [...splitSelection, tab.id] : splitSelection.filter(id => id !== tab.id);
        updateSplitCounter();
      };
      row.append(checkbox);
      const description = document.createElement("span"); description.className = "ws-split-name";
      description.innerHTML = '<b>' + esc(displayName(tab)) + '</b><small>' + esc(typeLabel(tab.type)) + ' · ' + esc(tab.cwd || "") + '</small>';
      const elsewhere = screens.filter(screen => screen.id !== activeScreen && screen.panes.includes(tab.id)).map(screen => screen.name);
      const opened = document.createElement("small"); opened.className = "ws-split-open";
      row.dataset.openState = openedHere.has(tab.id) ? "current" : elsewhere.length ? "other" : "closed";
      opened.textContent = openedHere.has(tab.id) ? "当前屏幕已打开" : elsewhere.length ? "其他屏幕已打开" : "未打开";
      if (elsewhere.length) opened.textContent += " · " + elsewhere.slice(0, 2).join("、") + (elsewhere.length > 2 ? " 等" + elsewhere.length + "屏" : "");
      opened.title = elsewhere.join("、");
      opened.id = "ws-split-open-" + $("ws-split-list").children.length;
      checkbox.setAttribute("aria-describedby", opened.id);
      description.append(opened);
      row.append(description);
      const status = document.createElement("small"); status.textContent = tab.alive ? "在线" : "已停止"; row.append(status);
      $("ws-split-list").append(row);
    }
    if (!tabs.length) {
      const empty = document.createElement("div"); empty.className = "ws-split-empty"; empty.textContent = "没有匹配的终端";
      $("ws-split-list").append(empty);
    }
    for (const el of $("ws-split-directions").children) el.setAttribute("aria-pressed", String(el.dataset.direction === splitDirection));
    updateSplitCounter();
  }

  function updateSplitCounter() {
    const moved = splitSelection.filter(id => screens.some(screen => screen.id !== activeScreen && screen.panes.includes(id))).length;
    $("ws-split-state").textContent = splitSelection.length + " / " + (mqMobile.matches ? 1 : MAX_PANES) + (moved ? " · 移入 " + moved + " 个" : "");
    $("ws-split-apply").querySelector("span").textContent = moved ? "移入并分屏" : "分屏显示";
    $("ws-split-apply").disabled = !splitSelection.length;
  }

  async function openTreeSession(id) {
    if (navigationPending || splitPending || switching || applyingLayout) return;
    const tab = state.tabs.find(item => item.id === id);
    if (!tab) return;
    navigationPending = true; renderNavigation();
    try {
      await openTab(tab);
      if (active?.tab?.id === id) window.ccUnread?.enter(active);
    }
    catch (error) { notify(error); }
    finally { navigationPending = false; renderNavigation(); }
  }

  async function addSessionSplit(id, replacePane = null) {
    if (!initialized || navigationPending || splitPending || switching || applyingLayout || device !== deviceKey()) return;
    const tab = state.tabs.find(item => item.id === id);
    if (!tab?.alive) { showToast("终端已停止，请先启动"); return; }
    const existing = paneOfTab(id);
    if (existing?.term) { focusPane(existing, !COARSE); return; }
    if (existing) { await openTreeSession(id); return; }
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
      interacted(id);
      layoutChanged();
      if (await persist()) closeLayer(replaceModal);
    } catch (error) { notify(error); }
    finally {
      applyingLayout = false; splitPending = false; renderNavigation();
      replaceModal.querySelectorAll("button").forEach(el => { el.disabled = false; });
      if (device !== deviceKey()) await restoreDeviceLayout();
    }
  }

  function idOpenContext() {
    return { device, screen: activeScreen, panes: snapshot().panes, screens: screens.length,
      limit: mqMobile.matches ? 1 : MAX_PANES,
      locations: screens.map(screen => ({ id: screen.id, name: screen.name, panes: [...screen.panes] })) };
  }

  async function openById(body, destination, context) {
    if (!initialized || navigationPending || splitPending || switching || applyingLayout || openingTab || sessionLaunchBusy || conflict) {
      throw new Error("布局正在处理其他操作，请稍后重新查找");
    }
    const check = () => {
      if (context.device !== device || device !== deviceKey() || context.screen !== activeScreen) throw new Error("屏幕或布局用户已变化，请重新查找");
      if (!["current", "new"].includes(destination)) throw new Error("请选择目标屏幕");
      if (destination === "new" && screens.length >= 16) throw new Error("屏幕已达上限，请使用已有屏幕");
      const ids = snapshot().panes.filter(Boolean), limit = mqMobile.matches ? 1 : MAX_PANES;
      if (destination === "current" && !ids.includes(body.id) && ids.length >= limit) throw new Error("当前屏幕已满，请选择新屏幕");
    };
    check(); splitPending = true; renderNavigation();
    try {
      if (!(await persist())) throw new Error("当前布局未保存，尚未打开会话，请先处理布局冲突");
      check();
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000);
      let tab;
      try { tab = await api("/api/session-lookup/open", { method: "POST", body: JSON.stringify(body), signal: controller.signal }, 0); }
      finally { clearTimeout(timer); }
      if (!tab?.id || !tab.alive) throw new Error("尚未确认窗口已打开，请重新查找；不会自动重试");
      // Ignore a session-list response issued before the explicit open completed.
      ++tabsLoadSeq;
      const index = state.tabs.findIndex(item => item.id === tab.id);
      if (index < 0) state.tabs.push(tab); else state.tabs[index] = tab;
      check(); packedSnapshot();
      const next = destination === "new" ? appendScreen() : screens.find(screen => screen.id === activeScreen);
      activeScreen = next.id;
      if (!next.panes.includes(tab.id)) {
        const empty = next.panes.indexOf(null);
        if (empty >= 0) next.panes[empty] = tab.id; else next.panes.push(tab.id);
      }
      next.active = tab.id; next.maximized = null;
      applyingLayout = true; reconcilePanes(next); applyingLayout = false;
      interacted(tab.id); layoutChanged();
      if (!(await persist())) throw new Error("窗口已打开，但布局尚未同步；请保留当前页面并处理布局冲突");
      revealActiveSession();
      return tab;
    } finally {
      applyingLayout = false; splitPending = false; renderNavigation();
      await loadTabs();
      if (device !== deviceKey()) await restoreDeviceLayout();
    }
  }

  function reconcilePanes(value) {
    const ids = value.panes.slice(0, mqMobile.matches ? 1 : MAX_PANES);
    const existing = [...panes], used = new Set(), wanted = ids.map(id => {
      const pane = existing.find(p => !used.has(p) && (id ? (p.tab?.id || p.savedId) === id && (!!p.term === !!state.tabs.find(tab => tab.id === id)?.alive) : !p.tab && !p.savedId));
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
      if (id) {
        const tab = state.tabs.find(tab => tab.id === id);
        if (tab?.alive) attachTerminal(tab, next);
        else {
          next.tab = tab || null; next.savedId = id;
          next.el.querySelector(".pane-name").textContent = tab ? displayName(tab) : id;
          next.el.querySelector(".pane-conn").textContent = tab ? "已停止" : "不可用";
          next.host.innerHTML = '<div class="ws-offline-pane"><span></span></div>';
          next.host.querySelector("span").textContent = tab ? "会话已停止" : "原终端已移除或暂不可用";
          const action = button(tab ? "RotateCw" : "PanelsTopLeft", tab ? "恢复原对话" : "选择其他终端", () => {
            focusPane(next, false);
            if (tab) openTreeSession(id); else openSplitPicker();
          }, "btn-sm");
          const label = document.createElement("span"); label.textContent = tab ? "恢复原对话" : "选择其他终端";
          action.append(label); next.host.firstChild.append(action);
        }
      }
      return next;
    });
    panes = ordered; panes.forEach(p => $("panes").append(p.el));
    $("term-view").classList.toggle("hidden", !panes.length); $("empty").classList.toggle("hidden", !!panes.length);
    active = null;
    const maximized = Number.isInteger(value.maximized) ? panes[value.maximized] || null : null;
    if (panes.length) focusPane(maximized || panes.find(p => (p.tab?.id || p.savedId || null) === value.active) || panes.find(p => p.tab) || panes[0], false);
    else {
      state.activeId = null; setTitlebar(); updateQuickCommandState(); updateRestartControls();
      renderAllCodexUsage(); scheduleCodexUsageRefresh();
    }
    maximizedPane = maximized;
    layoutPanes(); savePaneLayout();
  }

  async function restoreDeviceLayout() {
    if (switching || applyingLayout || splitPending) return;
    switching = true; renderScreens();
    let migrated = false, fetched = false;
    let targetDevice = deviceKey(), recovery = readJournal(targetDevice);
    try {
      if (!(await resolveTokenBinding())) return;
      targetDevice = deviceKey(); recovery = readJournal(targetDevice);
      // Render a verified local snapshot while the server is still waking up.
      if (!initialized && recovery) {
        device = targetDevice; view = { revision: recovery.baseRevision }; dirty = !!recovery.pending;
        installScreens(recovery.layout); initialized = true;
        indicator("已恢复本机布局 · 正在同步");
      }
      const saved = await layoutRequest("/api/layouts/" + targetDevice);
      fetched = true; layoutOffline = false;
      if (saved.screenSchema !== 1) throw new Error("后台尚不支持多屏，请更新后台后重试");
      if (!Array.isArray(saved.panes)) throw new Error("分屏布局不可用");
      const initial = snapshot();
      backupSplits(initial, device);
      let value = screenSet(saved, targetDevice.startsWith("mobile_")), unsynced = false;
      conflict = false;
      if (saved.revision === 0) {
        let legacy = initial;
        if (!initialized && !panes.length && !layoutUser) {
          let ids = [];
          try { ids = JSON.parse(localStorage.getItem("cc_panes") || "[]"); } catch (_) {}
          ids = Array.isArray(ids) ? ids.filter(id => id === null || state.tabs.some(tab => tab.id === id)).slice(0, MAX_PANES) : [];
          const focused = localStorage.getItem("cc_active_id");
          if (!ids.length) ids = state.tabs.filter(tab => tab.alive).slice(0, 1).map(tab => tab.id);
          legacy = { ...initial, panes: ids, active: ids.includes(focused) ? focused : ids.find(Boolean) || null };
        }
        let seed = recovery?.layout || (initialized && screens.length ? packedSnapshot() : legacy);
        if (layoutUser && targetDevice.startsWith("mobile_") && !recovery) {
          const desktop = await layoutRequest("/api/layouts/desktop_user_" + layoutUser);
          if (desktop.revision) seed = desktop;
        }
        value = screenSet(seed, targetDevice.startsWith("mobile_"));
        migrated = true;
      }
      if (recovery?.pending) {
        const ownPending = saved.write?.writer === recovery.writer && Number.isInteger(recovery.sequence) && saved.write.sequence < recovery.sequence && saved.write.baseRevision === recovery.baseRevision;
        if (saved.revision === 0 || recovery.baseRevision === saved.revision || ownPending) { value = recovery.layout; unsynced = true; }
        else if (JSON.stringify(recovery.layout) !== JSON.stringify(screenSet(saved, targetDevice.startsWith("mobile_")))) {
          value = recovery.layout; conflict = true;
          indicator("布局有冲突 · 可保存当前布局副本", true);
        }
      }
      if (targetDevice !== deviceKey()) return;
      if (device !== targetDevice) {
        saveTreeState(); device = targetDevice; treeState = readTreeState(targetDevice); restoreTreeScroll = true;
      }
      // A conflicting local snapshot must never inherit the server's newer revision.
      view = conflict ? { ...saved, revision: recovery.baseRevision } : saved;
      if (conflict) layoutBase = recovery?.base ? { device: targetDevice, revision: recovery.baseRevision, layout: screenSet(recovery.base) } : null;
      else rememberBase(saved, targetDevice);
      device = targetDevice; dirty = unsynced;
      installScreens(value);
      initialized = true;
      if (!conflict) {
        indicator(migrated || unsynced ? "待保存" : "已保存");
        journal(packedSnapshot(), migrated || unsynced);
      }
      renderNavigation();
    } catch (error) {
      layoutOffline = !fetched; restoreRetryAt = Date.now() + 10000;
      if (recovery && targetDevice === deviceKey()) {
        device = targetDevice; view = { revision: recovery.baseRevision }; conflict = true; dirty = !!recovery.pending;
        installScreens(recovery.layout); initialized = true;
        indicator(layoutOffline ? "本机布局 · 网络恢复后自动同步" : "本机布局 · 同步未完成", true);
      }
      notify(error);
    }
    finally {
      switching = false; renderNavigation();
      if (targetDevice !== deviceKey()) setTimeout(restoreDeviceLayout, 0);
    }
    if ((migrated || dirty) && !conflict) { layoutChanged(); await persist(); }
  }

  async function persist() {
    clearTimeout(saveTimer);
    if (saving) return saving;
    if (!dirty || !view || switching || conflict || tokenPromptOpen) return !conflict && !tokenPromptOpen;
    saving = (async () => {
      // All callers wait for the whole drain, including edits made during a PUT.
      while (dirty && !switching && !conflict && !tokenPromptOpen) {
        const targetDevice = device, value = packedSnapshot(), version = changeVersion, revision = view.revision;
        dirty = false; indicator("保存中");
        try {
          const result = await layoutRequest("/api/layouts/" + targetDevice, { method: "PUT", keepalive: true, body: JSON.stringify({ ...value, revision, writer, sequence: version }) });
          if (!Array.isArray(result.screens)) throw new Error("后台尚不支持多屏，请更新后台后重试");
          if (device === targetDevice && view && result.revision > view.revision) view = result;
          rememberBase(view, targetDevice);
          backupSplits(value, targetDevice);
          const confirmed = version === changeVersion || (view?.write?.writer === writer && view.write.sequence >= changeVersion);
          if (confirmed) dirty = false;
          journal(version === changeVersion ? value : packedSnapshot(), !confirmed, targetDevice, view?.revision || result.revision);
          indicator(confirmed ? "已保存" : "待保存");
        } catch (error) {
          const offline = error instanceof TypeError || error.name === "AbortError" || error.status >= 500;
          if (offline && device === targetDevice && view?.write?.writer === writer && view.write.sequence >= version) {
            dirty = view.write.sequence < changeVersion;
            journal(packedSnapshot(), dirty); indicator(dirty ? "待保存" : "已保存");
            continue;
          }
          conflict = true; dirty = true; layoutOffline = offline;
          restoreRetryAt = Date.now() + 10000;
          try {
            const recovery = { device: targetDevice, layout: packedSnapshot(), time: Date.now(), baseRevision: revision, pending: true };
            localStorage.setItem("cc_workspace_recovery", JSON.stringify(recovery));
            localStorage.setItem("cc_screens_conflict_" + targetDevice, JSON.stringify(recovery));
          } catch (_) {}
          indicator(error.status === 409 ? "布局有冲突 · 可保存当前布局副本" : "布局未保存 · 可重试同步或保存副本", true); notify(error); renderScreens();
          return false;
        }
      }
      return !conflict;
    })();
    try { return await saving; }
    finally { saving = null; }
  }

  function checkpoint() {
    saveTreeState();
    if (!initialized || !view || switching || applyingLayout || tokenPromptOpen || resolvingLayout) return;
    const value = packedSnapshot(), version = changeVersion, revision = view.revision, target = device;
    journal(value, dirty || !!saving || (conflict && !layoutOffline));
    if (conflict || (!dirty && !saving)) return;
    const key = target + ":" + version;
    if (checkpointKey === key) return;
    checkpointKey = key;
    // Independent keepalive: the browser need not run the in-flight save's continuation.
    checkpointSaving = layoutRequest("/api/layouts/" + target, { method: "PUT", keepalive: true, body: JSON.stringify({ ...value, revision, writer, sequence: version }) }).then(result => {
      if (target !== device || !view || !Array.isArray(result.screens)) return;
      if (conflict && !layoutOffline) return;
      if (result.revision > view.revision) view = result;
      rememberBase(view, target);
      const confirmed = version === changeVersion || (view.write?.writer === writer && view.write.sequence >= changeVersion);
      conflict = false; layoutOffline = false; dirty = !confirmed;
      journal(packedSnapshot(), !confirmed, target, view.revision); indicator(confirmed ? "已保存" : "待保存");
      renderScreens();
    }).catch(() => {}).finally(() => { if (checkpointKey === key) { checkpointKey = ""; checkpointSaving = null; } });
  }

  function layoutChanged() {
    if (!initialized || switching || applyingLayout || !view) return;
    dirty = true; changeVersion++;
    journal(packedSnapshot(), true);
    clearTimeout(saveTimer); saveTimer = setTimeout(persist, 400);
    renderNavigation();
  }

  async function selectWorkspace(wid, force = false) {
    const next = workspaces.find(workspace => workspace.id === wid);
    if (!next || selecting) return false;
    if (!force && current?.id === wid) { touchWorkspace(next); return true; }
    selecting = true;
    try {
      if (!(await leaveEditor())) return false;
      current = next;
      localStorage.setItem("cc_workspace_active", wid);
      if (!force) touchWorkspace(next);
      if (!Object.prototype.hasOwnProperty.call(treeState.expanded, wid)) treeState.expanded[wid] = true;
      renderNavigation(); saveTreeState();
      filePath = next.cwd; editor = null;
      await renderPanel();
      return true;
    } catch (error) { notify(error); }
    finally { selecting = false; }
  }

  async function beforeOpen(tab) {
    return initialized && !switching && !applyingLayout && !splitPending;
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

  function activeGroupId() {
    const id = active?.tab?.id;
    if (!id || !state.tabs.some(tab => tab.id === id)) return null;
    return (workspaces.find(space => space.id === current?.id && space.members.includes(id)) ||
      workspaces.find(space => space.members.includes(id)))?.id || "_unassigned";
  }

  function revealActiveSession() {
    if (!initialized || switching || applyingLayout) return;
    const id = active?.tab?.id, groupId = activeGroupId();
    if (!groupId) return;
    // Following a deliberate terminal selection never changes the file editor's workspace.
    treeState.expanded[groupId] = true;
    if (!state.tabs.find(tab => tab.id === id)?.alive) treeState.stopped[groupId] = true;
    $("ws-session-search").value = "";
    restoreTreeScroll = false;
    renderNavigation(); saveTreeState();
    cancelAnimationFrame(revealFrame);
    revealFrame = requestAnimationFrame(() => {
      revealFrame = null;
      if (active?.tab?.id !== id || activeGroupId() !== groupId) return;
      const list = $("ws-workspace-list"), row = treeGroups.get(groupId)?.rows.get(id);
      if (!row?.isConnected || !list.clientHeight || !row.getClientRects().length) return;
      const bounds = list.getBoundingClientRect(), item = row.getBoundingClientRect();
      if (item.top < bounds.top) list.scrollTop += item.top - bounds.top;
      else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
      treeState.scroll = list.scrollTop; saveTreeState();
    });
  }

  async function renameTreeSession(id) {
    const tab = state.tabs.find(item => item.id === id);
    if (!tab || renamingSessions.has(id)) return;
    renamingSessions.add(id); renderNavigation();
    try { await renameTab(tab); }
    finally { renamingSessions.delete(id); renderNavigation(); }
  }

  function updateSessionRow(group, tab) {
    let row = group.rows.get(tab.id);
    if (!row) {
      row = document.createElement("div"); row.className = "ws-session"; row.dataset.session = tab.id;
      row.append(button("Terminal", "", () => openTreeSession(tab.id), "ws-session-open"),
        button("Pencil", "重命名会话", () => renameTreeSession(tab.id), "ws-icon ws-session-rename"),
        button("Ellipsis", "会话操作", () => openSessionActions(group.root.dataset.group, tab.id), "ws-icon ws-session-actions"),
        button("Columns2", "在分屏打开", () => addSessionSplit(tab.id), "ws-icon ws-session-split"));
      const meta = document.createElement("span"); meta.className = "ws-session-meta";
      row.firstElementChild.after(meta);
      group.rows.set(tab.id, row);
    }
    const pane = paneOfTab(tab.id), index = panes.indexOf(pane), phase = tab.alive ? statusOf(tab).phase : "offline";
    row.classList.toggle("is-active", !!pane && pane === active);
    const signature = JSON.stringify([displayName(tab), tab.cwd, tab.type, tab.alive, phase, index, pane === active, navigationPending, splitPending, switching, applyingLayout, renamingSessions.has(tab.id)]);
    if (row.dataset.signature === signature) return row;
    row.dataset.signature = signature; row.dataset.phase = phase; row.classList.toggle("is-visible", !!pane);
    const open = row.firstElementChild, split = row.lastElementChild;
    const status = phases[phase] || "未知";
    open.innerHTML = '<span class="ws-session-dot" aria-hidden="true"></span><span class="ws-session-main"><span class="ws-session-name">' + esc(displayName(tab)) + '</span></span>' + (pane ? '<span class="ws-pane-badge">' + (index + 1) + '</span>' : "");
    const meta = row.querySelector(".ws-session-meta");
    meta.textContent = typeLabel(tab.type) + ' · ' + status; meta.title = meta.textContent;
    open.title = displayName(tab) + " · " + typeLabel(tab.type) + " · " + status + (pane ? " · 窗格 " + (index + 1) : "") + "\n" + (tab.cwd || "");
    open.setAttribute("aria-label", (tab.alive ? "打开 " : "启动并恢复 ") + displayName(tab) + "，" + typeLabel(tab.type) + "，" + status + (pane ? "，窗格 " + (index + 1) : ""));
    open.setAttribute("aria-current", String(!!pane && pane === active));
    open.disabled = navigationPending || splitPending || switching || applyingLayout;
    const rename = row.querySelector(".ws-session-rename");
    rename.disabled = open.disabled || renamingSessions.has(tab.id);
    rename.title = "重命名「" + displayName(tab) + "」"; rename.setAttribute("aria-label", rename.title);
    const actions = row.querySelector(".ws-session-actions"); actions.disabled = open.disabled;
    actions.title = "会话操作：" + displayName(tab); actions.setAttribute("aria-label", actions.title);
    split.hidden = !tab.alive; split.disabled = open.disabled;
    split.title = pane ? "聚焦窗格 " + (index + 1) : "在分屏打开"; split.setAttribute("aria-label", split.title);
    if (pane) open.querySelector(".ws-pane-badge").title = "窗格 " + (index + 1);
    return row;
  }

  function openSessionActions(sourceId, sid) {
    const tab = state.tabs.find(item => item.id === sid);
    if (!tab || splitPending || switching || navigationPending) return;
    const modal = document.createElement("div"); modal.className = "modal"; modal.id = "ws-session-actions-modal";
    modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-labelledby", "ws-session-actions-title");
    modal.innerHTML = '<div class="modal-box ws-user-box"><div class="modal-head"><h3 id="ws-session-actions-title"></h3><div class="ws-session-action-close"></div></div><div class="ws-session-commands"></div><form class="ws-session-move-form"><label for="ws-session-target">移到工作区</label><select id="ws-session-target" required></select><p class="ws-session-action-state" role="status"></p><div class="modal-foot"><button type="submit" class="btn-sm primary"></button></div></form></div>';
    modal.querySelector("h3").textContent = displayName(tab);
    let busy = false;
    const close = () => { if (busy) return; closeLayer(modal); modal.remove(); document.removeEventListener("keydown", escape, true); };
    const escape = event => { if (event.key === "Escape" && !event.isComposing && topModal() === modal) { event.preventDefault(); event.stopImmediatePropagation(); close(); } };
    modal.querySelector(".ws-session-action-close").append(button("X", "关闭会话操作", close));
    const command = (icon, label, action, disabled = false) => {
      const el = button(icon, label, () => { close(); action(); }, "ws-row"); el.disabled = disabled;
      const text = document.createElement("span"); text.textContent = label; el.append(text); modal.querySelector(".ws-session-commands").append(el);
    };
    command("PanelTopClose", "关闭当前分屏（后台继续运行）", () => { const pane = paneOfTab(sid); if (pane) closePane(pane); }, !paneOfTab(sid));
    if (tab.alive) command("Square", "停止后台会话…", () => requestStopTab(state.tabs.find(item => item.id === sid) || tab));
    else command("Trash2", "删除已停止的会话标签…", () => deleteTab(sid));
    const source = workspaces.find(item => item.id === sourceId);
    const targets = workspaces.filter(item => item.id !== sourceId).map(item => ({ ...item }));
    const select = modal.querySelector("select"), submit = modal.querySelector('[type="submit"]'), status = modal.querySelector('[role="status"]');
    for (const item of targets) { const option = document.createElement("option"); option.value = item.id; option.textContent = item.name; select.append(option); }
    submit.innerHTML = uiIcon("FolderInput"); submit.append(document.createTextNode("移动"));
    submit.disabled = !targets.length; select.disabled = !targets.length;
    if (!targets.length) status.textContent = "请先新建另一个工作区";
    modal.querySelector("form").onsubmit = async event => {
      event.preventDefault(); if (busy) return;
      const target = targets.find(item => item.id === select.value); if (!target) return;
      busy = true; modal.querySelectorAll("button,select").forEach(el => { el.disabled = true; }); status.textContent = "移动中";
      try {
        const result = await api("/api/workspaces/" + sourceId + "/move-session", { method: "POST", body: JSON.stringify({ sid, target: target.id, revision: source?.revision, targetRevision: target.revision }) }, 0);
        for (const updated of [result.source, result.target].filter(Boolean)) {
          const index = workspaces.findIndex(item => item.id === updated.id); if (index >= 0) workspaces[index] = updated;
          if (current?.id === updated.id) current = updated;
        }
        treeState.expanded[target.id] = true; if (!tab.alive) treeState.stopped[target.id] = true;
        saveTreeState(); renderNavigation(); busy = false; close(); showToast("已移到「" + target.name + "」，终端路径与分屏不变");
      } catch (error) {
        status.textContent = error.status === 409 ? "工作区已变化，未执行移动；请关闭后重新打开此菜单" : error.message;
        busy = false; modal.querySelector(".ws-session-action-close button").disabled = false;
      }
    };
    modal.addEventListener("click", event => { if (event.target === modal) close(); });
    document.body.append(modal); document.addEventListener("keydown", escape, true); openLayer(modal); modal.querySelector("button").focus();
  }

  function renderNavigation() {
    renderScreens();
    const list = $("ws-workspace-list"), query = $("ws-session-search").value.trim().toLowerCase();
    const focusedControl = list.contains(document.activeElement) ? document.activeElement : null;
    const now = Date.now(), ranks = new Map(workspaces.map(space => [space.id, activeTime(space, now)]));
    const online = new Map(workspaces.map(space => [space.id, Number(state.tabs.some(tab => tab.alive && space.members.includes(tab.id)))]));
    workspaceSort.value = treeState.sort;
    const groups = [...workspaces].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (treeState.sort === "name"
      ? workspaceNames.compare(a.name, b.name) || a.id.localeCompare(b.id)
      : ranks.get(b.id) - ranks.get(a.id) || online.get(b.id) - online.get(a.id)));
    const assigned = new Set(workspaces.flatMap(space => space.members));
    const unassigned = state.tabs.filter(tab => !assigned.has(tab.id));
    if (unassigned.length) groups.push({ id: "_unassigned", name: "未分组", cwd: "", members: unassigned.map(tab => tab.id) });
    const wanted = [], activeGroup = activeGroupId();
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
      group.header.classList.toggle("has-active-session", space.id === activeGroup);
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
    if (focusedControl?.isConnected && document.activeElement !== focusedControl) focusedControl.focus({ preventScroll: true });
    list.dataset.empty = String(!wanted.some(el => !el.hidden));
    if (restoreTreeScroll && initialized && workspacesLoaded && (current || !workspaces.length)) {
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
    window.ccUnread?.update({ screens, panes, active, activityUnread: events.some(event => !event.seen) });
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
      if (!initialized || (layoutOffline && Date.now() >= restoreRetryAt)) await restoreDeviceLayout();
      const data = await api("/api/workspaces", {}, 0);
      if (!Array.isArray(data.workspaces)) return;
      workspaces = data.workspaces; workspacesLoaded = true;
      if (!current) {
        const previous = localStorage.getItem("cc_workspace_active");
        const target = workspaces.find(space => space.id === previous) || workspaces.find(space => space.members.includes(active?.tab?.id)) || workspaces[0];
        if (target) await selectWorkspace(target.id, true);
      } else {
        const latest = workspaces.find(space => space.id === current?.id);
        if (latest) current = latest;
        else { current = null; if (workspaces[0]) await selectWorkspace(workspaces[0].id, true); }
      }
      if (Date.now() - lastRefresh > 5000) {
        window.ccUnread?.refresh();
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
    finally { refreshing = false; syncTerminalContinuity(); }
  }

  function message(text, failed = false, retry) {
    $("ws-deck-content").innerHTML = '<div class="ws-message' + (failed ? ' error' : '') + '" role="status">' + esc(text) + '</div>';
    if (retry) $("ws-deck-content").append(button("RefreshCw", "重试读取", retry, "ws-icon ws-retry"));
  }

  let leavingEditor = null;
  async function leaveEditor() {
    if (editor?.saving) { showToast("文件正在保存，请稍后再切换"); return false; }
    if (!editor?.dirty) return true;
    if (leavingEditor) return false;
    leavingEditor = uiConfirm("放弃未保存的修改？", editor.path);
    try { return !!(await leavingEditor); } finally { leavingEditor = null; }
  }

  async function openPanel(next) {
    if (next !== panel && !(await leaveEditor())) return;
    if (next !== panel) editor = null;
    panel = next; toggleDeck(true); closeDrawer();
    for (const el of $("ws-deck-tabs").children) {
      const selected = el.dataset.panel === panel;
      el.setAttribute("aria-selected", String(selected)); el.tabIndex = selected ? 0 : -1;
    }
    $("ws-deck-content").setAttribute("aria-labelledby", "ws-panel-tab-" + panel);
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
    } catch (error) { if (valid()) message(error.message, true, renderPanel); }
  }

  function renderFleet() {
    const content = $("ws-deck-content");
    const tabs = state.tabs.filter(tab => globalFleet || !current || current.members.includes(tab.id));
    const signature = JSON.stringify([globalFleet, current?.id, current?.name, tabs.map(tab => [tab.id, displayName(tab), tab.cwd, tab.type, tab.alive, statusOf(tab).phase, statusOf(tab).source])]);
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

  const acknowledging = new Set();
  async function acknowledgeEvents(ids) {
    const pending = ids.filter(id => !acknowledging.has(id));
    if (!pending.length) return;
    pending.forEach(id => acknowledging.add(id));
    try {
      await api("/api/fleet/ack", { method: "POST", body: JSON.stringify({ ids: pending }) });
      events.forEach(event => { if (pending.includes(event.id)) event.seen = 1; });
    } finally { pending.forEach(id => acknowledging.delete(id)); }
  }
  function renderEvents() {
    const content = $("ws-deck-content");
    const signature = JSON.stringify([events, [...acknowledging], state.tabs.map(tab => [tab.id, displayName(tab)])]);
    if (content.dataset.panel === "activity" && content.dataset.signature === signature) return;
    content.dataset.panel = "activity"; content.dataset.signature = signature;
    content.innerHTML = '<div class="ws-panel-toolbar"><span>最近活动</span><div id="ws-events-actions"></div></div>';
    const markAll = button("CheckCheck", "全部标为已读", async () => {
      markAll.disabled = true; markAll.dataset.busy = "1";
      try {
        await acknowledgeEvents(events.filter(e => !e.seen).map(e => e.id));
        await window.ccUnread?.markAll();
      }
      catch (error) { notify(error); }
      finally { delete markAll.dataset.busy; markAll.disabled = false; renderNavigation(); if (panel === "activity") renderEvents(); }
    });
    markAll.id = "ws-events-mark-all";
    markAll.disabled = !events.some(event => !event.seen && !acknowledging.has(event.id));
    $("ws-events-actions").append(markAll);
    for (const event of events) {
      const tab = state.tabs.find(item => item.id === event.sid);
      if (!tab) continue;
      const el = document.createElement("button"); el.className = "ws-row"; el.dataset.seen = event.seen;
      el.innerHTML = uiIcon(event.phase === "complete" ? "Check" : "Bell") + '<span>' + esc(displayName(tab)) + ' · ' + esc(phases[event.phase]) + '</span><small>' + esc(new Date(event.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) + '</small>';
      el.onclick = async () => {
        const seq = deckSequence;
        el.disabled = true;
        try {
          await acknowledgeEvents([event.id]);
          if (panel !== "activity" || seq !== deckSequence) return;
          await openTab(tab); if (mqMobile.matches) toggleDeck(false);
        }
        catch (error) { notify(error); }
        finally { el.disabled = false; if (panel === "activity") renderEvents(); }
      };
      el.disabled = acknowledging.has(event.id);
      content.append(el);
    }
    if (!events.some(e => state.tabs.some(tab => tab.id === e.sid))) content.insertAdjacentHTML("beforeend", '<div class="ws-message">暂无活动</div>');
    window.ccUnread?.paint();
  }

  function renderFilesPanel(data) {
    filePath = data.path;
    const content = $("ws-deck-content");
    content.innerHTML = '<div class="ws-panel-toolbar"><span title="' + esc(filePath) + '">' + esc(tabBasename(filePath)) + '</span><div id="ws-files-actions"></div></div>';
    const up = button("ArrowUp", "上一级", () => { filePath = data.parent; renderPanel(); });
    up.disabled = filePath === current?.cwd || !data.parent;
    $("ws-files-actions").append(up, button("RefreshCw", "刷新文件", renderPanel), button("FolderSearch", "路径预览", () => window.ccFilePreview?.launch(filePath || current?.cwd)), button("FolderOpen", "完整文件管理", openFilesModal));
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
    if (!data.entries?.length) content.insertAdjacentHTML("beforeend", '<div class="ws-message" role="status">此文件夹为空</div>');
  }

  async function editFile(path) {
    const seq = ++deckSequence;
    message("读取文件中");
    try {
      const file = await api("/api/fs/edit?path=" + encodeURIComponent(path), {}, 0);
      if (seq !== deckSequence || panel !== "files") return;
      editor = { path, etag: file.etag, dirty: false, newline: file.newline || "lf" };
      const content = $("ws-deck-content");
      content.innerHTML = '<div class="ws-editor"><div class="ws-panel-toolbar"><span title="' + esc(path) + '">' + esc(tabBasename(path)) + '</span><div id="ws-editor-actions"></div></div><textarea id="ws-editor-text" spellcheck="false" aria-label="文件内容"></textarea><div id="ws-editor-state" class="ws-save-state" role="status">UTF-8 · 已保存</div></div>';
      $("ws-editor-text").value = file.text;
      $("ws-editor-text").oninput = () => { if (editor) editor.dirty = true; $("ws-editor-state").textContent = editor?.saving ? "保存中 · 有新修改" : "未保存"; updateSaveButton(); };
      $("ws-editor-text").onkeydown = event => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s" && !event.isComposing) {
          event.preventDefault(); event.stopPropagation(); saveFile();
        }
      };
      const save = button("Save", "保存文件", saveFile); save.id = "ws-editor-save";
      $("ws-editor-actions").append(save, button("X", "关闭文件", async () => { if (await leaveEditor()) { editor = null; renderPanel(); } }));
      updateSaveButton();
    } catch (error) { if (seq === deckSequence) message(error.message, true, () => editFile(path)); }
  }

  function updateSaveButton() {
    const save = $("ws-editor-save");
    if (!save) return;
    save.disabled = !editor?.dirty || !!editor?.saving;
    save.setAttribute("aria-busy", String(!!editor?.saving));
  }

  async function saveFile() {
    if (!editor?.dirty || editor.saving) return;
    const target = editor, value = $("ws-editor-text").value;
    target.saving = true; updateSaveButton();
    $("ws-editor-state").textContent = "保存中";
    try {
      const text = target.newline === "crlf" ? value.replace(/\r?\n/g, "\r\n") : value;
      const result = await api("/api/fs/edit", { method: "PUT", body: JSON.stringify({ path: target.path, text, etag: target.etag }) });
      if (editor !== target) return;
      target.etag = result.etag; target.dirty = $("ws-editor-text").value !== value;
      $("ws-editor-state").textContent = target.dirty ? "未保存" : "UTF-8 · 已保存";
      $("ws-editor-state").classList.remove("error");
    } catch (error) { if (editor === target) { $("ws-editor-state").textContent = error.message; $("ws-editor-state").classList.add("error"); } }
    finally { target.saving = false; if (editor === target) updateSaveButton(); }
  }

  function renderGit(data) {
    ++deckSequence;
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
        content.querySelectorAll('.ws-row').forEach(row => row.setAttribute("aria-pressed", String(row === el)));
        content.querySelector('.ws-diff')?.remove(); content.querySelector('.ws-git-state')?.remove();
        const stateEl = document.createElement("div"); stateEl.className = "ws-message ws-git-state"; stateEl.setAttribute("role", "status"); stateEl.textContent = "读取差异中"; content.append(stateEl);
        try {
          const diff = await api("/api/git/diff?path=" + encodeURIComponent(gitRoot) + "&file=" + encodeURIComponent(change.path) + "&staged=" + gitStaged, {}, 0);
          if (seq !== deckSequence || panel !== "git") return;
          stateEl.remove();
          content.querySelector(".ws-diff")?.remove();
          const pre = document.createElement("pre"); pre.className = "ws-diff";
          const text = diff.text || (change.status === "??" ? "未跟踪文件" : "无文本差异");
          pre.innerHTML = text.split("\n").map(line => '<span class="' + (line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "") + '">' + esc(line) + '</span>').join("\n") + (diff.truncated ? "\n[截断]" : "");
          content.append(pre);
        } catch (error) { if (seq === deckSequence && panel === "git") { stateEl.textContent = error.message; stateEl.classList.add("error"); stateEl.append(button("RefreshCw", "重试读取差异", () => el.click())); } }
      };
      content.append(el);
    }
    if (!content.querySelector('.ws-row')) content.insertAdjacentHTML("beforeend", '<div class="ws-message" role="status">' + (gitStaged ? "暂无暂存更改" : data.changes?.length ? "暂无未暂存更改" : "工作树干净") + '</div>');
  }

  function renderSettings() {
    const content = $("ws-deck-content"); content.innerHTML = '<div class="ws-settings" id="ws-settings"></div>';
    const target = current;
    const heading = text => { const el = document.createElement("h4"); el.className = "ws-settings-heading"; el.textContent = text; $("ws-settings").append(el); };
    const add = (label, text, action) => {
      const row = document.createElement("div"); row.className = "ws-setting";
      const name = document.createElement("span"); name.textContent = label;
      const el = document.createElement("button"); el.type = "button"; el.textContent = text;
      el.onclick = async () => {
        if (el.disabled) return;
        el.disabled = true;
        try { await action(); } catch (error) { notify(error); } finally { el.disabled = false; }
      };
      row.append(name, el); $("ws-settings").append(row);
      return row;
    };
    heading("外观");
    const theme = document.createElement("div"); theme.className = "ws-setting";
    theme.innerHTML = '<span>主题</span><div class="ws-segments" role="group" aria-label="主题"></div>';
    for (const [value, label] of [["light", "浅色"], ["dark", "深色"]]) {
      const el = document.createElement("button"); el.type = "button"; el.textContent = label; el.setAttribute("aria-pressed", String(currentTheme() === value));
      el.onclick = () => { if (currentTheme() !== value) toggleTheme(); renderSettings(); }; theme.lastElementChild.append(el);
    }
    $("ws-settings").append(theme);
    window.ccAppearance?.mountSettings($("ws-settings"));
    heading("工具");
    add("访问记录", "打开", openIpsModal);
    heading("屏幕与布局");
    add("布局用户", layoutUser || "仅本机", openLayoutUser);
    add("屏幕", "新建屏幕", createScreen);
    add("当前屏幕", "重命名", renameScreen);
    add("屏幕顺序", "调整", openScreenOrder);
    add("分屏布局", "重新载入", reloadScreens);
    if (target) {
      heading("当前工作区");
      add("工作区名称", "重命名", async () => {
        const name = await uiPrompt("重命名工作区", target.name);
        if (name?.trim()) { await changeWorkspace({ name }, target); if (panel === "settings") renderSettings(); }
      });
      const pin = document.createElement("label"); pin.className = "ws-setting";
      pin.innerHTML = '<span>固定工作区</span><input type="checkbox" role="switch" aria-label="固定工作区">';
      const checkbox = pin.lastElementChild; checkbox.checked = !!target.pinned;
      checkbox.onchange = async () => {
        checkbox.disabled = true;
        try { await changeWorkspace({ pinned: checkbox.checked }, target); if (panel === "settings") renderSettings(); }
        catch (error) { checkbox.checked = !!target.pinned; notify(error); }
        finally { checkbox.disabled = false; }
      };
      $("ws-settings").append(pin);
      add("删除工作区", "删除", async () => {
        if (!(await uiConfirm("删除工作区「" + target.name + "」？", "仅移除工作区分组，当前分屏和终端任务保持不变。", true))) return;
        try {
          const id = target.id; await api("/api/workspaces/" + id + "?revision=" + target.revision, { method: "DELETE" });
          workspaces = workspaces.filter(space => space.id !== id);
          if (current?.id === id) { current = null; if (workspaces[0]) await selectWorkspace(workspaces[0].id); }
          renderNavigation(); if (panel === "settings") renderSettings();
        } catch (error) { notify(error); }
      }).classList.add("ws-setting-danger");
    }
    heading("兼容性");
    add("界面", "回退到旧版", () => { localStorage.setItem("cc_ui", "legacy"); location.href = "/?ui=legacy"; });
  }

  let paletteActions = [], paletteIndex = 0;
  function renderPalette() {
    const q = $("ws-palette-input").value.trim().toLowerCase();
    const commands = [
      ["新终端", "Terminal", openDirModal], ["新建工作区", "Plus", createWorkspace], ["分屏", "Columns2", openSplitPicker],
      ["新建屏幕", "Plus", createScreen], ["按 ID 打开", "Hash", () => window.ccSessionLookup?.open()], ["绑定布局用户", "UserRound", openLayoutUser],
      ["重命名屏幕", "Pencil", renameScreen], ["删除当前屏幕", "Trash2", deleteScreen],
      ["屏幕排序", "ListOrdered", openScreenOrder],
      ["移到其他屏幕", "MoveRight", () => openMovePicker()],
      ["搜索终端历史", "TextSearch", openHistory], ["版本与更新", "PackageSearch", () => $("btn-versions").click()],
      ["文件", "FolderTree", () => openPanel("files")], ["路径预览", "FolderSearch", () => window.ccFilePreview?.launch()], ["Git", "GitBranch", () => openPanel("git")],
      ["活动", "Bell", () => openPanel("activity")], ["资源监控", "Activity", openGpuModal],
      ["重启并恢复原会话", "RotateCw", () => active?.tab && requestRestartTab(active.tab)],
      ["显示或隐藏侧栏", "PanelLeft", toggleSidebar], ["切换主题", "SunMoon", toggleTheme],
    ];
    paletteActions = [...commands.map(([label, icon, action]) => ({ label, icon, action })),
      ...screens.map(screen => ({ label: screen.name, icon: "PanelsTopLeft", kind: "屏幕", action: () => switchScreen(screen.id) })),
      ...workspaces.map(space => ({ label: space.name, icon: "Folder", kind: "工作区", action: () => selectWorkspace(space.id) })),
      ...state.tabs.map(tab => ({ label: displayName(tab), icon: "Terminal", kind: typeLabel(tab.type), action: () => openTab(tab) }))].filter(item => item.label.toLowerCase().includes(q));
    paletteIndex = Math.min(paletteIndex, Math.max(0, paletteActions.length - 1));
    $("ws-palette-list").replaceChildren();
    paletteActions.forEach((item, index) => {
      const row = document.createElement("button"); row.className = "ws-row"; row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(index === paletteIndex));
      row.id = "ws-palette-option-" + index; row.tabIndex = -1;
      row.innerHTML = uiIcon(item.icon) + '<span>' + esc(item.label) + '</span><small>' + esc(item.kind || "命令") + '</small>';
      row.onclick = () => { closeLayer(palette, () => { Promise.resolve(item.action()).catch(notify); }); };
      $("ws-palette-list").append(row);
    });
    $("ws-palette-empty").hidden = !!paletteActions.length;
    if (paletteActions.length) $("ws-palette-input").setAttribute("aria-activedescendant", "ws-palette-option-" + paletteIndex);
    else $("ws-palette-input").removeAttribute("aria-activedescendant");
  }
  function openPalette() { paletteIndex = 0; $("ws-palette-input").value = ""; renderPalette(); openLayer(palette); setTimeout(() => { if (topModal() === palette) $("ws-palette-input").focus(); }, 20); }
  function openHistory() {
    if (!active?.tab?.alive) { showToast("未连接活动终端"); return; }
    historyTarget = active.tab.id; historySequence++;
    $("ws-history-title").textContent = "终端历史 · " + displayName(active.tab);
    $("ws-history-input").value = ""; $("ws-history-results").replaceChildren(); $("ws-history-state").textContent = "";
    openLayer(historyModal); setTimeout(() => { if (topModal() === historyModal) $("ws-history-input").focus(); }, 20);
  }
  $("ws-palette-input").oninput = () => { paletteIndex = 0; renderPalette(); };
  palette.addEventListener("click", event => { if (event.target === palette) closeLayer(palette); });
  historyModal.addEventListener("click", event => { if (event.target === historyModal) closeLayer(historyModal); });
  document.addEventListener("keydown", event => {
    if (event.isComposing || event.keyCode === 229) return;
    const modal = topModal();
    if (modal && ![deck, orderModal, moveModal, userModal, replaceModal, splitModal, palette, historyModal].includes(modal)) return;
    if (modal && ![deck, palette, historyModal].includes(modal) && event.key !== "Escape") return;
    if (modal === orderModal && event.key === "Escape") {
      event.preventDefault(); event.stopImmediatePropagation(); closeLayer(orderModal); return;
    }
    if (modal === moveModal && event.key === "Escape") {
      event.preventDefault(); event.stopImmediatePropagation(); if (!splitPending) closeLayer(moveModal); return;
    }
    if (modal === userModal && event.key === "Escape") {
      event.preventDefault(); event.stopImmediatePropagation(); if (!splitPending) closeLayer(userModal); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "p") {
      event.preventDefault(); event.stopImmediatePropagation(); openPalette(); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault(); event.stopImmediatePropagation(); openHistory(); return;
    }
    if (modal === replaceModal && event.key === "Escape") {
      event.preventDefault(); event.stopImmediatePropagation(); if (!splitPending) closeLayer(replaceModal);
    }
    else if (modal === splitModal && event.key === "Escape" && !applyingLayout && !splitPending) { event.preventDefault(); event.stopImmediatePropagation(); closeLayer(splitModal); }
    else if (modal === palette) {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeLayer(palette); }
      if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); paletteIndex = Math.max(0, Math.min(paletteActions.length - 1, paletteIndex + (event.key === "ArrowDown" ? 1 : -1))); renderPalette(); $("ws-palette-list").children[paletteIndex]?.scrollIntoView({ block: "nearest" }); }
      if (event.key === "Enter") { event.preventDefault(); $("ws-palette-list").children[paletteIndex]?.click(); }
    } else if (modal === historyModal && event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeLayer(historyModal); }
    else if (event.key === "Escape" && mqMobile.matches && !document.body.classList.contains("deck-closed")) { event.preventDefault(); event.stopImmediatePropagation(); toggleDeck(false); }
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
    closeLayer(moveModal); clearScreenDrag(); closeLayer(orderModal); clearTabDrag();
    if (!splitPending) closeLayer(userModal);
    deviceChange = deviceChange.then(async () => { if (device !== deviceKey() && await persist()) await restoreDeviceLayout(); }).catch(notify);
    toggleDeck(!mqMobile.matches && localStorage.getItem("cc_workspace_deck") === "1");
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) checkpoint(); else sessionsChanged(); });
  window.addEventListener("online", () => { if (layoutOffline) { restoreRetryAt = 0; sessionsChanged(); } });
  window.addEventListener("pagehide", checkpoint);
  window.addEventListener("beforeunload", event => { if (editor?.dirty) { event.preventDefault(); event.returnValue = ""; } });
  window.ccWorkspace = {
    sessionsChanged, layoutChanged, beforeOpen, openSplitPicker, interacted, revealActiveSession, paneCreated, idOpenContext, openById,
    async terminalCreated(tab) {
      if (current && !current.members.includes(tab.id)) {
        try { await changeWorkspace({ members: [...current.members, tab.id] }); touchWorkspace(current); } catch (error) { notify(error); }
      }
    },
    focusChanged() {
      interacted(active?.tab?.id); renderNavigation(); layoutChanged(); revealActiveSession();
      if (initialized && !switching && !applyingLayout && !splitPending) window.ccUnread?.enter(active);
    },
    get current() { return current; }, get ready() { return initialized && !switching && !applyingLayout && device === deviceKey(); }, persist,
    get canResume() { return initialized && !switching && !applyingLayout && !splitPending && !layoutOffline && !conflict && device === deviceKey(); },
    async authenticationChanged() {
      if (!initialized) return;
      clearTimeout(saveTimer);
      // The login overlay blocks new changes; let previously issued operations settle.
      while (switching || splitPending || saving || checkpointSaving) await new Promise(resolve => setTimeout(resolve, 50));
      if (initialized && view) journal(packedSnapshot(), dirty || !!saving || conflict);
      initialized = false; conflict = false; dirty = false; view = null; tokenBinding = null;
      await restoreDeviceLayout();
    },
  };
  toggleDeck(!mqMobile.matches && localStorage.getItem("cc_workspace_deck") === "1");
  renderFleet();
  renderScreens();
  sessionsChanged();
  setInterval(() => { if (!document.hidden) sessionsChanged(); }, 10000);
})();
