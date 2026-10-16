/* Version management does not send keystrokes or native slash commands. */
const versionNames = { codex: "Codex", claude: "Claude Code", opencode: "OpenCode" };
const updatePhases = new Set(["queued", "downloading", "extracting", "checking", "activating", "restarting"]);
const versionJobs = new Map();
let versionView = null, versionTarget = null, versionGeneration = 0, versionLoading = false, versionPollTimer = null;

function versionsOpen() { return layerOpen(document.getElementById("versions-modal")); }
function versionTargetValid() {
  return !versionTarget?.pane || (panes.includes(versionTarget.pane) && versionTarget.pane.gen === versionTarget.generation && versionTarget.pane.tab?.id === versionTarget.id);
}
function closeVersions() {
  versionGeneration++;
  closeLayer(document.getElementById("versions-modal"));
}
async function openVersions() {
  const tab = active?.tab;
  versionTarget = tab ? { id: tab.id, name: tabName(tab), pane: active, generation: active.gen } : null;
  versionView = null;
  openLayer(document.getElementById("versions-modal"), true);
  document.getElementById("versions-check").focus({ preventScroll: true });
  await loadVersions(false);
}

function renderVersions() {
  const list = document.getElementById("versions-list");
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const focusedAgent = focused?.closest('.version-row')?.dataset.agent, focusedCommand = focused?.dataset.command;
  const scroll = list.scrollTop;
  document.getElementById("versions-target").textContent = versionTarget ? "目标窗口：" + versionTarget.name : "未选择终端";
  list.setAttribute("aria-busy", String(versionLoading));
  document.getElementById("versions-check").disabled = versionLoading;
  if (!versionView) {
    list.textContent = versionLoading ? "正在读取安装与运行版本…" : "版本读取失败";
    return;
  }
  list.replaceChildren();
  for (const row of versionView.agents || []) {
    const section = document.createElement("section");
    section.className = "version-row";
    section.dataset.agent = row.agent;
    const labels = { latest: "已是官方最新版", outdated: "有新版本", newer: "安装版本较新", unknown: "版本未确认" };
    section.innerHTML = '<div class="version-heading"><strong></strong><span></span></div>' +
      '<dl class="version-grid"><div><dt>当前窗口</dt><dd></dd></div><div><dt>共享安装</dt><dd></dd></div><div><dt>官方最新</dt><dd></dd></div></dl>' +
      '<div class="version-note"></div><div class="version-actions"></div>';
    section.querySelector("strong").textContent = versionNames[row.agent];
    section.querySelector(".version-heading span").textContent = labels[row.status] || labels.unknown;
    const values = section.querySelectorAll("dd");
    values[0].textContent = row.running || (versionView.current?.agent === row.agent ? "无法读取" : "未运行");
    values[1].textContent = row.installed || "无法读取";
    values[2].textContent = row.latest || "未确认";
    const job = versionJobs.get(row.agent) || row.job;
    const superseded = !versionJobs.has(row.agent) && row.jobSuperseded;
    const busy = versionJobs.has(row.agent) || updatePhases.has(job?.phase);
    const target = versionView.resume?.agent === row.agent;
    const note = section.querySelector(".version-note");
    const messages = [];
    if (row.error) messages.push(row.error);
    if (target && !versionView.resume?.ready && versionView.resume?.reason) messages.push(versionView.resume.reason);
    if (row.running && row.installed && row.running !== row.installed) messages.push("当前窗口与安装版本不同");
    if (row.runningStatus === "outdated") messages.push("当前窗口仍在运行旧版");
    if (job?.message) {
      messages.push(superseded ? "历史更新未完成；当前安装已更新" : job.message);
      if (superseded && job.mode === "update-restart" && job.sid === versionTarget?.id) messages.push("该次会话恢复未确认");
      if (job.phase === "downloading" && job.total) messages.push(Math.round((job.received || 0) / 1048576) + " / " + Math.round(job.total / 1048576) + " MB");
    }
    note.textContent = messages.join(" · ");
    note.classList.toggle("warning", !!row.error || (!superseded && ["failed", "interrupted"].includes(job?.phase)));
    if (!messages.length) note.hidden = true;
    const actions = section.querySelector(".version-actions");
    function command(label, icon, disabled, action) {
      const button = document.createElement("button");
      button.className = "btn-sm";
      button.dataset.command = label;
      button.innerHTML = uiIcon(icon) + "<span>" + esc(label) + "</span>";
      button.disabled = disabled;
      button.onclick = action;
      actions.appendChild(button);
    }
    command("仅更新", "Download", !row.canUpdate || busy || versionLoading, () => submitVersionUpdate(row, false));
    if (target) {
      command("更新并恢复", "PackageCheck", !row.canUpdate || busy || versionLoading || !versionView.resume?.ready,
        () => submitVersionUpdate(row, true));
      command("重启并恢复", "RotateCw", busy || !(versionView.resume?.ready || versionView.resume?.canBind) || restartRequests.has(versionTarget?.id), async () => {
        if (!versionTargetValid()) { showToast("目标窗口已切换，请重新打开版本面板"); return; }
        const tab = state.tabs.find(item => item.id === versionTarget?.id);
        if (tab) await requestRestartTab(tab);
        if (versionsOpen()) await loadVersions(false);
      });
    }
    if (row.canRollback) command("回退安装", "Undo2", busy || versionLoading, () => rollbackVersion(row));
    list.appendChild(section);
  }
  list.scrollTop = scroll;
  if (focusedAgent && focusedCommand) {
    const next = Array.from(list.querySelectorAll('button')).find(button => !button.disabled &&
      button.dataset.command === focusedCommand && button.closest('.version-row').dataset.agent === focusedAgent);
    next?.focus({ preventScroll: true });
  }
  const checked = (versionView.agents || []).map(row => row.checkedAt).filter(Boolean);
  document.getElementById("versions-status").textContent = versionLoading ? "正在检测官方版本…" :
    checked.length ? "检测时间 " + new Date(Math.max(...checked) * 1000).toLocaleTimeString() : "尚未检测官方版本";
}

