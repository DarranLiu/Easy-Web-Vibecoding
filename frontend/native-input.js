"use strict";

(() => {
  if (document.documentElement.dataset.ui !== "bridge") return;
  const key = "cc_terminal_input_tint", mounted = new Map();
  const contrast = matchMedia("(forced-colors: active)");
  let enabled = read();
  function read() {
    try { return localStorage.getItem(key) !== "0"; } catch (_) { return true; }
  }
  const agent = pane => pane.tab?.resumeAgent || pane.tab?.type;
  const footer = {
    codex: /\bcontext\b.*(?:\d+%|left|used)|\?\s+(?:for\s+)?shortcuts|\bfor agents\b|\btab to queue\b/i,
    claude: /bypass permissions|accept edits|shift[+\s-]*tab|\/effort\b|\?\s+(?:for\s+)?shortcuts|\((?:auto|default|plan)\)/i,
  };
  const history = /^\s*(?:(?:[↓↑]\s*)?Back to bottom\b|Earlier messages available\b)|\[\d+\/\d+\]\s*$/iu;
  const menu = /esc(?:ape)? to (?:cancel|close|go back)|enter to (?:select|confirm)|press enter|Allow (?:once|always)|Select (?:a |the )?model|Choose (?:a |the )?model|conversation is (?:open |in use )?in another app/i;
  const choice = /^(?:[›❯>]\s*)?\d+[.)]\s+(?:yes\b|no\b|allow\b|cancel\b|approve\b|proceed\b|允许|拒绝|取消|确认)/iu;

  function locate(term, kind) {
    const buffer = term.buffer.active, cursor = buffer.cursorY;
    // false is a known non-input screen; null may be an incomplete TUI redraw.
    if (!footer[kind] || term.rows < 4 || term.cols < 12 || buffer.viewportY !== buffer.baseY) return false;
    if (cursor >= term.rows) return null;
    const cache = new Map();
    const line = y => {
      if (!cache.has(y)) cache.set(y, buffer.getLine(buffer.viewportY + y)?.translateToString(true) || "");
      return cache.get(y);
    };
    const first = Math.max(0, cursor - 24), last = Math.min(term.rows, cursor + 32);
    for (const y of new Set([0, 1, term.rows - 1])) if (history.test(line(y))) return false;
    for (let y = first; y < last; y++) if (history.test(line(y))) return false;
    const prompt = kind === "codex" ? /^ {0,3}›(?:\s|$)/u : /^ {0,3}[❯>](?:\s|$)/u;
    let start = cursor;
    while (start >= first && !prompt.test(line(start))) start--;
    if (start < first || buffer.cursorX < (line(start).match(prompt)?.[0].trimEnd().length || 0)) return null;
    let end, status;
    if (kind === "claude") {
      const rule = y => {
        const text = line(y).trim();
        return text.length >= Math.max(12, Math.floor(term.cols * .65)) && /^[╭┌╰└]?[─━╌-]+[╮┐╯┘]?$/u.test(text);
      };
      if (start < 1 || !rule(start - 1)) return null;
      end = cursor + 1;
      while (end < Math.min(term.rows, start + 25) && !rule(end)) end++;
      if (end >= term.rows || !rule(end)) return null;
      status = end + 1;
      while (status < Math.min(term.rows, end + 8) && !footer.claude.test(line(status))) status++;
      if (status >= Math.min(term.rows, end + 8)) return null;
    } else {
      status = cursor + 1;
      while (status < Math.min(term.rows, start + 32) && !footer.codex.test(line(status))) status++;
      if (status >= Math.min(term.rows, start + 32)) return null;
      end = status;
      while (end > cursor + 1 && !line(end - 1).trim()) end--;
    }
    if (end - start > 24) return null;
    for (let y = Math.max(first, start - 6); y < start; y++) if (menu.test(line(y))) return false;
    for (let y = start; y < Math.min(term.rows, status + 4); y++) {
      const text = line(y);
      if ((y >= end && menu.test(text)) || choice.test(text.trimStart())) return false;
      if (y > start && y < end && text.trim() && !/^ {2,}\S/.test(text) && !buffer.getLine(buffer.viewportY + y)?.isWrapped) return null;
    }
    return { start, end, padTop: start > 0 && !line(start - 1).trim(), padBottom: end < term.rows && !line(end).trim() };
  }

  function detach(pane) {
    const item = mounted.get(pane);
    if (!item) return;
    item.dispose(); mounted.delete(pane);
  }
  function attach(pane) {
    const term = pane.term, layer = document.createElement("div");
    layer.className = "cc-input-region"; layer.hidden = true; layer.setAttribute("aria-hidden", "true");
    pane.host.insertBefore(layer, term.element);
    let timer = 0, frame = 0, invalidTimer = 0, invalidUntil = 0, lastScan = 0, pausedUntil = 0, cursorShown = true, stopped = false, touch = null;
    const cancelInvalid = () => { clearTimeout(invalidTimer); invalidTimer = 0; invalidUntil = 0; };
    const hide = () => { if (!layer.hidden) layer.hidden = true; cancelInvalid(); };
    function unsettled() {
      // Keep the last confirmed decoration through a short cursor/clear burst,
      // but never keep it indefinitely on an unknown or cursor-hidden screen.
      if (layer.hidden) return;
      if (invalidUntil && performance.now() >= invalidUntil) { hide(); return; }
      if (!invalidTimer) {
        invalidUntil = performance.now() + 120;
        invalidTimer = setTimeout(() => { invalidTimer = 0; schedule(); }, 120);
      }
    }
    function paint() {
      frame = 0; lastScan = performance.now();
      if (stopped || pane.term !== term || !pane.el.isConnected || pane.dead || document.hidden || contrast.matches
        || !enabled || pane.connectionState !== "connected" || pane.ws?.readyState !== 1
        || pane.el.classList.contains("selecting") || pane.el.classList.contains("restarting") || term.hasSelection() || lastScan < pausedUntil) { hide(); return; }
      const region = locate(term, agent(pane)), screen = term.element?.querySelector(".xterm-screen");
      if (region === false || !screen) { hide(); return; }
      if (!region || !cursorShown) { unsettled(); return; }
      const box = screen.getBoundingClientRect(), host = pane.host.getBoundingClientRect(), row = box.height / term.rows;
      if (!box.width || !row || !pane.host.getClientRects().length) { hide(); return; }
      const topPad = region.padTop ? Math.min(4, row / 4) : 0, bottomPad = region.padBottom ? Math.min(4, row / 4) : 0;
      cancelInvalid();
      const style = { left: box.left - host.left + "px", top: box.top - host.top + region.start * row - topPad + "px",
        width: box.width + "px", height: (region.end - region.start) * row + topPad + bottomPad + "px" };
      for (const [key, value] of Object.entries(style)) if (layer.style[key] !== value) layer.style[key] = value;
      const data = { start: String(region.start), end: String(region.end), agent: agent(pane) };
      for (const [key, value] of Object.entries(data)) if (layer.dataset[key] !== value) layer.dataset[key] = value;
      if (layer.hidden) layer.hidden = false;
    }
    function schedule() {
      if (stopped || timer || frame || document.hidden) return;
      // Coalesce parser/render/resize bursts; there is no idle polling loop.
      const delay = Math.max(0, pausedUntil - performance.now(), 50 - (performance.now() - lastScan));
      timer = setTimeout(() => { timer = 0; frame = requestAnimationFrame(paint); }, delay);
    }
    function pause() { hide(); pausedUntil = performance.now() + 350; schedule(); }
    const scrolled = () => { if (term.buffer.active.viewportY !== term.buffer.active.baseY) hide(); schedule(); };
    const subscriptions = [term.onWriteParsed(schedule), term.onRender(schedule), term.onResize(() => { hide(); schedule(); }),
      term.onScroll(scrolled), term.onSelectionChange(() => { if (term.hasSelection()) hide(); schedule(); }), term.onCursorMove(schedule),
      term.parser.registerCsiHandler({ prefix: "?", final: "l" }, params => { if (params.includes(25)) cursorShown = false; return false; }),
      term.parser.registerCsiHandler({ prefix: "?", final: "h" }, params => { if (params.includes(25)) cursorShown = true; return false; })];
    const wheel = event => { if (event.deltaY) pause(); };
    const touchStart = event => { const point = event.touches[0]; touch = point ? { x: point.clientX, y: point.clientY } : null; };
    const touchMove = event => { const point = event.touches[0]; if (point && touch && Math.hypot(point.clientX - touch.x, point.clientY - touch.y) > 6) pause(); };
    const touchEnd = () => { touch = null; };
    pane.host.addEventListener("wheel", wheel, { passive: true, capture: true });
    pane.host.addEventListener("touchstart", touchStart, { passive: true, capture: true });
    pane.host.addEventListener("touchmove", touchMove, { passive: true, capture: true });
    pane.host.addEventListener("touchend", touchEnd, { passive: true, capture: true });
    pane.host.addEventListener("touchcancel", touchEnd, { passive: true, capture: true });
    let size = pane.host.getBoundingClientRect();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      const next = pane.host.getBoundingClientRect();
      if (next.width !== size.width || next.height !== size.height) hide();
      size = next; schedule();
    }) : null;
    observer?.observe(pane.host);
    const item = { term, update: (invalidate = false) => {
      if (invalidate && (pane.dead || pane.connectionState !== "connected" || pane.el.classList.contains("restarting"))) hide();
      schedule();
    }, dispose: () => {
      stopped = true; clearTimeout(timer); cancelInvalid(); cancelAnimationFrame(frame); observer?.disconnect();
      subscriptions.forEach(subscription => subscription.dispose());
      pane.host.removeEventListener("wheel", wheel, { capture: true });
      for (const [event, listener] of [["touchstart", touchStart], ["touchmove", touchMove], ["touchend", touchEnd], ["touchcancel", touchEnd]]) pane.host.removeEventListener(event, listener, { capture: true });
      layer.remove();
    } };
    mounted.set(pane, item); schedule();
  }
  function sync() {
    for (const [pane, item] of mounted) if (!enabled || document.hidden || contrast.matches || !panes.includes(pane) || pane.term !== item.term || !footer[agent(pane)]) detach(pane);
    if (enabled && !document.hidden && !contrast.matches) for (const pane of panes) {
      if (!pane.term || !pane.el.isConnected || !footer[agent(pane)]) continue;
      if (!mounted.has(pane)) attach(pane);
      else mounted.get(pane).update();
    }
    const checkbox = document.getElementById("cc-input-tint"); if (checkbox) checkbox.checked = enabled;
  }
  function mountSettings(parent) {
    const row = document.createElement("div"); row.className = "ws-setting cc-input-setting";
    const label = document.createElement("label"); label.htmlFor = "cc-input-tint"; label.textContent = "原生输入区底色";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.id = "cc-input-tint"; checkbox.checked = enabled;
    checkbox.onchange = () => { enabled = checkbox.checked; try { localStorage.setItem(key, enabled ? "1" : "0"); } catch (_) {} sync(); };
    row.append(label, checkbox); parent.append(row);
  }
  contrast.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("resize", sync);
  window.addEventListener("storage", event => { if (event.storageArea === localStorage && (event.key === key || event.key === null)) { enabled = read(); sync(); } });
  window.ccNativeInput = { sync, detach, update: pane => mounted.get(pane)?.update(true), mountSettings };
  sync();
})();
