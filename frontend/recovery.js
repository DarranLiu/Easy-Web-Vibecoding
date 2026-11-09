"use strict";

(() => {
  const modal = document.createElement("div");
  modal.id = "recovery-modal"; modal.className = "modal hidden";
  modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-labelledby", "recovery-title");
  modal.innerHTML = '<div class="modal-box recovery-box"><div class="modal-head"><h3 id="recovery-title">恢复已停止的窗口</h3><button id="recovery-refresh" class="icon-btn" title="重新读取窗口状态与本地历史" aria-label="重新读取窗口状态与本地历史">' + uiIcon("RefreshCw") + '</button><button id="recovery-close" class="icon-btn" title="取消恢复" aria-label="取消恢复">' + uiIcon("X") + '</button></div><div class="recovery-body"><p id="recovery-target"></p><p id="recovery-reason"></p><form id="recovery-search" hidden><input type="search" id="recovery-query" maxlength="160" placeholder="筛选对话名称或编号（选填）" aria-label="搜索本地对话"><button class="icon-btn" type="submit" title="搜索" aria-label="搜索">' + uiIcon("Search") + '</button></form><div id="recovery-list" role="radiogroup" aria-label="选择原对话"></div><button id="recovery-more" class="btn-sm" hidden>加载更多</button><p id="recovery-state" role="status"></p></div><div class="modal-foot recovery-foot"><button id="recovery-shell" class="btn-sm">' + uiIcon("Terminal") + '<span>仅打开目录终端</span></button><button id="recovery-apply" class="btn-sm primary">' + uiIcon("RotateCw") + '<span>恢复所选对话</span></button></div></div>';
  document.body.append(modal);
  const $ = id => document.getElementById("recovery-" + id);
  let target = null, finish = null, ticket = 0, loading = false, submitting = false, preview = null, candidates = [], selected = null;
  function controls() {
    $("apply").disabled = loading || submitting || !selected || !target?.valid();
    $("shell").disabled = submitting || !target?.valid();
    $("close").disabled = submitting;
    $("refresh").disabled = loading || submitting;
    $("more").disabled = loading || submitting;
    $("query").disabled = submitting;
    $("search").querySelector("button").disabled = loading || submitting;
    for (const radio of $("list").querySelectorAll("input")) radio.disabled = submitting || radio.dataset.unavailable === "true";
  }
  function close(value = null) {
    if (submitting) return;
    ticket++; closeLayer(modal);
    const resolve = finish; finish = null; target = null;
    resolve?.(value);
  }
  async function runningTab(tab) {
    const data = await api("/api/sessions", {}, 0);
    if (!Array.isArray(data.sessions)) throw new Error("无法确认窗口的最新状态");
    const current = data.sessions.find(item => item.id === tab.id);
    if (!current) throw new Error("此窗口已不存在，请刷新会话列表");
    return current.alive === true ? current : null;
  }
  function render() {
    $("list").replaceChildren();
    for (const item of candidates) {
      const row = document.createElement("label"); row.className = "recovery-row";
      const radio = document.createElement("input"); radio.type = "radio"; radio.name = "recovery-session"; radio.value = item.sessionId;
      radio.dataset.unavailable = String(!!(item.inUse || item.duplicate)); radio.disabled = item.inUse || item.duplicate;
      radio.checked = selected?.sessionId === item.sessionId;
      radio.onchange = () => { selected = item; controls(); };
      const text = document.createElement("span"), title = document.createElement("b"), id = document.createElement("code"), detail = document.createElement("small");
      title.textContent = item.title; id.textContent = item.sessionId;
      detail.textContent = [item.updatedAt ? new Date(item.updatedAt * 1000).toLocaleString() : "", item.inUse ? "正在其他窗口运行" : item.duplicate ? "存在重复记录，无法唯一确认" : ""].filter(Boolean).join(" · ");
      text.append(title, id, detail); row.append(radio, text); $("list").append(row);
    }
    $("more").hidden = !preview?.hasMore;
    controls();
  }
  async function load(more = false) {
    if (!target || submitting) return;
    const captured = target, seq = ++ticket, offset = more ? candidates.length : 0;
    if (!more) { selected = null; candidates = []; preview = null; render(); }
    loading = true; $("state").textContent = "正在检查本地对话记录…"; controls();
    try {
      const data = await api("/api/sessions/" + captured.tab.id + "/recovery?q=" + encodeURIComponent($("query").value.trim()) + "&offset=" + offset, {}, 0);
      if (seq !== ticket || target !== captured) return;
      preview = data; candidates = more ? [...candidates, ...data.candidates] : data.candidates;
      $("search").hidden = !data.total && !$("query").value;
      $("reason").textContent = data.defaultsUsed ? "旧启动参数缺失。请确认原对话；恢复使用当前网页配置和常规权限，不会自动发送消息。" : "请确认原对话。恢复保留已记录的启动配置，不会自动发送消息。";
      $("state").textContent = candidates.length ? candidates.length + " / " + data.total + " 个目录匹配的本地对话" + (data.truncated ? " · 记录较多，扫描已限制" : "") : "未找到目录匹配的本地对话；原窗口和历史不会被删除。";
      render();
    } catch (error) {
      if (seq !== ticket || target !== captured) return;
      // A stale stopped entry may become live while its history is being read.
      // Reattach by terminal ID, never guess a conversation or retry a mutation.
      if (error.status === 409) {
        try {
          const live = await runningTab(captured.tab);
          if (seq !== ticket || target !== captured) return;
          if (live && captured.valid()) { loading = false; close(live); return; }
        } catch (statusError) { error = statusError; }
      }
      if (seq === ticket && target === captured) $("state").textContent = "读取未完成 · " + error.message;
    }
    finally { if (seq === ticket) { loading = false; controls(); } }
  }
  async function apply(shell = false) {
    if (submitting || !target?.valid() || (!shell && (!selected || loading))) return;
    const captured = target, data = preview, choice = selected;
    submitting = true; controls();
    try {
      const accepted = await uiDialog({ title: shell ? "仅打开原目录终端" : "确认恢复「" + tabName(captured.tab) + "」", icon: "?",
        message: shell ? "另开一个普通终端，保留原窗口和对话记录；不会自动启动 Agent。" :
          "将此窗口绑定到对话 " + choice.sessionId + " 并恢复。" + (data.defaultsUsed ? "缺失的启动参数使用当前网页配置和常规权限。" : "") + "不会自动发送“继续”，不会停止其他窗口。",
        okLabel: shell ? "打开终端" : "绑定并恢复" });
      if (!accepted) return;
      if (!captured.valid() || target !== captured) throw new Error("目标窗口或屏幕布局已改变，请重新打开");
      restartRequests.set(captured.tab.id, "restarting"); updateRestartControls();
      $("state").textContent = shell ? "正在打开目录终端…" : "正在绑定并恢复所选对话…";
      let restored;
      if (shell) restored = await api("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: captured.tab.cwd, type: "shell", mode: "new" }) }, 0);
      else {
        const bound = await api("/api/sessions/" + captured.tab.id + "/recovery/bind", { method: "POST",
          body: JSON.stringify({ expected: data.expected, sessionId: choice.sessionId, candidateKey: choice.candidateKey, confirmed: true }) }, 0);
        if (!captured.valid()) throw new Error("绑定已保存，但目标窗口已变化；未发送启动命令，请重新打开");
        restored = await api("/api/sessions/" + captured.tab.id + "/restart", { method: "POST",
          body: JSON.stringify({ expected: bound.expected, requestId: restartRequestId(), confirmed: true }) }, 0);
      }
      submitting = false; close(restored);
    } catch (error) {
      // Mutations are never retried when the network leaves their result uncertain.
      selected = null; preview = null; candidates = []; render();
      $("state").textContent = "操作未确认 · " + error.message + "。不会自动重试；请先检查窗口状态，再重新打开。";
    } finally {
      submitting = false; restartRequests.delete(captured.tab.id); updateRestartControls(); controls();
    }
  }
  $("close").onclick = () => close();
  $("refresh").onclick = () => load();
  $("search").onsubmit = event => { event.preventDefault(); load(); };
  $("more").onclick = () => load(true);
  $("apply").onclick = () => apply(); $("shell").onclick = () => apply(true);
  modal.addEventListener("click", event => { if (event.target === modal) close(); });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && layerOpen(modal) && !document.querySelector(".ui-dialog-backdrop")) { event.preventDefault(); close(); }
  });
  window.ccRecovery = {
    async start(tab, valid) {
      const live = await runningTab(tab);
      if (!valid()) return null;
      if (live) return live;
      let existing = null;
      try { existing = await api("/api/sessions/" + tab.id + "/restart", {}, 0); }
      catch (error) {
        if (error.status !== 409) throw error;
        const current = await runningTab(tab);
        if (!valid()) return null;
        if (current) return current;
      }
      if (!valid()) return null;
      if (existing?.running) {
        const current = await runningTab(tab);
        if (!valid()) return null;
        if (current) return current;
        throw new Error("窗口状态已变化，请重新打开");
      }
      if (existing?.ready) {
        if (!(await uiConfirm("恢复「" + tabName(tab) + "」？", "将恢复原对话 " + existing.sessionId + "，不自动发送消息；无法确认原会话时不会新建替代对话。")) || !valid()) return null;
        return api("/api/sessions/" + tab.id + "/start", { method: "POST" }, 0);
      }
      return new Promise(resolve => {
        target = { tab, valid }; finish = resolve; loading = false; submitting = false;
        $("target").textContent = tabName(tab) + " · " + tab.cwd;
        $("reason").textContent = "旧窗口缺少原会话绑定，请从本地历史中确认原对话。";
        $("query").value = "";
        $("search").hidden = true;
        openLayer(modal, true); $("close").focus({ preventScroll: true }); load();
      });
    },
  };
})();
