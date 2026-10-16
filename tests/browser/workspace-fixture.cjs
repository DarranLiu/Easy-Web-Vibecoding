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
  const layouts = {}, events = [{ id: 'event_one', sid: 'demo03', phase: 'needs_attention', time: 1800000000, seen: 0 }];
  let edit = { text: 'export const answer = 42;\n', etag: 'original', encoding: 'utf-8' };
  await page.addInitScript(({ theme, initial }) => {
    localStorage.setItem('cc_theme', theme);
    localStorage.setItem('cc_ui', 'bridge');
    if (initial) {
      localStorage.setItem('cc_panes', JSON.stringify(initial.panes));
      localStorage.setItem('cc_active_id', initial.active);
      localStorage.setItem('cc_pane_dir', initial.direction || 'auto');
      localStorage.setItem('cc_pane_fr', JSON.stringify(initial.ratios || { cols: [1, 1], rows: [1, 1, 1, 1] }));
    }
    window.sent = []; window.socketCount = 0;
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; window.socketCount++; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 5); }
      send(data) { window.sent.push({ ...JSON.parse(data), socket: this.url }); }
      close() { this.readyState = 3; }
    };
  }, { theme, initial: options.initial });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://workspace.test') return route.abort();
    const p = url.pathname, method = request.method();
    if (p.startsWith('/api/')) {
      const body = request.postDataJSON?.() || {};
      requests.push({ path: p, method, body });
      const ok = json => route.fulfill({ json });
      if (p === '/api/workspaces') {
        if (method === 'POST') { const space = { ...body, id: 'ws_new', revision: 1, pinned: false }; spaces.push(space); return ok(space); }
        return ok({ workspaces: spaces });
      }
      if (p.startsWith('/api/layouts/')) {
        if (method === 'PUT') {
          const revision = layouts[p]?.revision || 0;
          if (revision !== body.revision) return route.fulfill({ status: 409, json: { detail: 'Layout changed in another window' } });
          layouts[p] = { ...body, revision: revision + 1 };
        }
        return ok(layouts[p] || { panes: [], active: null, direction: 'auto', ratios: {}, revision: 0 });
      }
      if (/\/api\/workspaces\/[^/]+\/layout\//.test(p)) {
        if (method === 'PUT') { const revision = layouts[p]?.revision || 0; if (revision !== body.revision) return route.fulfill({ status: 409, json: { detail: 'Layout changed in another window' } }); layouts[p] = { ...body, revision: revision + 1 }; }
        return ok(layouts[p] || { panes: [], active: null, direction: 'auto', ratios: {}, revision: 0 });
      }
      if (p.startsWith('/api/workspaces/')) {
        const id = p.split('/')[3], space = spaces.find(item => item.id === id);
        if (method === 'DELETE') { spaces = spaces.filter(item => item.id !== id); return ok({ ok: true }); }
        if (space.revision !== body.revision) return route.fulfill({ status: 409, json: { detail: 'Workspace changed' } });
        Object.assign(space, body, { revision: space.revision + 1 }); return ok(space);
      }
      if (p === '/api/fleet') return ok({ sessions: tabs, events });
      if (p === '/api/fleet/ack') { events.forEach(event => { if (body.ids.includes(event.id)) event.seen = 1; }); return ok({ ok: true }); }
      if (p === '/api/config') return ok({ defaultDir: '/workspace/demo', roots: ['/workspace'], types: { shell: true, codex: true, claude: true, opencode: true } });
      if (p === '/api/sessions') {
        if (options.slowSessions) await new Promise(resolve => setTimeout(resolve, 300));
        return ok({ sessions: tabs, groups: {}, manualGroups: [] });
      }
      if (p === '/api/agents/versions') return ok({
        current: { agent: 'codex', version: '1.2.1' },
        resume: { ready: true, agent: 'codex', running: true, sessionId: '11111111-2222-4333-8444-555555555555', expected: 'synthetic-only' },
        agents: ['codex', 'claude', 'opencode'].map(agent => ({ agent, installed: '1.2.3', latest: '1.2.4',
          running: agent === 'codex' ? '1.2.1' : null, status: 'outdated', canUpdate: true,
          runningStatus: agent === 'codex' ? 'outdated' : 'unknown', checkedAt: 1800000000, job: {} })),
      });
      if (p.endsWith('/restart') && method === 'GET') return ok({ ready: true, running: true, agent: 'codex',
        sessionId: '11111111-2222-4333-8444-555555555555', expected: 'synthetic-only' });
      if (p.endsWith('/start')) {
        const tab = tabs.find(item => item.id === p.split('/')[3]);
        if (!tab) return route.fulfill({ status: 404 });
        tab.alive = true; tab.activity = { phase: 'online', source: 'native-process' };
        return ok(tab);
      }
      if (p === '/api/presence') return ok({ count: 1, strangers: 0, ips: [] });
      if (p === '/api/codex/usage') return ok({ window: { remainingPercent: 73, resetsAt: 1800000000 }, nextRefreshAt: Date.now() / 1000 + 600 });
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
    return route.fulfill({ body: fs.readFileSync(file), contentType: mime[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto('http://workspace.test/');
  await page.waitForFunction(() => window.ccWorkspace?.ready && active?.ws?.readyState === 1);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(resolve => active.term.write('API workspace\r\n\r\n\x1b[32mPASS\x1b[0m terminal history\r\n\x1b[32mPASS\x1b[0m session recovery\r\n\r\n~/workspace/demo $ npm test\r\nAll checks passed.\r\n', resolve)));
  return { errors, requests, layouts, spaces, changeFile: () => { edit.etag = 'external'; } };
}

module.exports = { workspace };
