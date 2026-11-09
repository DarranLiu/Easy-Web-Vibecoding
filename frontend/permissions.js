/* Permission changes use the exact-session restart API, never terminal input. */
(() => {
  const modal = document.getElementById("permissions-modal");
  const button = document.getElementById("btn-permissions");
  const form = document.getElementById("permissions-form");
  const apply = document.getElementById("permissions-apply");
  const refresh = document.getElementById("permissions-refresh");
  const note = document.getElementById("permissions-note");
  let target = null, preview = null, generation = 0, loading = false, submitting = false;
  const supported = tab => tab && ["codex", "claude", "opencode"].includes(tab.resumeAgent || tab.type);
  const valid = () => target && active === target.pane && panes.includes(target.pane) && target.pane.gen === target.gen && target.pane.tab?.id === target.id;
  function sync() {
    button.disabled = !supported(active?.tab) || restartRequests.has(active.tab.id);
    apply.disabled = loading || submitting || !preview?.ready || !valid() || !form.elements.length || restartRequests.has(target?.id);
    refresh.disabled = loading || submitting || !valid();
    for (const select of form.querySelectorAll("select")) select.disabled = submitting;
  }
  function close() {
    if (submitting) return;
    generation++;
    closeLayer(modal);
  }
  function selection() { return Object.fromEntries(new FormData(form).entries()); }
  function updateNote() {
    const choice = selection();
    const highRisk = choice.sandbox === "danger-full-access" || choice.mode === "bypassPermissions";
    note.classList.toggle("warning", highRisk);
    note.textContent = highRisk ? "高风险：程序可在系统用户权限内执行操作。请仅用于可信任务；组织策略仍可能限制此模式。" :
      preview?.agent === "codex" ? "仅更改此会话的审批和沙盒模式；原有额外目录授权保留。无需确认不等于解除沙盒。" :
      "仅更改此会话的权限模式；不会改写项目规则、用户设置或组织策略。首次启用某些模式仍可能需要原生确认。";
  }
  async function load() {
    if (!valid() || submitting) return;
    const ticket = ++generation;
    loading = true; preview = null; form.replaceChildren();
    document.getElementById("permissions-current").textContent = "正在读取当前会话与安装版本…";
    note.textContent = ""; note.classList.remove("warning"); sync();
    try {
      const data = await api("/api/sessions/" + target.id + "/permissions", {}, 0);
      if (ticket !== generation || !layerOpen(modal)) return;
      if (!valid()) { note.textContent = "目标窗口已变化，请关闭后重新打开"; return; }
      preview = data;
      document.getElementById("permissions-current").textContent = (data.current?.source === "native-hook" ? "当前权限：" : "启动配置：") + (data.current?.label || "未确认");
      if (!data.ready) { note.textContent = data.reason || "此窗口尚未绑定可恢复的会话，请先使用重启按钮绑定原会话"; return; }
      const names = { approval: "操作确认", sandbox: "访问范围", mode: "权限模式" };
      for (const [key, options] of Object.entries(data.options || {})) {
        const label = document.createElement("label");
        label.textContent = names[key] || key;
        const select = document.createElement("select"); select.name = key; select.id = "permission-" + key;
        const placeholder = new Option("选择模式", "", true, true); placeholder.disabled = true; select.add(placeholder);
        for (const option of options) select.add(new Option(option.label, option.value));
        const current = data.current?.values?.[key];
        if (options.some(option => option.value === current)) select.value = current;
        select.required = true; select.onchange = updateNote; label.appendChild(select); form.appendChild(label);
      }
      updateNote();
    } catch (error) {
      if (ticket === generation && layerOpen(modal)) { document.getElementById("permissions-current").textContent = "权限读取未完成"; note.textContent = error.message; }
    } finally {
      if (ticket === generation) { loading = false; sync(); }
    }
  }
  async function submit() {
    if (apply.disabled || !valid() || !form.reportValidity()) return;
    const captured = target, data = preview, permissions = selection();
    const highRisk = permissions.sandbox === "danger-full-access" || permissions.mode === "bypassPermissions";
    submitting = true; restartRequests.set(captured.id, "checking"); sync(); updateRestartControls();
    try {
      const chosen = Array.from(form.querySelectorAll("select"), select => select.selectedOptions[0].textContent).join(" · ");
      if (!(await uiDialog({ title: "更改「" + captured.name + "」的运行权限", message: chosen + "。这会重启此程序，可能中断任务并丢弃未发送输入。恢复原会话 " + data.sessionId + "，不会自动发送“继续”，也不影响其他终端。", okLabel: "确认并恢复", icon: "?" }))) return;
      if (highRisk && !(await uiDialog({ title: "确认高风险权限", message: "此模式减少或跳过权限保护，程序可能修改或删除系统用户可访问的文件。仅对这个窗口生效。", okLabel: "确认启用", destructive: true, icon: "!" }))) return;
      if (captured !== target || !valid()) { showToast("目标窗口已变化，权限修改已取消"); return; }
      restartRequests.set(captured.id, "restarting"); updateRestartControls();
      note.textContent = "正在检查兼容性并恢复原会话…";
      const restored = await api("/api/sessions/" + captured.id + "/restart", {
        method: "POST", body: JSON.stringify({ expected: data.expected, requestId: restartRequestId(), confirmed: true, confirmDangerous: highRisk, permissions }),
      }, 0);
      const index = state.tabs.findIndex(tab => tab.id === captured.id);
      if (index !== -1) state.tabs[index] = restored;
      if (valid()) { captured.pane.tab = restored; paneHeader(captured.pane); }
      showToast("权限已应用，已恢复原会话");
      submitting = false; close();
    } catch (error) {
      // Never retry a mutation after an uncertain network response.
      preview = null; form.replaceChildren();
      note.textContent = "操作未确认 · " + error.message + "。请先查看终端，再重新读取；不会自动重试。";
      note.classList.add("warning");
    } finally {
      submitting = false; restartRequests.delete(captured.id); updateRestartControls(); renderTabs(); sync();
    }
  }
  button.onclick = () => {
    if (button.disabled) return;
    target = { id: active.tab.id, name: tabName(active.tab), pane: active, gen: active.gen };
    document.getElementById("permissions-target").textContent = "目标窗口：" + target.name;
    openLayer(modal, true); document.getElementById("permissions-close").focus({ preventScroll: true }); load();
  };
  document.getElementById("permissions-close").onclick = close;
  modal.addEventListener("click", event => { if (event.target === modal) close(); });
  document.addEventListener("keydown", event => {
    if (!layerOpen(modal) || document.querySelector(".ui-dialog-backdrop")) return;
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Tab") {
      const controls = Array.from(modal.querySelectorAll("button:not(:disabled), select:not(:disabled)"));
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  form.onsubmit = event => { event.preventDefault(); submit(); };
  refresh.onclick = load; apply.onclick = submit;
  window.ccPermissions = { sync }; sync();
})();
