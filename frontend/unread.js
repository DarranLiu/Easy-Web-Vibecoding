"use strict";

(() => {
  if (document.documentElement.dataset.ui !== "bridge") return;
  let context = { screens: [], panes: [] }, receipts = new Map(), fetching = false;
  let lastRefresh = 0, generation = 0, dwell = null, reading = "", receivedBaseline = false;
  const pending = new Set(), history = new Set(), retryAfter = new Map(), eligible = new Set();
  const label = "回复完成，尚未查看";
  const byId = id => document.getElementById(id);
  const isUnread = sid => receipts.has(sid) && !pending.has(receipts.get(sid).id);

  function marker(parent, count, clickable = false, sid = "") {
    if (!parent) return;
    let dot = parent.querySelector(":scope > .ws-unread-dot");
    if (!count) { dot?.remove(); parent.removeAttribute("data-unread"); return; }
    if (!dot) {
      dot = document.createElement(clickable ? "button" : "span");
      dot.className = "ws-unread-dot";
      if (clickable) {
        dot.type = "button";
        for (const type of ["pointerdown", "mousedown", "touchstart"]) dot.addEventListener(type, e => e.stopPropagation());
        dot.onclick = e => {
          e.stopPropagation();
          const receipt = receipts.get(dot.dataset.sid);
          if (receipt) acknowledge([receipt]).catch(() => showToast("已读状态未保存，请稍后重试"));
        };
      } else dot.setAttribute("role", "img");
      parent.append(dot);
    }
    dot.dataset.sid = sid;
    const title = (count > 1 ? count + " 个窗口" : "") + label + (clickable ? "，点击标为已读" : "");
    dot.title = title; dot.setAttribute("aria-label", title);
    parent.dataset.unread = String(count);
    if (clickable) dot.disabled = pending.has(receipts.get(sid)?.id);
  }

  function paint() {
    for (const screen of context.screens) {
      const count = new Set(screen.panes.filter(isUnread)).size;
      const tab = [...(byId("ws-screen-tabs")?.children || [])].find(el => el.dataset.screen === screen.id);
      marker(tab, count);
      if (tab) tab.setAttribute("aria-label", screen.name + (count ? "，" + count + " 个窗口" + label : ""));
    }
    for (const pane of context.panes) {
      const sid = pane.tab?.id || pane.savedId, unread = isUnread(sid);
      marker(pane.el.querySelector(".pane-bar"), unread ? 1 : 0, true, sid);
      pane.el.classList.toggle("ws-unread-pane", unread);
      pane.el.classList.toggle("ws-unread-paused", document.hidden);
    }
    for (const row of document.querySelectorAll(".ws-session[data-session]")) marker(row.querySelector(".ws-session-open"), isUnread(row.dataset.session) ? 1 : 0);
    const all = byId("ws-events-mark-all");
    if (all && !all.dataset.busy) all.disabled = !context.activityUnread && !receipts.size;
    scheduleRead();
  }

  function enter(pane = context.active) {
    if (!pane || pane !== context.active || document.hidden || !document.hasFocus() || topModal() || !pane.el.getClientRects().length) return;
    const receipt = receipts.get(pane.tab?.id || pane.savedId);
    // Explicit navigation acknowledges this reply, even in native history/alternate screens.
    if (receipt && Date.now() >= (retryAfter.get(receipt.id) || 0)) acknowledge([receipt]).catch(() => showToast("已读状态未保存，请稍后重试"));
  }

  function readable() {
    const pane = context.active;
    const receipt = receipts.get(pane?.tab?.id);
    if (!receipt || !eligible.has(receipt.id)) return null;
    if (document.hidden || !document.hasFocus() || topModal() || !pane?.tab || pane.ws?.readyState !== 1 || pane.dead || history.has(pane.tab.id)) return null;
    if (!pane.el.getClientRects().length || pane.term?.hasSelection()) return null;
    const buffer = pane.term?.buffer.active;
    // Alternate-screen applications own their scroll position. Never guess it.
    if (!buffer || buffer.type !== "normal" || buffer.viewportY !== buffer.baseY) return null;
    const hasOutput = Array.from({ length: pane.term.rows }, (_, i) => buffer.getLine(buffer.viewportY + i)?.translateToString(true)).some(Boolean);
    return hasOutput ? receipt : null;
  }

  function scheduleRead() {
    const receipt = readable(), key = receipt?.id || "";
    if (key === reading) return;
    clearTimeout(dwell); dwell = null; reading = key;
    if (!receipt || pending.has(key) || Date.now() < (retryAfter.get(key) || 0)) { reading = ""; return; }
    dwell = setTimeout(() => {
      dwell = null; reading = "";
      if (readable()?.id === key) acknowledge([receipt]).catch(() => {});
    }, 1200);
  }

  async function acknowledge(values) {
    const selected = values.filter(value => !pending.has(value.id));
    if (!selected.length) return;
    selected.forEach(value => pending.add(value.id));
    generation++; paint();
    try {
      for (let offset = 0; offset < selected.length; offset += 100) {
        const batch = selected.slice(offset, offset + 100);
        await api("/api/completions/ack", { method: "POST", body: JSON.stringify({ ids: batch.map(value => value.id) }) }, 0);
        for (const value of batch) if (receipts.get(value.sid)?.id === value.id) receipts.delete(value.sid);
      }
    } catch (error) {
      selected.forEach(value => retryAfter.set(value.id, Date.now() + 15000));
      throw error;
    } finally {
      selected.forEach(value => pending.delete(value.id)); generation++; paint();
    }
  }

  async function refresh(force = false) {
    if (fetching || document.hidden || tokenPromptOpen || !state.sessionsLoaded || (!force && Date.now() - lastRefresh < 5000)) return;
    fetching = true; lastRefresh = Date.now(); const version = generation;
    try {
      const data = await api("/api/completions", { cache: "no-store" }, 0);
      if (!Array.isArray(data.unread) || generation !== version) return;
      const next = new Map(data.unread.filter(value => typeof value.sid === "string" && typeof value.id === "string").map(value => [value.sid, value]));
      const focused = next.get(context.active?.tab?.id);
      if (receivedBaseline && !document.hidden && document.hasFocus() && focused && receipts.get(focused.sid)?.id !== focused.id) eligible.add(focused.id);
      receipts = next; receivedBaseline = true;
      const retained = new Set([...receipts.values()].map(value => value.id));
      for (const id of eligible) if (!retained.has(id)) eligible.delete(id);
      for (const id of retryAfter.keys()) if (!retained.has(id)) retryAfter.delete(id);
      paint();
    } catch (_) { /* Keep known receipts until a successful authoritative read. */ }
    finally { fetching = false; }
  }

  for (const type of ["wheel", "touchmove"]) document.addEventListener(type, event => {
    const pane = context.panes.find(p => p.host?.contains(event.target));
    if (pane?.tab) { history.add(pane.tab.id); scheduleRead(); }
  }, { capture: true, passive: true });
  for (const type of ["click", "keyup"]) document.addEventListener(type, event => {
    const pane = context.panes.find(pane => pane.host?.contains(event.target) ||
      event.target === pane.el.querySelector(".pane-bar") || pane.el.querySelector(".pane-name")?.contains(event.target));
    setTimeout(() => {
      if (pane) enter(pane);
      scheduleRead();
    }, 0);
  }, true);
  document.addEventListener("visibilitychange", () => { paint(); if (!document.hidden) refresh(true); });
  window.addEventListener("blur", scheduleRead);
  window.addEventListener("focus", () => { scheduleRead(); refresh(); });
  window.addEventListener("pagehide", () => { clearTimeout(dwell); reading = ""; });
  window.ccUnread = { update(value) {
    if (context.active && value.active && context.active !== value.active) {
      const receipt = receipts.get(value.active.tab?.id);
      if (receipt) eligible.add(receipt.id);
    }
    context = value; paint();
  }, refresh, paint, enter,
    markAll: () => acknowledge([...receipts.values()]) };
})();
