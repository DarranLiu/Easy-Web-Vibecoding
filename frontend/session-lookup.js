"use strict";

(() => {
  if (!window.ccWorkspace) return;
  const $ = id => document.getElementById(id);
  const modal = document.createElement("div");
  modal.id = "session-lookup-modal"; modal.className = "modal hidden";
  modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-labelledby", "session-lookup-title");
  modal.innerHTML = '<div class="modal-box session-lookup-box"><div class="modal-head"><h3 id="session-lookup-title">按 ID 打开</h3><button type="button" id="session-lookup-close" class="icon-btn" title="关闭" aria-label="关闭按 ID 打开">' + uiIcon("X") + '</button></div>' +
    '<form id="session-lookup-form"><label for="session-lookup-input">窗口 / 会话 ID</label><div class="session-lookup-search"><input id="session-lookup-input" type="text" maxlength="68" placeholder="cc_abc123 / 会话 UUID / ses_…" autocomplete="off" autocapitalize="off" spellcheck="false" required><button type="submit" class="btn-sm" title="查找会话" aria-label="查找会话">' + uiIcon("Search") + '</button></div></form>' +
    '<div id="session-lookup-results" role="group" aria-label="匹配的会话"></div><div id="session-lookup-state" role="status" aria-live="polite"></div>' +
    '<div class="modal-foot"><label for="session-lookup-target">打开到</label><select id="session-lookup-target"><option value="current">当前屏幕</option><option value="new">新屏幕</option></select><button type="button" id="session-lookup-apply" class="btn-sm primary" disabled>' + uiIcon("Columns2") + '<span>加入分屏</span></button></div></div>';
  document.body.append(modal);
  let sequence = 0, controller = null, busy = false, matches = [], selected = null, query = "", context = null, targetTouched = false;
  const status = (value, error = false) => {
    $("session-lookup-state").textContent = value;
    $("session-lookup-state").classList.toggle("error", error);
  };
  function cancelLookup() {
    ++sequence; controller?.abort(); controller = null;
    $("session-lookup-form").removeAttribute("aria-busy");
  }
  function reset() {
    cancelLookup(); matches = []; selected = null; query = ""; targetTouched = false;
    $("session-lookup-results").replaceChildren(); status(""); update();
  }
  function close() { if (!busy) { cancelLookup(); closeLayer(modal); } }
  function update() {
    const current = $("session-lookup-target").options[0], next = $("session-lookup-target").options[1];
    current.disabled = !context || (context.panes.filter(Boolean).length >= context.limit && !context.panes.includes(selected?.id));
    next.disabled = !context || context.screens >= 16;
    current.textContent = current.disabled ? "当前屏幕已满" : "当前屏幕";
    next.textContent = next.disabled ? "屏幕已达上限" : "新屏幕";
    const target = $("session-lookup-target");
    if (!targetTouched) target.value = current.disabled ? "new" : "current";
    if (target.selectedOptions[0]?.disabled) target.value = current.disabled ? "new" : "current";
    $("session-lookup-apply").disabled = busy || !selected || selected.action === "blocked" || target.selectedOptions[0]?.disabled;
    $("session-lookup-apply").querySelector("span").textContent = selected?.resumePending ? "打开待确认窗口" : selected?.action === "resume" || selected?.action === "import" ? "唤醒并分屏" : "加入分屏";
  }
  function render() {
    $("session-lookup-results").replaceChildren();
    for (const item of matches) {
      const row = document.createElement("label"); row.className = "session-lookup-row";
      const radio = document.createElement("input"); radio.type = "radio"; radio.name = "session-lookup-choice"; radio.value = item.key;
      radio.checked = selected === item; radio.disabled = item.action === "blocked";
      radio.setAttribute("aria-label", item.name || item.nativeId || item.id);
      radio.onchange = () => { selected = item; update(); };
      const text = document.createElement("span"), name = document.createElement("b");
      name.textContent = item.name || item.nativeId || item.id; text.append(name);
      const agent = ["codex", "claude", "opencode", "shell"].includes(item.agent) ? typeLabel(item.agent) : "程序未识别";
      const lines = [agent + " · " + (item.resumePending ? "窗口已启动 · 等待原生确认" : { attach: "运行中 · 直接打开", resume: "已停止 · 恢复原对话", import: "本地历史 · 尚未加入网页", blocked: "暂不可打开" }[item.action] || "状态未知"),
        item.cwd, item.nativeId || item.id, item.reason];
      const elsewhere = context.locations.filter(screen => item.id && screen.id !== context.screen && screen.panes.includes(item.id));
      if (elsewhere.length) lines.push("已在「" + elsewhere.map(screen => screen.name).join("、") + "」打开 · 确认后移至目标屏幕");
      for (const line of lines.filter(Boolean)) { const el = document.createElement("small"); el.textContent = line; text.append(el); }
      row.append(radio, text); $("session-lookup-results").append(row);
    }
    update();
  }
  async function find(event) {
    event.preventDefault(); if (busy || event.isComposing) return;
    context = window.ccWorkspace.idOpenContext();
    reset(); const value = $("session-lookup-input").value.trim();
    if (!/^(?:[a-zA-Z0-9_-]{1,64}|ses_[a-zA-Z0-9]{8,64})$/.test(value)) { status("请输入完整的窗口 ID 或会话 ID", true); return; }
    const seq = sequence; controller = new AbortController();
    $("session-lookup-form").setAttribute("aria-busy", "true"); status("正在查找本地会话");
    const valid = () => seq === sequence && layerOpen(modal);
    try {
      const data = await api("/api/session-lookup?id=" + encodeURIComponent(value), { signal: controller.signal, cache: "no-store" }, 0);
      if (!valid()) return;
      if (!Array.isArray(data.matches) || typeof data.query !== "string" || data.matches.some(item => !item || typeof item.key !== "string" || typeof item.expected !== "string" || !["attach", "resume", "import", "blocked"].includes(item.action))) throw new Error("会话信息无效，请刷新页面后重试");
      query = data.query; matches = data.matches;
      selected = matches.length === 1 && matches[0].action !== "blocked" ? matches[0] : null;
      render(); status(matches.length ? matches.length > 1 ? "找到多个匹配，请选择要打开的会话" : "" : "未找到此 ID。请确认是当前服务器上的完整窗口或会话 ID。无原始记录时无法恢复。");
    } catch (error) { if (valid() && error.name !== "AbortError") status(error.message || "查找失败", true); }
    finally { if (seq === sequence) { controller = null; $("session-lookup-form").removeAttribute("aria-busy"); } }
  }
  $("session-lookup-form").onsubmit = find;
  $("session-lookup-input").oninput = () => { if (!busy) reset(); };
  $("session-lookup-input").onkeydown = event => { if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) event.preventDefault(); };
  $("session-lookup-target").onchange = () => { targetTouched = true; update(); };
  $("session-lookup-close").onclick = close;
  modal.addEventListener("click", event => { if (event.target === modal) close(); });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.isComposing || topModal() !== modal) return;
    event.preventDefault(); event.stopImmediatePropagation(); close();
  }, true);
  mqMobile.addEventListener("change", () => { if (layerOpen(modal) && !busy) close(); });
  $("session-lookup-apply").onclick = async () => {
    if (busy || !selected || $("session-lookup-apply").disabled) return;
    const item = selected, target = $("session-lookup-target").value;
    busy = true; cancelLookup();
    modal.querySelectorAll("input,button,select").forEach(el => { el.disabled = true; });
    modal.setAttribute("aria-busy", "true"); status(item.action === "attach" ? "正在打开窗口" : "正在核对并恢复原对话");
    let success = false, opened = null;
    try {
      const requestId = restartRequestId();
      opened = await window.ccWorkspace.openById({ query, key: item.key, expected: item.expected, id: item.id, confirmed: true, requestId }, target, context);
      success = true;
    } catch (error) {
      status((error.name === "AbortError" ? "等待超时" : error.message || "打开未完成") + "；请重新查找确认窗口状态，不会自动重试。", true);
      selected = null; matches = []; $("session-lookup-results").replaceChildren();
    } finally {
      busy = false; modal.removeAttribute("aria-busy");
      modal.querySelectorAll("input,button,select").forEach(el => { el.disabled = false; }); update();
      if (success) {
        close();
        if (opened?.resumePending) showToast(opened.resumeMessage || "窗口已打开，请在终端完成启动确认；原会话尚未确认加载。");
      }
    }
  };
  window.ccSessionLookup = { open() {
    if (busy || !window.ccWorkspace.ready) return;
    context = window.ccWorkspace.idOpenContext();
    $("session-lookup-input").value = ""; $("session-lookup-target").value = "current"; reset();
    openLayer(modal, true);
    requestAnimationFrame(() => { if (topModal() === modal) $("session-lookup-input").focus(); });
  } };
})();
