"use strict";

(() => {
  if (document.documentElement.dataset.ui !== "bridge") return;
  const key = "cc_terminal_effects";
  const styleKey = "cc_terminal_style";
  const styles = { graphite: "石墨", glass: "雾色玻璃" };
  const choices = { off: "关闭", aurora: "Aurora 边缘流光", sweep: "Sweep 光标拖尾", combined: "流光与拖尾" };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const contrast = matchMedia("(forced-colors: active)");
  const transparency = matchMedia("(prefers-reduced-transparency: reduce)");
  let style = readStyle();
  let preferences = read(), mounted = null;
  function readStyle() {
    try { return localStorage.getItem(styleKey) === "glass" ? "glass" : "graphite"; }
    catch (_) { return "graphite"; }
  }
  function terminalTheme(base, mode) {
    if (contrast.matches) {
      const colors = getComputedStyle(document.body);
      return { ...base, background: colors.backgroundColor, foreground: colors.color, cursor: colors.color,
        cursorAccent: colors.backgroundColor, selectionBackground: colors.color, selectionForeground: colors.backgroundColor };
    }
    if (style !== "glass") return base;
    // Only the default background is transparent; explicit ANSI cell backgrounds stay intact.
    return mode === "dark" ? { ...base, background: "#00000000", foreground: "#dedee8", cursor: "#d7dae5", cursorAccent: "#20202e",
      selectionBackground: "#666b9166", selectionInactiveBackground: "#666b9140",
      black: "#48485b", red: "#f28b91", green: "#a5d6a7", yellow: "#e6ce91", blue: "#9dbcf3",
      magenta: "#d4ace8", cyan: "#91d5d1", white: "#d8d8e3", brightBlack: "#a0a1b5",
      brightRed: "#ffb0b4", brightGreen: "#bde8bb", brightYellow: "#f6dfae", brightBlue: "#b5cefc",
      brightMagenta: "#e8c8f5", brightCyan: "#b7e9e4", brightWhite: "#f5f5fa" }
      : { ...base, background: "#00000000", foreground: "#2e3142", cursor: "#41485c", cursorAccent: "#f4f5f8",
        selectionBackground: "#566c9c33", selectionInactiveBackground: "#566c9c22" };
  }
  function applyStyle() {
    document.documentElement.dataset.terminalStyle = style;
    const opaque = contrast.matches || transparency.matches || mqMobile.matches || !!navigator.connection?.saveData;
    document.documentElement.dataset.glassSurface = opaque ? "opaque" : "translucent";
    const mode = document.documentElement.dataset.theme || currentTheme();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = style === "glass" ? (mode === "dark" ? "#20202e" : "#eceef3") : (mode === "dark" ? "#111417" : "#e8edf0");
  }
  function refreshStyle() {
    applyStyle();
    panes.forEach(pane => { if (pane.term) pane.term.options.theme = termTheme(); });
    sync(true);
  }
  function setStyle(value) {
    style = Object.prototype.hasOwnProperty.call(styles, value) ? value : "graphite";
    try { localStorage.setItem(styleKey, style); } catch (_) {}
    refreshStyle();
  }
  function read() {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      return { effect: Object.prototype.hasOwnProperty.call(choices, value?.effect) ? value.effect : "off",
        strength: Number.isFinite(value?.strength) ? Math.max(10, Math.min(70, value.strength)) : 35 };
    } catch (_) { return { effect: "off", strength: 35 }; }
  }
  function pausedReason() {
    if (document.hidden) return "页面后台，动效暂停";
    if (contrast.matches) return "系统高对比度，动效关闭";
    if (reduced.matches) return "系统减少动态效果，使用静态效果";
    if (mqMobile.matches) return "手机使用静态效果";
    if (navigator.connection?.saveData) return "省流模式，使用静态效果";
    return "仅当前窗格";
  }
  const canAnimate = () => pausedReason() === "仅当前窗格";

  function detach(pane) {
    if (!mounted || (pane && mounted.pane !== pane)) return;
    mounted.cleanup.forEach(dispose => dispose());
    mounted.layer.remove(); mounted = null;
  }

  function cursorTrail(pane, layer, cleanup) {
    const term = pane.term, canvas = document.createElement("canvas");
    canvas.className = "cc-cursor-trail"; layer.append(canvas);
    let context;
    try { context = canvas.getContext("2d"); } catch (_) {}
    if (!context) { canvas.remove(); return false; }
    let frame = 0, lastFrame = 0, segments = [], previous = null, width = 0, height = 0, scale = 1;
    let stopped = false, suspendUntil = 0;
    function clear() {
      cancelAnimationFrame(frame); frame = 0; segments = []; previous = null;
      context.clearRect(0, 0, width, height);
    }
    function position() {
      const buffer = term.buffer.active, screen = term.element?.querySelector(".xterm-screen");
      if (!screen || buffer.viewportY !== buffer.baseY || !term.cols || !term.rows) return null;
      const box = screen.getBoundingClientRect(), host = pane.host.getBoundingClientRect();
      if (!box.width || !box.height) return null;
      return { x: box.left - host.left + (Math.min(buffer.cursorX, term.cols - 1) + .5) * box.width / term.cols,
        y: box.top - host.top + (buffer.cursorY + .5) * box.height / term.rows,
        cell: box.height / term.rows };
    }
    function resize() {
      clear();
      const box = pane.host.getBoundingClientRect(); width = box.width; height = box.height;
      if (!width || !height) return;
      // Bound decoration memory independently of terminal resolution and device DPI.
      scale = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(1500000 / (width * height)), 4096 / width, 4096 / height);
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      context.setTransform(scale, 0, 0, scale, 0, 0); previous = position();
    }
    function draw(now) {
      frame = 0;
      if (stopped || pane !== active || !canAnimate() || pane.term !== term || term.hasSelection()) { clear(); return; }
      if (now - lastFrame < 1000 / 30) { frame = requestAnimationFrame(draw); return; }
      lastFrame = now; context.clearRect(0, 0, width, height);
      segments = segments.filter(segment => now - segment.time < 220);
      for (const segment of segments) {
        const progress = Math.max(0, Math.min(1, (now - segment.time) / 220));
        const dx = segment.to.x - segment.from.x, dy = segment.to.y - segment.from.y, length = Math.hypot(dx, dy);
        if (length < 1) continue;
        const x = segment.from.x + dx * progress, y = segment.from.y + dy * progress;
        const thickness = Math.min(6, segment.to.cell * .28) * (1 - progress);
        const nx = -dy / length * thickness, ny = dx / length * thickness;
        context.globalAlpha = preferences.strength / 100 * (1 - progress) * .8;
        context.fillStyle = term.options.theme?.cursor || "#6e9bc4";
        context.beginPath(); context.moveTo(x + nx, y + ny); context.lineTo(segment.to.x, segment.to.y);
        context.lineTo(x - nx, y - ny); context.closePath(); context.fill();
      }
      context.globalAlpha = 1;
      if (segments.length) frame = requestAnimationFrame(draw);
      else context.clearRect(0, 0, width, height);
    }
    function moved() {
      if (stopped || pane !== active || !canAnimate() || performance.now() < suspendUntil || term.hasSelection() || document.activeElement !== term.textarea) { clear(); return; }
      const next = position();
      if (!next) { clear(); return; }
      if (previous) {
        const distance = Math.hypot(next.x - previous.x, next.y - previous.y);
        if (distance >= 1 && distance < Math.hypot(width, height) * .65) {
          segments.push({ from: previous, to: next, time: performance.now() }); segments = segments.slice(-8);
          if (!frame) frame = requestAnimationFrame(draw);
        }
      }
      previous = next;
    }
    resize();
    const scrolled = () => { suspendUntil = performance.now() + 300; clear(); };
    for (const subscription of [term.onCursorMove(moved), term.onScroll(scrolled), term.onResize(resize), term.onSelectionChange(clear)]) cleanup.push(() => subscription.dispose());
    pane.host.addEventListener("wheel", scrolled, { passive: true, capture: true });
    cleanup.push(() => pane.host.removeEventListener("wheel", scrolled, { capture: true }));
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    observer?.observe(pane.host);
    cleanup.push(() => { stopped = true; observer?.disconnect(); clear(); });
    return true;
  }

  function sync(force = false) {
    applyStyle();
    const pane = active?.term && active.el.isConnected ? active : null;
    const stamp = preferences.effect + ":" + preferences.strength + ":" + canAnimate() + ":" + currentTheme();
    if (!force && mounted?.pane === pane && mounted?.term === pane?.term && mounted?.stamp === stamp) return;
    detach();
    if (!pane || preferences.effect === "off" || document.hidden || contrast.matches) { updateControls(); return; }
    const layer = document.createElement("div"); layer.className = "cc-effect-layer";
    layer.setAttribute("aria-hidden", "true"); layer.dataset.motion = canAnimate() ? "active" : "static";
    layer.style.setProperty("--fx-strength", String(preferences.strength / 100));
    if (["aurora", "combined"].includes(preferences.effect)) {
      for (const edge of ["top", "right", "bottom", "left"]) {
        const el = document.createElement("i"); el.className = "cc-aurora-edge " + edge; layer.append(el);
      }
    }
    pane.host.append(layer);
    mounted = { pane, term: pane.term, stamp, layer, cleanup: [] };
    if (canAnimate() && ["sweep", "combined"].includes(preferences.effect)) mounted.trailUnavailable = !cursorTrail(pane, layer, mounted.cleanup);
    updateControls();
  }

  function setPreferences(fields) {
    preferences = { ...preferences, ...fields };
    try { localStorage.setItem(key, JSON.stringify(preferences)); } catch (_) {}
    sync(true);
  }
  function updateControls() {
    const styleSelect = document.getElementById("cc-style-select");
    if (styleSelect) styleSelect.value = style;
    const select = document.getElementById("cc-effect-select"), strength = document.getElementById("cc-effect-strength");
    if (!select || !strength) return;
    select.value = preferences.effect; strength.value = String(preferences.strength); strength.disabled = preferences.effect === "off";
    document.getElementById("cc-effect-value").textContent = preferences.strength + "%";
    document.getElementById("cc-effect-state").textContent = preferences.effect === "off" ? "已关闭" : mounted?.trailUnavailable
      ? (preferences.effect === "combined" ? "拖尾不可用，已保留流光" : "当前浏览器不支持拖尾") : pausedReason();
  }
  function mountSettings(parent) {
    const section = document.createElement("section"); section.className = "cc-appearance-settings";
    section.innerHTML = '<div class="ws-setting"><label for="cc-style-select">界面风格</label><select id="cc-style-select"></select></div><div class="ws-setting"><label for="cc-effect-select">终端动效</label><select id="cc-effect-select"></select></div><div class="ws-setting cc-effect-strength"><label for="cc-effect-strength">动效强度</label><input id="cc-effect-strength" type="range" min="10" max="70" step="5"><output id="cc-effect-value" for="cc-effect-strength"></output></div><div id="cc-effect-state" class="cc-effect-state" role="status"></div>';
    const styleSelect = section.querySelector("#cc-style-select");
    for (const [value, name] of Object.entries(styles)) { const option = document.createElement("option"); option.value = value; option.textContent = name; styleSelect.append(option); }
    styleSelect.onchange = () => setStyle(styleSelect.value);
    const select = section.querySelector("#cc-effect-select");
    for (const [value, name] of Object.entries(choices)) { const option = document.createElement("option"); option.value = value; option.textContent = name; select.append(option); }
    select.onchange = () => setPreferences({ effect: select.value });
    section.querySelector("input").oninput = event => setPreferences({ strength: Number(event.target.value) });
    parent.append(section); updateControls();
    window.ccNativeInput?.mountSettings(section);
  }
  reduced.addEventListener("change", () => sync(true));
  for (const query of [contrast, transparency, mqMobile]) query.addEventListener("change", refreshStyle);
  navigator.connection?.addEventListener?.("change", refreshStyle);
  document.addEventListener("visibilitychange", () => sync(true));
  window.addEventListener("storage", event => {
    if (event.storageArea === localStorage && (event.key === key || event.key === null)) { preferences = read(); sync(true); }
    if (event.storageArea === localStorage && (event.key === styleKey || event.key === null)) { style = readStyle(); refreshStyle(); }
  });
  window.ccAppearance = { sync, detach, mountSettings, terminalTheme };
  refreshStyle();
})();
