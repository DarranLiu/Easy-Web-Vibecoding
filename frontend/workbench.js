"use strict";

// Reference shell only: move existing controls, never replace terminal objects,
// replay input, or maintain a second copy of layout/session state.
(() => {
  if (document.documentElement.dataset.ui !== "bridge" || !window.ccWorkspace) return;
  const $ = id => document.getElementById(id);
  const root = $("app"), header = $("workspace-header"), screens = $("ws-screen-bar");
  const crumb = header.querySelector(".workspace-crumb"), actions = header.querySelector(".workspace-actions");
  const primary = header.querySelector(".ws-primary-actions");
  const originals = new Map();
  function remember(el) {
    const marker = document.createComment("workbench: " + (el.id || el.className));
    el.before(marker); originals.set(el, marker); return el;
  }
  function restore(el) { originals.get(el)?.after(el); }
  function label(id, text) {
    const el = $(id), span = document.createElement("span");
    span.className = "workbench-label"; span.textContent = text; el.append(span);
  }
  function command(id, icon, text, action) {
    const el = document.createElement("button");
    el.id = id; el.type = "button"; el.className = "tb-btn workbench-command";
    el.title = text; el.setAttribute("aria-label", text); el.innerHTML = uiIcon(icon);
    const span = document.createElement("span"); span.className = "workbench-label"; span.textContent = text;
    el.append(span); el.onclick = action; return el;
  }
  const brand = remember(document.querySelector(".app-brand"));
  const theme = remember($("theme-toggle"));
  const project = remember($("workspace-project"));
  const save = remember($("ws-save-indicator"));
  const sync = remember(document.querySelector(".ws-layout-sync-action"));
  const profile = remember($("ws-layout-user"));
  const summary = remember(document.querySelector(".ws-summary"));
  [header, screens, primary, $("header-new"), $("header-split"), $("btn-files"), $("btn-tools"), $("ws-command")].forEach(remember);
  const search = $("ws-command"); search.classList.add("workbench-search");
  search.innerHTML = uiIcon("Search"); label("ws-command", "搜索命令、工作区或会话");
  search.setAttribute("aria-haspopup", "dialog"); search.setAttribute("aria-controls", "ws-palette-modal");
  const lookup = command("workbench-lookup", "LocateFixed", "按 ID 打开", () => window.ccSessionLookup.open());
  lookup.setAttribute("aria-haspopup", "dialog"); lookup.setAttribute("aria-controls", "session-lookup-modal");
  const syncGroup = document.createElement("div"); syncGroup.className = "workbench-sync";
  const searchGroup = document.createElement("div"); searchGroup.className = "workbench-search-group";
  const toolbar = document.createElement("div"); toolbar.className = "workbench-actions";
  toolbar.setAttribute("role", "group"); toolbar.setAttribute("aria-label", "屏幕与终端操作");
  const context = document.createElement("div"); context.className = "workbench-context";
  const contextLabel = document.createElement("span"); contextLabel.textContent = "当前窗口"; context.append(contextLabel);
  const sidebar = document.querySelector(".ws-sidebar"); sidebar.querySelector(".ws-tree-search").after(context);
  for (const [id, text] of [["header-new", "新终端"], ["header-split", "分屏"], ["btn-copy-session-id", "会话 ID"], ["btn-reference", "参考文件"], ["btn-files", "路径预览"], ["btn-permissions", "运行权限"], ["btn-gpu", "资源"], ["btn-versions", "版本与更新"], ["ws-deck-toggle", "检查器"]]) label(id, text);
  $("header-new").classList.add("workbench-new");
  const directions = document.createElement("div"); directions.className = "workbench-directions";
  directions.setAttribute("role", "group"); directions.setAttribute("aria-label", "分屏排列");
  for (const [mode, icon, title] of [["auto", "LayoutGrid", "自动排列"], ["row", "Columns2", "左右排列"], ["col", "Rows2", "上下排列"]]) {
    const el = command("workbench-direction-" + mode, icon, title, () => setPaneDirection(mode));
    el.dataset.direction = mode; directions.append(el);
  }
  function syncDirection() {
    for (const el of directions.children) el.setAttribute("aria-pressed", String(el.dataset.direction === paneDirMode()));
  }
  new MutationObserver(syncDirection).observe($("btn-dir"), { attributes: true, attributeFilter: ["title"] });
  syncDirection();

  function place() {
    if (mqMobile.matches) {
      for (const el of originals.keys()) restore(el);
      syncGroup.remove(); searchGroup.remove(); toolbar.remove(); lookup.remove();
      context.hidden = true;
    } else {
      root.insertBefore(header, $("body")); root.insertBefore(screens, $("body"));
      crumb.prepend($("btn-sidebar"), brand); crumb.append(profile, syncGroup);
      syncGroup.append(save, sync);
      header.insertBefore(searchGroup, actions); searchGroup.append(search, lookup);
      actions.append(theme, $("ws-deck-toggle"));
      screens.append(toolbar);
      toolbar.append($("header-new"), $("header-split"), directions, primary, $("btn-files"), $("btn-tools"));
      context.hidden = false; context.append(project);
      context.after(summary);
    }
    requestAnimationFrame(refitAll);
  }
  place(); mqMobile.addEventListener("change", place);
})();
