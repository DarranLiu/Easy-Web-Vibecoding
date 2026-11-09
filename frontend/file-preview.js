"use strict";

(() => {
  const $ = id => document.getElementById(id);
  let pathSequence = 0, previewSequence = 0, pathAbort = null, textAbort = null;
  let current = null, content = null, mode = "source";
  const binary = new Set(["zip", "gz", "tgz", "7z", "rar", "tar", "bz2", "xz", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "exe", "so", "db", "sqlite", "sqlite3", "parquet", "npy", "npz", "bin"]);
  const setState = (id, text, error = false) => {
    const el = $(id); el.textContent = text; el.hidden = !text; el.classList.toggle("error", error);
  };
  function cancelPath() {
    ++pathSequence; pathAbort?.abort(); pathAbort = null;
    for (const prefix of ["files", "fv"]) {
      $(prefix + "-path-form").removeAttribute("aria-busy");
      setState(prefix + "-path-state", "");
    }
  }
  function basePath() {
    return previewOpen() && current ? current.parent || current.path.slice(0, current.path.lastIndexOf("/")) || "/" :
      filesBasePath || active?.tab?.cwd || state.defaultDir || "";
  }
  async function openPath(path, base = basePath(), prefix = previewOpen() ? "fv" : "files") {
    cancelPath();
    const seq = pathSequence, controller = new AbortController(); pathAbort = controller;
    const valid = () => seq === pathSequence && filesModalOpen();
    $(prefix + "-path-form").setAttribute("aria-busy", "true");
    setState(prefix + "-path-state", "正在打开路径");
    try {
      const item = await api("/api/fs/resolve?path=" + encodeURIComponent(path) + "&base=" + encodeURIComponent(base), { signal: controller.signal }, 0);
      if (!valid()) return;
      if (!item?.path || !["dir", "file"].includes(item.type)) throw new Error("路径信息无效，请刷新页面后重试");
      if (item.type === "dir") { closePreview(); await loadFiles(item.path); }
      else { fvList = [item]; await openPreview(0); }
      if (valid()) setState(prefix + "-path-state", "");
    } catch (error) {
      if (valid() && error.name !== "AbortError") setState(prefix + "-path-state", error.status === 404 && !error.message.includes("路径") ? "路径不存在，或后端尚未更新" : error.message, true);
    } finally {
      if (seq === pathSequence) { pathAbort = null; $(prefix + "-path-form").removeAttribute("aria-busy"); }
    }
  }
  function launch(base) {
    openFilesModal(base);
    requestAnimationFrame(() => { if (topModal() === $("files-modal")) { $("files-path-input").focus(); $("files-path-input").select(); } });
  }
  function stopMedia() {
    for (const el of $("fv-body").querySelectorAll("video,audio")) { el.pause(); el.removeAttribute("src"); el.load(); }
    $("fv-body").replaceChildren();
  }
  function close() {
    ++previewSequence; textAbort?.abort(); textAbort = null; current = null; content = null;
    cancelPath(); stopMedia(); $("fv-modes").hidden = true; setState("fv-state", "");
    $("files-modal").querySelector(".files-box").inert = false;
  }
  function failure(message, retry) {
    const el = document.createElement("div"); el.className = "fv-none";
    const text = document.createElement("p"); text.textContent = message; el.append(text);
    if (retry) {
      const button = document.createElement("button"); button.type = "button"; button.className = "btn-sm";
      button.innerHTML = uiIcon("RefreshCw") + "<span>重新读取</span>"; button.onclick = retry; el.append(button);
    }
    $("fv-body").replaceChildren(el); $("fv-body").removeAttribute("aria-busy");
  }
  function chooseModes(modes) {
    mode = modes[0]?.[0] || "source";
    $("fv-modes").replaceChildren(); $("fv-modes").hidden = modes.length < 2;
    for (const [value, label] of modes) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.dataset.mode = value;
      button.onclick = () => { mode = value; render(); }; $("fv-modes").append(button);
    }
  }
  const markdown = window.markdownit?.({ html: false, linkify: false, typographer: false });
  if (markdown) {
    // Never fetch embedded URLs or execute raw HTML from a Markdown file.
    markdown.renderer.rules.image = (tokens, index) => '<span class="fv-image-alt">' + esc(tokens[index].content || "图片") + '</span>';
    markdown.renderer.rules.link_open = (tokens, index) => {
      const href = tokens[index].attrGet("href") || "";
      if (/^https?:\/\//i.test(href)) return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">';
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return '<a>';
      return '<a href="#" data-preview-path="' + esc(href) + '">';
    };
  }
  function render() {
    if (!current || !content) return;
    stopMedia();
    for (const el of $("fv-modes").children) el.setAttribute("aria-pressed", String(el.dataset.mode === mode));
    const info = [content.encoding, content.truncated ? "前 512 KB · 内容已截断" : ""].filter(Boolean);
    let el;
    if (mode === "markdown") {
      el = document.createElement("article"); el.className = "fv-text fv-markdown";
      el.innerHTML = markdown.render(content.text);
      el.querySelectorAll("[data-preview-path]").forEach(link => {
        link.onclick = event => { event.preventDefault(); let path = link.dataset.previewPath; try { path = decodeURIComponent(path); } catch (_) {} openPath(path); };
      });
    } else if (mode === "table") {
      const result = Papa.parse(content.text, { delimiter: extOf(current.name) === "tsv" ? "\t" : ",", preview: 201, skipEmptyLines: "greedy" });
      if (result.errors.length && !content.truncated) info.push("部分行格式异常，可查看原文");
      el = document.createElement("div"); el.className = "fv-table-wrap"; el.tabIndex = 0; el.setAttribute("aria-label", "表格内容");
      const table = document.createElement("table"); table.className = "fv-table";
      const caption = document.createElement("caption"); caption.textContent = current.name; table.append(caption);
      const head = document.createElement("thead"), body = document.createElement("tbody"); table.append(head, body);
      result.data.slice(0, 201).forEach((row, index) => {
        const tr = document.createElement("tr");
        row.slice(0, 64).forEach(value => { const cell = document.createElement(index ? "td" : "th"); cell.textContent = value; if (!index) cell.scope = "col"; tr.append(cell); });
        (index ? body : head).append(tr);
      });
      if (!result.data.length) info.push("文件为空");
      if (result.meta.truncated || result.data.some(row => row.length > 64)) info.push("表格最多显示前 200 行数据、64 列");
      el.append(table);
    } else if (mode === "html") {
      const template = document.createElement("template"); template.innerHTML = content.text;
      const clean = DOMPurify.sanitize(template.content, { USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true,
        FORBID_TAGS: ["meta", "base", "link", "script", "iframe", "object", "embed", "form"],
        FORBID_ATTR: ["href", "src", "srcset", "action", "formaction", "poster", "data", "background", "ping"] });
      const container = document.createElement("div"); container.append(clean);
      el = document.createElement("iframe"); el.className = "fv-html"; el.title = "HTML 静态预览";
      el.setAttribute("sandbox", ""); el.referrerPolicy = "no-referrer";
      el.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"></head><body>' + container.innerHTML + '</body></html>';
      info.push("静态 HTML · 脚本与外部资源已禁用");
    } else {
      el = document.createElement("pre"); el.className = "fv-text"; el.tabIndex = 0;
      let text = content.text;
      if (mode === "json") {
        try { text = JSON.stringify(JSON.parse(text), null, 2); }
        catch (_) { info.push(content.truncated ? "JSON 未完整读取，显示原文" : "JSON 格式无效，显示原文"); }
      }
      el.textContent = text;
      if (!text) info.push("文件为空");
    }
    $("fv-body").append(el); $("fv-body").removeAttribute("aria-busy"); setState("fv-state", info.join(" · "));
  }
  async function open(file, index = 0, count = 1) {
    cancelPath();
    ++previewSequence; textAbort?.abort(); stopMedia();
    const seq = previewSequence; current = file; content = null;
    const valid = () => seq === previewSequence && previewOpen() && filesModalOpen();
    openLayer($("fv"), true); $("files-modal").querySelector(".files-box").inert = true;
    $("fv-name").textContent = file.name; $("fv-name").title = file.path;
    $("fv-meta").textContent = fmtBytes(file.size) + " · " + fmtTime(file.mtime) + " (" + (index + 1) + "/" + count + ")";
    $("fv-path-input").value = file.path; $("fv-dl").href = fileUrl(file.path, 0);
    $("fv-prev").disabled = index <= 0; $("fv-next").disabled = index >= count - 1;
    $("fv-parent").disabled = !file.path.includes("/");
    chooseModes([]); setState("fv-state", ""); setState("fv-path-state", "");
    $("fv-close").focus({ preventScroll: true });
    const kind = kindOf(file.name), url = fileUrl(file.path, 1), ext = extOf(file.name);
    if (["image", "video", "audio", "pdf"].includes(kind)) {
      const el = document.createElement({ image: "img", video: "video", audio: "audio", pdf: "iframe" }[kind]);
      el.className = { image: "fv-img", video: "fv-vid", audio: "fv-audio-player", pdf: "fv-pdf" }[kind];
      el.onerror = () => { if (valid()) failure("无法显示此文件：读取失败或浏览器不支持该格式", () => open(file, index, count)); };
      if (kind === "image") { el.alt = file.name; el.decoding = "async"; }
      if (kind === "video" || kind === "audio") { el.controls = true; el.preload = "metadata"; el.setAttribute("playsinline", ""); }
      if (kind === "pdf") { el.title = file.name; el.referrerPolicy = "no-referrer"; }
      el.src = url; $("fv-body").append(el); $("fv-body").removeAttribute("aria-busy"); return;
    }
    if (binary.has(ext)) { failure("此格式暂不支持在线预览，可下载原文件"); return; }
    $("fv-body").setAttribute("aria-busy", "true");
    $("fv-body").innerHTML = '<div class="gpu-loading">读取中...</div>';
    textAbort = new AbortController();
    try {
      const data = await api("/api/fs/text?path=" + encodeURIComponent(file.path), { signal: textAbort.signal }, 0);
      if (!valid()) return;
      if (typeof data?.text !== "string") throw new Error("未能读取文件内容");
      content = data;
      const views = [["source", "原文"]];
      if (["md", "markdown"].includes(ext) && markdown) views.unshift(["markdown", "预览"]);
      else if (ext === "json") views.unshift(["json", "格式化"]);
      else if (["csv", "tsv"].includes(ext) && window.Papa) views.unshift(["table", "表格"]);
      else if (["html", "htm"].includes(ext) && window.DOMPurify?.isSupported) views.unshift(["html", "静态预览"]);
      chooseModes(views); render();
    } catch (error) { if (valid() && error.name !== "AbortError") failure(error.message, () => open(file, index, count)); }
  }
  for (const prefix of ["files", "fv"]) {
    $(prefix + "-path-form").onsubmit = event => { event.preventDefault(); openPath($(prefix + "-path-input").value, basePath(), prefix); };
    $(prefix + "-path-input").onkeydown = event => { if ((event.isComposing || event.keyCode === 229) && event.key === "Enter") event.preventDefault(); };
  }
  $("fv-parent").onclick = () => { const path = basePath(); closePreview(); loadFiles(path); };
  const launchButton = document.createElement("button"); launchButton.id = "btn-path-preview"; launchButton.type = "button";
  launchButton.className = "hdr-btn"; launchButton.title = "路径预览"; launchButton.setAttribute("aria-label", "路径预览");
  launchButton.innerHTML = uiIcon("FolderSearch"); launchButton.onclick = () => launch(active?.tab?.cwd || state.defaultDir);
  $("term-header").insertBefore(launchButton, $("btn-img"));
  window.ccFilePreview = { launch, open, openPath, close, cancelPath };
})();
