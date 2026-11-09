const fs = require('node:fs');
const path = require('node:path');
const frontend = process.env.WEBCC_FRONTEND || path.resolve(__dirname, '../../frontend');

async function workspace(page, theme = 'dark', options = {}) {
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  const tabs = [
    { id: 'demo01', name: 'API workspace', cwd: '/workspace/demo', type: 'shell', alive: true, activity: { phase: 'online', source: 'tmux' } },
    { id: 'demo02', name: 'Codex', cwd: '/workspace/demo', type: 'codex', alive: true, codexScrollback: true, activity: { phase: 'working', source: 'codex-event' } },
    { id: 'demo03', name: 'Claude Code', cwd: '/workspace/tools', type: 'claude', alive: true, activity: { phase: 'needs_attention', source: 'claude-hook' } },
    { id: 'demo04', name: 'OpenCode', cwd: '/workspace/demo', type: 'opencode', alive: true, activity: { phase: 'online', source: 'native-process' } },
  ];
  tabs.push(...(options.extraTabs || []));
  let spaces = [
    { id: 'ws_demo', name: 'API workspace', cwd: '/workspace/demo', members: ['demo01', 'demo02', 'demo04'], pinned: false, revision: 1 },
    { id: 'ws_tools', name: 'Tools', cwd: '/workspace/tools', members: ['demo03'], pinned: false, revision: 1 },
  ];
  spaces.push(...(options.extraSpaces || []));
  const layouts = options.layouts || {}, events = [{ id: 'event_one', sid: 'demo03', phase: 'needs_attention', time: 1800000000, seen: 0 }];
  let edit = { text: 'export const answer = 42;\n', etag: 'original', encoding: 'utf-8' };
  await page.addInitScript(({ theme, initial, profile, identity, journal, deck }) => {
    if (window.top !== window) return;
    localStorage.setItem('cc_theme', theme);
    localStorage.setItem('cc_ui', 'bridge');
    // Most workflow tests exercise the inspector. Production now defaults closed.
    if (deck !== null) localStorage.setItem('cc_workspace_deck', deck === false ? '0' : '1');
    if (profile) localStorage.setItem('cc_layout_user', profile);
    if (identity) localStorage.setItem('cc_workspace_device', identity);
    if (journal) localStorage.setItem('cc_screens_recovery_' + journal.device, JSON.stringify(journal.value));
    if (initial) {
      localStorage.setItem('cc_panes', JSON.stringify(initial.panes));
      localStorage.setItem('cc_active_id', initial.active);
      localStorage.setItem('cc_pane_dir', initial.direction || 'auto');
      localStorage.setItem('cc_pane_fr', JSON.stringify(initial.ratios || { cols: [1, 1], rows: [1, 1, 1, 1] }));
    }
    window.sent = []; window.socketCount = 0; window.sockets = [];
    window.WebSocket = class {
      constructor(url) {
        this.url = url; this.readyState = 0; window.socketCount++; window.sockets.push(this);
        setTimeout(() => {
          if (this.readyState !== 0 || window.holdSockets) return;
          this.readyState = 1; this.onopen?.();
          if (window.socketFrame) this.onmessage?.({ data: new TextEncoder().encode(window.socketFrame).buffer });
        }, 5);
      }
      send(data) { window.sent.push({ ...JSON.parse(data), socket: this.url }); }
      close() { this.readyState = 3; }
    };
  }, { theme, initial: options.initial, profile: options.profile, identity: options.identity, journal: options.journal, deck: options.deck });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://workspace.test') return route.abort();
    const p = url.pathname, method = request.method();
    if (p.startsWith('/api/')) {
      const body = request.postDataJSON?.() || {};
      requests.push({ path: p, method, body });
      const ok = json => route.fulfill({ json });
      if (p.startsWith('/api/layout-binding/')) {
        if (!options.tokenBindings) return ok({ enabled: false });
        if (options.bindingReadFailure) return route.fulfill({ status: 503, json: { detail: 'Binding offline' } });
        const key = (options.tokenKey || 'test-token') + ':' + p.split('/').pop();
        const binding = options.tokenBindings[key] || { enabled: true, device: null, revision: 0 };
        if (method === 'PUT') {
          if (binding.revision !== body.revision) return route.fulfill({ status: 409, json: { detail: 'Binding changed' } });
          options.tokenBindings[key] = { enabled: true, device: body.device, revision: binding.revision + 1 };
        }
        return ok(options.tokenBindings[key] || binding);
      }
      if (p === '/api/workspaces') {
        if (options.workspacesFailure) return route.fulfill({ status: 503, json: { detail: 'Workspace metadata offline' } });
        if (method === 'POST') { const space = { ...body, id: 'ws_new', revision: 1, pinned: false }; spaces.push(space); return ok(space); }
        return ok({ workspaces: spaces });
      }
      if (p === '/api/layouts') return ok({ layouts: Object.entries(layouts).filter(([key]) => key.startsWith('/api/layouts/' + (url.searchParams.get('kind') || 'desktop') + '_')).map(([key, value]) => ({ device: key.split('/').pop(), screenNames: (value.screens || [value]).map(s => s.name || 'Screen 1'), screenCount: (value.screens || [value]).length, paneCount: (value.screens || [value]).reduce((n, s) => n + s.panes.length, 0) })) });
      if (p.startsWith('/api/layouts/')) {
        if (method === 'GET' && options.layoutReadFailure) return route.fulfill({ status: options.layoutReadFailure, json: { detail: 'Layout offline' } });
        if (method === 'PUT') {
          const revision = layouts[p]?.revision || 0;
          const last = layouts[p]?.write, same = last && body.writer === last.writer;
          if (same && body.sequence <= last.sequence) return ok(layouts[p]);
          if (revision !== body.revision && !(same && body.revision === last.baseRevision)) return route.fulfill({ status: 409, json: { detail: 'Layout changed in another window' } });
          const { writer, sequence, ...value } = body;
          layouts[p] = { ...value, revision: revision + 1, ...(writer ? { write: { writer, sequence, baseRevision: body.revision } } : {}) };
        }
        return ok({ screenSchema: 1, ...(layouts[p] || { panes: [], active: null, direction: 'auto', ratios: {}, revision: 0 }) });
      }
      if (/\/api\/workspaces\/[^/]+\/layout\//.test(p)) {
        if (method === 'PUT') { const revision = layouts[p]?.revision || 0; if (revision !== body.revision) return route.fulfill({ status: 409, json: { detail: 'Layout changed in another window' } }); layouts[p] = { ...body, revision: revision + 1 }; }
        return ok(layouts[p] || { panes: [], active: null, direction: 'auto', ratios: {}, revision: 0 });
      }
      if (p.endsWith('/move-session')) {
        const source = spaces.find(item => item.id === p.split('/')[3]), target = spaces.find(item => item.id === body.target);
        if (options.moveFailure) return route.fulfill({status: 409, json: {detail: 'Membership changed'}});
        if (!target || target.revision !== body.targetRevision || (source && source.revision !== body.revision)) return route.fulfill({status: 409});
        if (source) { source.members = source.members.filter(id => id !== body.sid); source.revision++; }
        if (!target.members.includes(body.sid)) target.members.push(body.sid);
        target.revision++;
        return ok({source: source || null, target});
      }
      if (p.endsWith('/activate')) {
        const space = spaces.find(item => item.id === p.split('/')[3]);
        space.lastUsed = Date.now() / 1000; return ok({ id: space.id, lastUsed: space.lastUsed });
      }
      if (p.startsWith('/api/workspaces/')) {
        const id = p.split('/')[3], space = spaces.find(item => item.id === id);
        if (method === 'DELETE') { spaces = spaces.filter(item => item.id !== id); return ok({ ok: true }); }
        if (space.revision !== body.revision) return route.fulfill({ status: 409, json: { detail: 'Workspace changed' } });
        Object.assign(space, body, { revision: space.revision + 1 }); return ok(space);
      }
      if (p === '/api/fleet') return ok({ sessions: tabs, events });
      if (p === '/api/completions') return ok({ unread: options.completions || [] });
      if (p === '/api/completions/ack') {
        if (options.completionAckFailure) return route.fulfill({ status: 503, json: { detail: 'Offline' } });
        options.completions = (options.completions || []).filter(value => !body.ids.includes(value.id));
        return ok({ ok: true });
      }
      if (p === '/api/fleet/ack') { events.forEach(event => { if (body.ids.includes(event.id)) event.seen = 1; }); return ok({ ok: true }); }
      if (p === '/api/config') return ok({ defaultDir: '/workspace/demo', roots: ['/workspace'], types: { shell: true, codex: true, claude: true, opencode: true } });
      if (p === '/api/sessions') {
        if (method === 'POST') {
          if (options.createDelay) await new Promise(resolve => setTimeout(resolve, options.createDelay));
          if (options.failCreation) return route.fulfill({ status: 500, json: { detail: 'Create failed safely' } });
          const tab = { ...body, id: 'new001', title: 'New terminal', alive: true };
          tabs.push(tab); return ok(tab);
        }
        if (options.slowSessions) await new Promise(resolve => setTimeout(resolve, 300));
        return ok({ sessions: tabs, groups: {}, manualGroups: [] });
      }
      if (p.endsWith('/rename')) {
        if (options.renameDelay) await new Promise(resolve => setTimeout(resolve, options.renameDelay));
        if (options.renameFailure) return route.fulfill({ status: 500, json: { detail: 'Rename failed safely' } });
        const tab = tabs.find(item => item.id === p.split('/')[3]);
        if (!tab) return route.fulfill({ status: 404 });
        tab.name = body.name;
        return ok({ ok: true, name: tab.name });
      }
      if (p.endsWith('/identity')) {
        if (options.identityDelay) await new Promise(resolve => setTimeout(resolve, options.identityDelay));
        if (options.identityFailure) return route.fulfill({ status: options.identityFailure, json: { detail: '尚未识别到原生会话 ID' } });
        const tab = tabs.find(item => item.id === p.split('/')[3]);
        if (!tab) return route.fulfill({ status: 404, json: { detail: 'Window removed' } });
        const value = tab.type === 'shell' ? 'cc_' + tab.id : tab.type === 'opencode' ? 'ses_123456789abcdef' :
          tab.type === 'claude' ? '12345678-1234-4234-8234-123456789abc' : '87654321-1234-4234-8234-123456789abc';
        return ok({ id: tab.id, value, agent: tab.type, kind: tab.type === 'shell' ? 'window' : 'native',
          state: tab.alive ? 'running' : 'stopped', ...options.identityResult });
      }
      if (p.endsWith('/permissions')) {
        if (options.permissionDelay) await new Promise(resolve => setTimeout(resolve, options.permissionDelay));
        const tab = tabs.find(item => item.id === p.split('/')[3]);
        const codex = tab.type === 'codex';
        const groups = codex ? { approval: ['on-request', 'never'], sandbox: ['read-only', 'workspace-write', 'danger-full-access'] } :
          { mode: ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'] };
        return ok(options.permissionPreview || { ready: tab.type !== 'opencode', agent: tab.type, running: true,
          expected: 'permission-challenge-' + tab.id, sessionId: '12345678-1234-4234-8234-123456789abc',
          reason: tab.type === 'opencode' ? 'OpenCode 权限暂不在网页中覆盖' : undefined,
          current: { values: codex ? { approval: 'on-request', sandbox: 'workspace-write' } : { mode: 'plan' }, label: codex ? '按需确认 · 工作目录可写' : '计划模式' },
          options: Object.fromEntries(Object.entries(groups).map(([key, choices]) => [key, choices.map(value => ({ value, label: value }))])) });
      }
      if (p.endsWith('/restart') && method === 'POST') {
        if (options.permissionFailure) return route.abort();
        const tab = tabs.find(item => item.id === p.split('/')[3]);
        return ok({ ...tab, resumed: true });
      }
      if (p.endsWith('/restart')) return ok({ ready: true, running: false, stopped: true,
        expected: 'saved-challenge', sessionId: '12345678-1234-4234-8234-123456789abc' });
      if (p.endsWith('/start')) {
        const tab = tabs.find(item => item.id === p.split('/')[3]);
        if (!tab) return route.fulfill({ status: 404 });
        tab.alive = true; tab.activity = { phase: 'online', source: 'native-process' };
        return ok(tab);
      }
      if (p.endsWith('/restore') && method === 'POST') {
        const tab = tabs.find(item => item.id === p.split('/')[3]);
        if (!tab) return route.fulfill({ status: 404 });
        if (options.restoreFailure === tab.id) return route.abort();
        tab.continuity = { ...tab.continuity, eligible: false, state: 'queued', message: '等待恢复' };
        if (options.restoreDelay) await new Promise(resolve => setTimeout(resolve, options.restoreDelay));
        return ok({ state: 'queued' });
      }
      if (p === '/api/presence') return ok({ count: 1, strangers: 0, ips: [] });
      if (p === '/api/codex/usage') {
        if (options.usageDelay) await new Promise(resolve => setTimeout(resolve, options.usageDelay));
        if (options.usageError) return route.fulfill({ status: 503, json: { detail: 'Usage unavailable' } });
        return ok(options.usage || { window: { remainingPercent: 73, resetsAt: Date.now() / 1000 + 4 * 86400 + 21 * 3600 }, nextRefreshAt: Date.now() / 1000 + 600 });
      }
      if (p === '/api/fs') return ok({ path: url.searchParams.get('path') || '/workspace/demo', parent: '/workspace/demo', entries: [{ name: 'src', path: '/workspace/demo/src', type: 'dir' }, { name: 'index.js', path: '/workspace/demo/index.js', type: 'file' }] });
      if (p === '/api/fs/edit') {
        if (method === 'PUT') { if (body.etag !== edit.etag) return route.fulfill({ status: 409, json: { detail: 'File was changed by another editor' } }); edit = { ...edit, text: body.text, etag: 'saved' }; }
        return ok(edit);
      }
      if (p === '/api/git/status') return ok({ root: '/workspace/demo', branch: 'main', changes: [{ path: 'index.js', status: ' M' }] });
      if (p === '/api/git/diff') return ok({ text: '@@ -1 +1 @@\n-old\n+new\n', truncated: false });
      if (p.endsWith('/history')) return ok({ matches: [{ line: 28, text: 'PASS terminal history' }], total: 1, lines: 300, truncated: false });
      return ok({});
    }
    const file = path.resolve(frontend, '.' + (p === '/' ? '/index.html' : p));
    if (!file.startsWith(frontend + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
    const mime = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    if (p === '/' || p === '/index.html') Object.assign(headers, {
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
    });
    return route.fulfill({ body: fs.readFileSync(file), contentType: mime[path.extname(file)] || 'application/octet-stream', headers });
  });
  await page.goto(options.url || 'http://workspace.test/');
  await page.waitForFunction(allowEmpty => window.ccWorkspace?.ready && (allowEmpty || active?.ws?.readyState === 1), !!options.allowEmpty);
  // Screen restoration and workspace metadata are independent requests.
  if (!options.workspacesFailure) await page.waitForFunction(() => window.ccWorkspace?.current);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(resolve => active?.term ? active.term.write('API workspace\r\n\r\n\x1b[32mPASS\x1b[0m terminal history\r\n\x1b[32mPASS\x1b[0m session recovery\r\n\r\n~/workspace/demo $ npm test\r\nAll checks passed.\r\n', resolve) : resolve()));
  return { errors, requests, layouts, spaces, tabs, changeFile: () => { edit.etag = 'external'; } };
}

module.exports = { workspace };