async function loadVersions(check) {
  const generation = ++versionGeneration, target = versionTarget;
  versionLoading = true;
  renderVersions();
  try {
    const data = check ? await api("/api/agents/versions/check", {
      method: "POST", body: JSON.stringify({ sid: target?.id || null }),
    }) : await api("/api/agents/versions" + (target ? "?sid=" + encodeURIComponent(target.id) : ""), {}, 0);
    if (generation !== versionGeneration || !versionsOpen()) return;
    versionView = data;
    for (const row of data.agents || []) {
      if (updatePhases.has(row.job?.phase)) versionJobs.set(row.agent, row.job);
    }
    scheduleVersionPoll();
  } catch (error) {
    if (generation === versionGeneration && versionsOpen()) showToast("版本检测失败 · " + error.message);
  } finally {
    if (generation === versionGeneration) { versionLoading = false; renderVersions(); }
  }
}

async function submitVersionUpdate(row, restore) {
  if (versionJobs.has(row.agent) || versionLoading) return;
  const target = versionTarget, preview = versionView?.resume;
  if (restore && (!preview?.ready || !versionTargetValid())) { showToast("目标会话已改变，请重新检测"); return; }
  versionJobs.set(row.agent, { phase: "confirming", message: "等待确认" });
  renderVersions();
  let posted = false;
  const requestId = restartRequestId();
  try {
    const major = row.installed?.split(".")[0] !== row.latest?.split(".")[0];
    if (major && !(await uiDialog({ title: "跨主版本更新", message: "原生工具可能改变会话存储格式。回退安装版本不等于回滚会话数据。确认升级至 " + row.latest + "？", okLabel: "确认升级", icon: "!" }))) return;
    const message = "将 " + versionNames[row.agent] + " 共享安装更新到 " + row.latest + "。后续网页和同一系统用户的 SSH 启动都使用新版，不重启其他现有任务。" +
      (restore ? "随后重启「" + target.name + "」，恢复原会话 " + preview.sessionId + "。这可能中断任务并丢失未发送输入，不自动发送“继续”。" : "当前运行的窗口不会重启。新建窗口使用新版。");
    if (!(await uiDialog({ title: restore ? "更新并恢复原会话" : "更新共享安装版本", message, okLabel: restore ? "更新并恢复" : "仅更新", icon: "?" }))) return;
    if (restore && (versionTarget !== target || !versionTargetValid())) { showToast("目标窗口已切换，操作已取消"); return; }
    posted = true;
    versionJobs.set(row.agent, { requestId, phase: "queued", message: "正在提交更新请求" });
    const job = await api("/api/agents/" + row.agent + "/update", { method: "POST", body: JSON.stringify({
      requestId, checkId: row.checkId, version: row.latest, confirmed: true, allowMajor: major,
      mode: restore ? "update-restart" : "update", sid: restore ? target.id : null, expected: restore ? preview.expected : null,
    }) });
    versionJobs.set(row.agent, job);
    scheduleVersionPoll();
  } catch (error) {
    showToast("更新请求未确认 · " + error.message);
    if (posted) {
      // A lost response must not trigger a second update POST.
      versionJobs.set(row.agent, { requestId, phase: "queued", message: "正在核对服务器更新状态" });
      scheduleVersionPoll();
    }
  } finally {
    if (!posted) versionJobs.delete(row.agent);
    if (versionsOpen()) renderVersions();
  }
}

