const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

let root, work, base, server, isolatedEnv;
const testToken = 'isolated-test-token-only';

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'webcc-reference-e2e-'));
  work = path.join(root, 'work');
  const home = path.join(root, 'home'), tmuxRoot = path.join(root, 'tmux');
  for (const dir of [work, home, tmuxRoot]) fs.mkdirSync(dir, { mode: 0o700 });
  isolatedEnv = { HOME: home, CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    PATH: process.env.PATH || '/usr/bin:/bin', TMUX: '', TMUX_TMPDIR: tmuxRoot,
    CC_WEB_AUTH: '1', CC_WEB_TOKEN: testToken, CC_WEB_ROOTS: work, CC_WEB_DEFAULT_DIR: work,
    CC_WEB_UPLOAD_DIR: path.join(work, '.cc-web-uploads'), CC_WEB_STORE: path.join(root, 'tabs.json'),
    CC_WEB_WORKSPACE_DB: path.join(root, 'layout.sqlite3'), CC_WEB_AGENT_RUNTIME_DIR: path.join(root, 'runtime'),
    CC_WEB_AGENT_UPDATE_DIR: path.join(root, 'updates'), CC_WEB_TERMINAL_LAUNCHER_DIR: path.join(root, 'launchers'),
    CC_WEB_CODEX_MODEL_CATALOG: '', LANG: 'C.UTF-8', TERM: 'xterm-256color', BASH_ENV: '', ENV: '' };
  // A shell-only fresh install must work even on a developer machine with CLIs.
  for (const agent of ['CODEX', 'CLAUDE', 'OPENCODE']) isolatedEnv['CC_WEB_' + agent] = path.join(root, 'not-installed', agent.toLowerCase());
  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => { const value = listener.address().port; listener.close(() => resolve(value)); });
  });
  base = `http://127.0.0.1:${port}`;
  const localPython = path.resolve(__dirname, '../../.venv/bin/python');
  const python = process.env.WEBCC_TEST_PYTHON || (fs.existsSync(localPython) ? localPython : 'python3');
  server = spawn(python, ['-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'],
    { cwd: path.resolve(__dirname, '../..'), env: isolatedEnv, stdio: 'ignore' });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('Isolated backend exited unexpectedly');
    try { if ((await fetch(base)).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Isolated backend did not start');
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 4000))]);
    if (server.exitCode === null) { server.kill('SIGKILL'); await exited; }
  }
  if (isolatedEnv) spawnSync('tmux', ['kill-server'], { env: isolatedEnv, stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 250));
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test('real API moves workspace membership without stopping a shell', async ({ page }) => {
  await page.request.post(base + '/api/login', {data:{token:testToken}});
  const config = await (await page.request.get(base + '/api/config')).json();
  expect(config.types).toEqual({ shell: true, codex: false, claude: false, opencode: false });
  for (const type of ['codex', 'claude', 'opencode']) {
    const missing = await page.request.post(base + '/api/sessions', { data: { type, cwd: work } });
    expect(missing.status(), await missing.text()).toBe(503);
  }
  const create = await page.request.post(base + '/api/sessions', {data:{type:'shell',mode:'new',cwd:work}});
  expect(create.status(), await create.text()).toBe(200);
  const session = await create.json();
  const sid = session.id;
  expect(sid).toBeTruthy();
  const a = await (await page.request.post(base + '/api/workspaces', {data:{name:'Source',cwd:work,members:[sid]}})).json();
  const b = await (await page.request.post(base + '/api/workspaces', {data:{name:'Target',cwd:work,members:[]}})).json();
  const result = await page.request.post(base + '/api/workspaces/' + a.id + '/move-session', {data:{sid,target:b.id,revision:a.revision,targetRevision:b.revision}});
  expect(result.status(),await result.text()).toBe(200);
  const value=await result.json(); expect(value.source.members).toEqual([]); expect(value.target.members).toEqual([sid]);
  const all=await (await page.request.get(base+'/api/sessions')).json();
  expect(all.sessions.find(s=>s.id===sid).alive).toBe(true);
});

test('actual browser, upload API, WebSocket, tmux and IME keep a reference and Chinese input intact', async ({ page }) => {
  const login = await page.request.post(base + '/api/login', { data: { token: testToken } });
  expect(login.status()).toBe(200);
  const create = await page.request.post(base + '/api/sessions', { data: { type: 'shell', mode: 'new', cwd: work } });
  expect(create.status(), await create.text()).toBe(200);
  await page.goto(base + '/?ui=bridge');
  await page.waitForFunction(() => window.ccWorkspace?.ready && active?.ws?.readyState === 1);
  await page.getByRole('button', { name: '上传参考文件' }).click();
  await page.locator('#reference-input').setInputFiles({ name: '参考资料.txt', mimeType: 'text/plain', buffer: Buffer.from('isolated example') });
  const response = page.waitForResponse(response => response.url().endsWith('/api/term/reference') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '上传并插入' }).click();
  const uploaded = await (await response).json();
  expect(fs.readFileSync(uploaded.path, 'utf8')).toBe('isolated example');
  expect(path.dirname(uploaded.path)).toBe(path.join(work, '.cc-web-uploads'));
  await expect(page.locator('#reference-modal')).toBeHidden();
  const text = () => page.evaluate(() => {
    const buffer = active.term.buffer.active;
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) || '').join('\n');
  });
  await expect.poll(async () => (await text()).replace(/\n/g, '')).toContain(uploaded.path);
  await page.evaluate(() => active.term.focus());
  await page.evaluate(() => {
    window.compositionWire = [];
    const socket = active.ws, original = socket.send.bind(socket);
    socket.send = value => { const item = JSON.parse(value); if (item.type === 'input') compositionWire.push(item.data); original(value); };
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 });
  await cdp.send('Input.insertText', { text: '你好' });
  for (let i = 0; i < 12; i++) {
    await cdp.send('Input.imeSetComposition', { text: 'lianxu', selectionStart: 6, selectionEnd: 6 });
    await cdp.send('Input.insertText', { text: '连续' });
  }
  await expect.poll(() => page.evaluate(() => compositionWire.join(''))).toBe('你好' + '连续'.repeat(12));
  await expect.poll(async () => (await text()).replace(/\s/g, '')).toContain('你好' + '连续'.repeat(12));
  const output = await text();
  expect(output.replace(/\n/g, '')).toContain(uploaded.path);
  expect(output).not.toContain('command not found');
  const pasted = page.waitForResponse(response => response.url().endsWith('/api/term/reference') && response.request().method() === 'POST');
  await page.evaluate(() => {
    active.term.focus();
    const data = new DataTransfer(); data.items.add(new File(['direct clipboard'], 'clipboard.csv', { type: 'text/csv' }));
    active.term.textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const second = await (await pasted).json();
  expect(fs.readFileSync(second.path, 'utf8')).toBe('direct clipboard');
  await expect(page.locator('#reference-modal')).toBeHidden();
  await expect.poll(async () => (await text()).replace(/\n/g, '')).toContain(second.path);
});
