const { workspace } = require('./workspace.fixture.cjs');

// Documentation never connects to a deployment or reads local account state.
async function documentationWorkspace(page, locale) {
  const english = locale === 'en', now = Date.now() / 1000;
  const screens = [
    { id: 'build', name: english ? 'Build' : '开发', panes: ['demo02', 'demo03', 'demo01'], active: 'demo02', direction: 'auto', ratios: {}, maximized: null },
    { id: 'review', name: english ? 'Review' : '检查', panes: ['demo04'], active: 'demo04', direction: 'auto', ratios: {}, maximized: null },
  ];
  const fixture = await workspace(page, 'dark', { deck: null, profile: 'demo',
    layouts: { '/api/layouts/desktop_user_demo': { ...screens[0], screenSchema: 1, activeScreen: 'build', screens, revision: 3 } },
  });
  const mutations = [];
  const entries = [
    { name: 'src', type: 'dir', size: 0 }, { name: 'assets', type: 'dir', size: 0 },
    { name: 'README.md', type: 'file', size: 1840 }, { name: 'index.js', type: 'file', size: 428 },
    { name: 'results.csv', type: 'file', size: 2560 }, { name: 'report.pdf', type: 'file', size: 256000 },
    { name: 'package.json', type: 'file', size: 1128 },
  ].map(item => ({ ...item, path: '/workspace/demo/' + item.name, mtime: now - 3600 }));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    if (request.method() !== 'GET') { mutations.push({ path: p, method: request.method() }); return route.fallback(); }
    const ok = json => route.fulfill({ json });
    if (p === '/api/agents/versions') return ok({
      current: { agent: 'codex', version: '1.2.1' },
      resume: { ready: true, agent: 'codex', running: true, sessionId: '11111111-2222-4333-8444-555555555555', expected: 'synthetic-only' },
      agents: ['codex', 'claude', 'opencode'].map(agent => ({ agent, installed: '1.2.3', latest: '1.2.4',
        running: agent === 'codex' ? '1.2.1' : null, status: 'outdated', canUpdate: true,
        runningStatus: agent === 'codex' ? 'outdated' : 'unknown', checkedAt: now, job: {} })),
    });
    if (p.endsWith('/restart')) return ok({ ready: true, running: true, agent: 'codex',
      sessionId: '11111111-2222-4333-8444-555555555555', expected: 'synthetic-only' });
    if (p === '/api/fs') return ok({ path: url.searchParams.get('path') || '/workspace/demo', parent: '/workspace', entries });
    if (p === '/api/fs/resolve') return ok({ ...entries.find(item => item.name === 'README.md'), parent: '/workspace/demo' });
    if (p === '/api/fs/text') return ok({ encoding: 'utf-8', truncated: false, text: english
      ? '# Project notes\n\n## Release checklist\n\n- [x] Review the API changes\n- [x] Run session recovery tests\n- [ ] Check the mobile layout\n\n| Check | Result |\n| --- | --- |\n| Layout restore | Passed |\n| Terminal input | Passed |\n\n```bash\nnpm test\n```\n'
      : '# 项目笔记\n\n## 发布检查\n\n- [x] 检查接口修改\n- [x] 运行会话恢复测试\n- [ ] 检查手机布局\n\n| 检查项目 | 结果 |\n| --- | --- |\n| 布局恢复 | 通过 |\n| 终端输入 | 通过 |\n\n```bash\nnpm test\n```\n' });
    if (p === '/api/gpu') return ok({ hosts: [{ addr: 'local', name: english ? 'Demo workstation' : '演示工作站', ok: true,
      summary: { total: 2, idle: 1, busy: 1, held: 0, mem_used: 8192, mem_total: 49152, users: [{ user: 'demo', mem: 8192, gpus: [0] }] },
      gpus: [0, 1].map(i => ({ index: i, name: 'Demo GPU 24GB', state: i ? 'idle' : 'busy', util: i ? 0 : 63,
        mem_pct: i ? 0 : 33, mem_used: i ? 0 : 8192, mem_total: 24576, temp: i ? 32 : 61, power: i ? 18 : 210,
        power_limit: 350, procs: i ? [] : [{ user: 'demo', mem: 8192, cmd: 'python', etime: '00:12:08' }] })) }] });
    if (p === '/api/disk') return ok({ hosts: [{ addr: 'local', name: english ? 'Demo workstation' : '演示工作站', ok: true,
      mounts: [{ target: '/workspace', source: '/dev/demo', size: 1024 ** 4, used: 384 * 1024 ** 3, avail: 640 * 1024 ** 3, pct: 38 }], roots: [{ path: '/workspace', total: 384 * 1024 ** 3 }] }] });
    if (p === '/api/disk/usage') return ok({ total: 384 * 1024 ** 3, at: now - 30, duration: 1.2, scanning: false,
      children: ['datasets', 'projects', 'artifacts', 'cache'].map((name, i) => ({ name, path: '/workspace/' + name, size: [192, 96, 64, 32][i] * 1024 ** 3 })) });
    if (p === '/api/ips') return ok({ ips: [
      { ip: '192.0.2.10', name: english ? 'Office laptop' : '办公电脑', trust: 'known', devices: ['Windows'], first_seen: now - 86400 * 3, last_seen: now - 30, hits: 24 },
      { ip: '198.51.100.20', name: english ? 'Phone' : '手机', trust: 'known', devices: ['iOS'], first_seen: now - 86400, last_seen: now - 1800, hits: 8 },
    ] });
    if (p === '/api/session-lookup') return ok({ query: url.searchParams.get('id'), matches: [{ key: 'demo-native', expected: 'synthetic-only',
      action: 'attach', id: 'demo02', name: 'Codex', agent: 'codex', cwd: '/workspace/demo', nativeId: '11111111-2222-4333-8444-555555555555' }] });
    return route.fallback();
  });
  return { ...fixture, mutations };
}
module.exports = { documentationWorkspace };