function scheduleVersionPoll() {
  if (versionPollTimer || !Array.from(versionJobs.values()).some(job => updatePhases.has(job.phase))) return;
  versionPollTimer = setTimeout(pollVersionJobs, 1500);
}
async function pollVersionJobs() {
  versionPollTimer = null;
  let completed = false;
  for (const [agent, pending] of Array.from(versionJobs)) {
    if (pending.phase === "confirming") continue;
    try {
      const job = await api("/api/agents/" + agent + "/update", {}, 0);
      if (pending.requestId && job.requestId !== pending.requestId) {
        showToast("未找到此更新请求的状态，请重新检测；未自动重试");
        if (pending.sid) restartRequests.delete(pending.sid);
        versionJobs.delete(agent);
        completed = true;
        continue;
      }
      versionJobs.set(agent, job);
      if (job.phase === "restarting" && job.sid) restartRequests.set(job.sid, "restarting");
      if (!updatePhases.has(job.phase)) {
        if (job.sid) restartRequests.delete(job.sid);
        if (job.resumed && job.result) {
          const index = state.tabs.findIndex(tab => tab.id === job.sid);
          if (index !== -1) state.tabs[index] = job.result;
          const pane = paneOfTab(job.sid);
          if (pane) { pane.tab = job.result; paneHeader(pane); }
        }
        showToast(job.message || "未发现正在执行的更新，请重新检测");
        versionJobs.delete(agent);
        completed = true;
      }
    } catch (error) {
      if (versionsOpen()) document.getElementById("versions-status").textContent = "更新状态暂时不可达，正在重新核对";
    }
  }
  updateRestartControls();
  if (completed && versionsOpen()) await loadVersions(false);
  else if (versionsOpen()) renderVersions();
  scheduleVersionPoll();
}

async function rollbackVersion(row) {
  if (versionJobs.has(row.agent) || versionLoading) return;
  versionJobs.set(row.agent, { phase: "confirming", message: "等待回退确认" });
  renderVersions();
  try {
    if (!(await uiDialog({ title: "回退 " + versionNames[row.agent] + " 共享安装", message: "回退网页与同一系统用户的 SSH 共用的程序版本，不会退出运行中的窗口，也不会回滚会话数据。", okLabel: "回退安装", icon: "?" }))) return;
    const result = await api("/api/agents/" + row.agent + "/rollback", { method: "POST", body: JSON.stringify({ version: row.installed, selectionId: row.selectionId, confirmed: true }) });
    showToast(result.message);
  } catch (error) { showToast("回退失败 · " + error.message); }
  finally {
    versionJobs.delete(row.agent);
    if (versionsOpen()) await loadVersions(false);
  }
}

document.getElementById("btn-versions").onclick = openVersions;
document.getElementById("btn-versions-m").onclick = openVersions;
document.getElementById("versions-close").onclick = closeVersions;
document.getElementById("versions-check").onclick = () => { if (!versionLoading) loadVersions(true); };
document.getElementById("versions-modal").onclick = event => { if (event.target.id === "versions-modal") closeVersions(); };
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && versionsOpen() && !document.querySelector(".ui-dialog-backdrop:not(.hidden)")) closeVersions();
});
