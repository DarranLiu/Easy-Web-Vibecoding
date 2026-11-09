const { test, expect } = require('@playwright/test');
const path = require('node:path').posix;
const { workspace } = require('./workspace.fixture.cjs');

const texts = {
  'README.md': '# Preview workspace\n\nA small **project** with a readable file preview.\n\n| File | State |\n| --- | --- |\n| config.json | Ready |\n| data.csv | Ready |\n\n```js\nexport const ready = true;\n```\n\n[Open config](config.json)\n',
  'config.json': '{"project":"Demo","enabled":true,"items":[1,2,3]}',
  'data.csv': 'name,description,value\nAlpha,"Comma, inside",42\nBeta,"First line\nSecond line",7\n',
  'data.tsv': 'name\tvalue\nAlpha\t42',
  'index.html': '<!doctype html><html><head><style>h1{color:rgb(0,100,80)}</style></head><body><h1>Static document</h1><p>Local preview</p></body></html>',
  'script.py': 'print("hello")\n',
  'LICENSE': 'Example license text',
  'bad.json': '{invalid',
  'empty.txt': '',
  'slow.txt': 'OLD CONTENT',
  'new.txt': 'NEW CONTENT',
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setup(page, theme = 'dark', options = {}) {
  const app = await workspace(page, theme);
  const calls = [], downloads = [], external = [], networkExternal = [], blocked = [];
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://workspace.test/')) external.push(request.url()); });
  page.on('requestfailed', request => { if (request.url().startsWith('https://example.invalid/')) blocked.push(request.failure()?.errorText); });
  await page.route('https://**/*', route => { networkExternal.push(route.request().url()); return route.abort(); });
  await page.route('**/api/fs/resolve?*', async route => {
    const url = new URL(route.request().url()), raw = url.searchParams.get('path');
    calls.push({ path: raw, base: url.searchParams.get('base') });
    if (raw === 'delayed.txt') await pause(550);
    if (raw === 'missing') return route.fulfill({ status: 404, json: { detail: '路径不存在' } });
    if (raw === '/private') return route.fulfill({ status: 403, json: { detail: '目录不在允许浏览的范围内' } });
    const target = path.resolve(url.searchParams.get('base') || '/workspace/demo', raw.replace(/^~\//, '/workspace/'));
    return route.fulfill({ json: { name: path.basename(target), path: target, type: raw === 'src' ? 'dir' : 'file', parent: path.dirname(target), size: 200, mtime: 1800000000 } });
  });
  await page.route('**/api/fs/text?*', async route => {
    const name = path.basename(new URL(route.request().url()).searchParams.get('path'));
    if (name === 'slow.txt') await pause(700);
    if (options.textFailure) return route.fulfill({ status: 500, json: { detail: '读取失败' } });
    return route.fulfill({ json: { text: options.text ?? texts[name] ?? 'File content', encoding: 'utf-8', truncated: !!options.truncated } });
  });
  await page.route('**/api/fs/download?*', async route => {
    downloads.push(route.request().url());
    const name = path.basename(new URL(route.request().url()).searchParams.get('path'));
    if (name.endsWith('.png')) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH3cAAAAASUVORK5CYII=', 'base64') });
    if (options.media?.[name]) return route.fulfill(options.media[name]);
    return route.fulfill({ contentType: 'application/octet-stream', body: 'test' });
  });
  await page.locator('#btn-path-preview').click();
  await expect(page.locator('#files-modal')).toBeVisible();
  await expect(page.locator('#files-list [data-path]')).toHaveCount(2);
  await expect(page.locator('#files-path-input')).toBeFocused();
  return { ...app, calls, downloads, external, networkExternal, blocked };
}
async function openPath(page, value, prefix = 'files') {
  await page.locator('#' + prefix + '-path-input').fill(value);
  await page.locator('#' + prefix + '-path-form button[type=submit]').click();
}

test('toolbar opens current directory once; path resolves Markdown without terminal input', async ({ page }) => {
  const app = await setup(page);
  expect(app.requests.filter(r => r.path === '/api/fs')).toHaveLength(1);
  await openPath(page, 'README.md');
  await expect(page.locator('.fv-markdown h1')).toHaveText('Preview workspace');
  expect(app.calls[0]).toEqual({ path: 'README.md', base: '/workspace/demo' });
  await expect(page.locator('.fv-markdown table')).toBeVisible();
  await page.locator('#fv-modes [data-mode=source]').click();
  await expect(page.locator('#fv-body pre')).toContainText('# Preview workspace');
  await expect(page.locator('#fv-dl')).toHaveAttribute('href', /path=%2Fworkspace%2Fdemo%2FREADME.md$/);
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input'))).toEqual([]);
  expect(app.errors).toEqual([]);
});

test('file-panel path entry follows the folder currently browsed in that panel', async ({ page }) => {
  await setup(page);
  await page.locator('#files-close').click();
  await page.getByRole('tab', { name: '文件', exact: true }).click();
  await page.locator('[data-file="/workspace/demo/src"]').click();
  await page.locator('#ws-files-actions [aria-label="路径预览"]').click();
  await expect(page.locator('#files-path-input')).toHaveValue('/workspace/demo/src');
});

test('directory paths, absolute paths and parent navigation work', async ({ page }) => {
  await setup(page);
  await openPath(page, 'src');
  await expect(page.locator('#files-path-input')).toHaveValue('/workspace/demo/src');
  await expect(page.locator('#fv')).toBeHidden();
  await openPath(page, '/workspace/other/config.json');
  await expect(page.locator('#fv-body pre')).toContainText('"project": "Demo"');
  await page.locator('#fv-parent').click();
  await expect(page.locator('#fv')).toBeHidden();
  await expect(page.locator('#files-path-input')).toHaveValue('/workspace/other');
});

test('preview address is relative to previewed file, not old browser directory', async ({ page }) => {
  const app = await setup(page);
  await openPath(page, '/workspace/other/README.md');
  await expect(page.locator('.fv-markdown h1')).toBeVisible();
  await page.locator('.fv-markdown [data-preview-path]').click();
  await expect(page.locator('#fv-name')).toHaveText('config.json');
  expect(app.calls[1]).toEqual({ path: 'config.json', base: '/workspace/other' });
  await openPath(page, 'script.py', 'fv');
  await expect(page.locator('#fv-body pre')).toContainText('print');
  expect(app.calls[2].base).toBe('/workspace/other');
});

for (const [name, cells] of [['data.csv', ['Alpha', 'Comma, inside', '42', 'Beta', 'First line\nSecond line', '7']], ['data.tsv', ['Alpha', '42']]]) {
  test(`${name} uses quoted-record-aware table parser`, async ({ page }) => {
    await setup(page);
    await openPath(page, name);
    await expect(page.locator('.fv-table tbody td')).toHaveText(cells);
    await page.locator('#fv-modes [data-mode=source]').click();
    await expect(page.locator('#fv-body pre')).toHaveText(texts[name]);
  });
}

test('large table is bounded to 200 data rows and 64 columns', async ({ page }) => {
  await setup(page, 'dark', { text: Array.from({ length: 250 }, (_, i) => Array(80).fill('cell-' + i).join(',')).join('\n') });
  await openPath(page, 'large.csv');
  await expect(page.locator('.fv-table tbody tr')).toHaveCount(200);
  await expect(page.locator('.fv-table thead th')).toHaveCount(64);
  await expect(page.locator('#fv-state')).toContainText('200');
});

test('HTML preview blocks scripts, refresh, forms, same-origin access and external resources', async ({ page }) => {
  const app = await setup(page, 'dark', { text: `<html><head><meta http-equiv="refresh" content="0;url=https://example.invalid/refresh"><base href="https://example.invalid/"><link rel="stylesheet" href="https://example.invalid/style"><style>h1 { color: rgb(0,100,80) } body{background:url(https://example.invalid/css)}</style></head><body><h1>Safe preview</h1><script>parent.__previewLeaked=true;fetch('/api/sessions')</script><img src="https://example.invalid/image" onerror="parent.__previewLeaked=true"><iframe src="https://example.invalid/frame"></iframe><form action="/api/fs"><button>Submit</button></form><a href="https://example.invalid/link">Link</a></body></html>` });
  await openPath(page, 'index.html');
  const frame = page.frameLocator('iframe.fv-html');
  await expect(frame.locator('h1')).toHaveText('Safe preview');
  await expect(frame.locator('h1')).toHaveCSS('color', 'rgb(0, 100, 80)');
  await expect(frame.locator('script,form,iframe,base,link,[src],[href],[onerror]')).toHaveCount(0);
  await expect(frame.locator('meta[http-equiv="refresh"]')).toHaveCount(0);
  await expect(page.locator('iframe.fv-html')).toHaveAttribute('sandbox', '');
  expect(await page.evaluate(() => !!window.__previewLeaked)).toBe(false);
  expect(await page.locator('iframe.fv-html').evaluate(el => el.contentDocument === null)).toBe(true);
  // Chromium reports a request event even for a URL stopped before networking.
  expect(app.networkExternal).toEqual([]);
  await expect.poll(() => app.blocked.length).toBe(app.external.length);
  expect(app.blocked.every(reason => /csp/i.test(reason))).toBe(true);
  expect(app.errors).toEqual([]);
});

test('Markdown never executes HTML or loads remote images and keeps explicit external links isolated', async ({ page }) => {
  const app = await setup(page, 'dark', { text: '# Safe\n<script>window.__previewLeaked=true</script>\n![remote](https://example.invalid/image.png)\n[external](https://example.invalid/page)\n[bad](javascript:alert(1))' });
  await openPath(page, 'README.md');
  await expect(page.locator('.fv-markdown')).toContainText('<script>');
  await expect(page.locator('.fv-markdown img, .fv-markdown script')).toHaveCount(0);
  await expect(page.locator('.fv-markdown a[href^=https]')).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('.fv-markdown a[href^="javascript:"]')).toHaveCount(0);
  expect(app.external).toEqual([]);
  expect(await page.evaluate(() => !!window.__previewLeaked)).toBe(false);
});

test('image renders and common media types use inline authenticated URLs', async ({ page }) => {
  const options = { media: {} }, app = await setup(page, 'dark', options);
  const clip = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const stream = canvas.captureStream(10), recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const done = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start(); canvas.getContext('2d').fillRect(0, 0, 32, 32);
    await new Promise(resolve => setTimeout(resolve, 250)); recorder.stop(); await done;
    stream.getTracks().forEach(track => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  options.media['clip.webm'] = { contentType: 'video/webm', body: Buffer.from(clip) };
  const wav = Buffer.alloc(8044, 128);
  wav.write('RIFF'); wav.writeUInt32LE(8036, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(8000, 40);
  options.media['sound.wav'] = { contentType: 'audio/wav', body: wav };
  await openPath(page, 'picture.png');
  await expect(page.locator('.fv-img')).toBeVisible();
  await expect.poll(() => page.locator('.fv-img').evaluate(el => el.complete && el.naturalWidth > 0)).toBe(true);
  for (const [name, selector] of [['clip.webm', 'video'], ['sound.wav', 'audio'], ['paper.pdf', 'iframe.fv-pdf']]) {
    await openPath(page, name, 'fv');
    await expect(page.locator('#fv-body ' + selector)).toHaveAttribute('src', /inline=1$/);
    if (selector !== 'iframe.fv-pdf') {
      await expect(page.locator('#fv-body ' + selector)).not.toHaveAttribute('autoplay', '');
      await expect.poll(() => page.locator('#fv-body ' + selector).evaluate(el => el.readyState)).toBeGreaterThan(0);
    }
  }
  expect(app.downloads.every(url => !url.includes('token='))).toBe(true);
});

test('unsupported binary formats offer download, text without extension remains readable', async ({ page }) => {
  await setup(page);
  await openPath(page, 'report.docx');
  await expect(page.locator('.fv-none')).toContainText('暂不支持');
  await expect(page.locator('#fv-dl')).toBeVisible();
  await openPath(page, 'LICENSE', 'fv');
  await expect(page.locator('#fv-body pre')).toHaveText(texts.LICENSE);
});

test('invalid JSON and empty text are explicit; no invisible loading state remains', async ({ page }) => {
  await setup(page);
  await openPath(page, 'bad.json');
  await expect(page.locator('#fv-state')).toContainText('JSON 格式无效');
  await expect(page.locator('#fv-body pre')).toHaveText(texts['bad.json']);
  await openPath(page, 'empty.txt', 'fv');
  await expect(page.locator('#fv-state')).toContainText('文件为空');
  await expect(page.locator('#fv-body')).not.toHaveAttribute('aria-busy', 'true');
});

test('truncated files are clearly marked without claiming valid formatted JSON', async ({ page }) => {
  await setup(page, 'dark', { text: '{"partial":', truncated: true });
  await openPath(page, 'config.json');
  await expect(page.locator('#fv-state')).toContainText('内容已截断');
  await expect(page.locator('#fv-state')).toContainText('JSON 未完整读取');
});

test('missing or disallowed paths show recoverable errors; old preview remains', async ({ page }) => {
  await setup(page);
  await openPath(page, 'missing');
  await expect(page.locator('#files-path-state')).toContainText('路径不存在');
  await openPath(page, 'config.json');
  await expect(page.locator('#fv-name')).toHaveText('config.json');
  await openPath(page, '/private', 'fv');
  await expect(page.locator('#fv-path-state')).toContainText('允许浏览');
  await expect(page.locator('#fv-name')).toHaveText('config.json');
  await expect(page.locator('#fv-body pre')).toContainText('Demo');
});

test('failed text read has retry and can recover without closing preview', async ({ page }) => {
  const options = { textFailure: true };
  await setup(page, 'dark', options);
  await openPath(page, 'script.py');
  await expect(page.locator('.fv-none')).toContainText('读取失败');
  options.textFailure = false;
  await page.locator('.fv-none button').click();
  await expect(page.locator('#fv-body pre')).toHaveText(texts['script.py']);
});

test('slow old file cannot overwrite newer preview', async ({ page }) => {
  const app = await setup(page);
  await openPath(page, 'slow.txt');
  await expect(page.locator('#fv-name')).toHaveText('slow.txt');
  await openPath(page, 'new.txt', 'fv');
  await expect(page.locator('#fv-body pre')).toHaveText('NEW CONTENT');
  await page.waitForTimeout(850);
  await expect(page.locator('#fv-body pre')).toHaveText('NEW CONTENT');
  expect(app.errors).toEqual([]);
});

test('closing files cancels resolver and never resurrects hidden preview', async ({ page }) => {
  const app = await setup(page);
  await openPath(page, 'delayed.txt');
  await page.locator('#files-close').click();
  await page.waitForTimeout(700);
  await expect(page.locator('#files-modal')).toBeHidden();
  await expect(page.locator('#fv')).toBeHidden();
  expect(app.errors).toEqual([]);
});

test('file list next/previous and address arrow keys do not conflict; close restores focus', async ({ page }) => {
  const app = await setup(page);
  await page.locator('#files-list [data-type=file]').click();
  await expect(page.locator('#fv-name')).toHaveText('index.js');
  await expect(page.locator('#fv-next')).toBeDisabled();
  await page.locator('#fv-path-input').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#fv-name')).toHaveText('index.js');
  await page.keyboard.press('Escape');
  await expect(page.locator('#fv')).toBeHidden();
  await expect(page.locator('#files-modal')).toBeVisible();
  expect(await page.locator('.files-box').evaluate(el => el.inert)).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.locator('#files-modal')).toBeHidden();
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input'))).toEqual([]);
  expect(app.errors).toEqual([]);
});

test('arrow keys scroll focused table and source text instead of switching files', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    fvList = ['script.py', 'data.csv', 'README.md'].map(name => ({ name, path: '/workspace/demo/' + name, type: 'file', size: 100 }));
    void openPreview(1);
  });
  await page.locator('.fv-table-wrap').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#fv-name')).toHaveText('data.csv');
  await page.locator('#fv-modes [data-mode=source]').click();
  await page.locator('#fv-body pre').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#fv-name')).toHaveText('data.csv');
});

test('IME Enter does not submit unfinished path', async ({ page }) => {
  const app = await setup(page);
  await page.locator('#files-path-input').fill('README.md');
  const prevented = await page.locator('#files-path-input').evaluate(el => !el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
  expect(prevented).toBe(true);
  expect(app.calls).toEqual([]);
});

test('previous-file navigation cancels an older pending path lookup', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    fvList = ['one.txt', 'two.txt'].map(name => ({ name, path: '/workspace/demo/' + name, type: 'file', size: 10 }));
    void openPreview(1);
  });
  await expect(page.locator('#fv-name')).toHaveText('two.txt');
  await openPath(page, 'delayed.txt', 'fv');
  await page.locator('#fv-prev').click();
  await expect(page.locator('#fv-name')).toHaveText('one.txt');
  await page.waitForTimeout(650);
  await expect(page.locator('#fv-name')).toHaveText('one.txt');
});

test('late resolver cannot replace the last submitted path', async ({ page }) => {
  await setup(page);
  await openPath(page, 'delayed.txt');
  await openPath(page, 'config.json');
  await expect(page.locator('#fv-name')).toHaveText('config.json');
  await page.waitForTimeout(650);
  await expect(page.locator('#fv-name')).toHaveText('config.json');
});

test('directory response behind direct preview preserves navigation and returns to a working list', async ({ page }) => {
  const app = await setup(page);
  await page.route('**/api/fs?*', async route => {
    await pause(600);
    return route.fulfill({ json: { path: '/workspace/demo', entries: ['one.txt', 'two.txt'].map(name => ({ name, path: '/workspace/demo/' + name, type: 'file', size: 10 })) } });
  });
  await page.locator('#files-reload').click();
  await openPath(page, 'README.md');
  await expect(page.locator('.fv-markdown')).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.locator('#fv-next')).toBeDisabled();
  await expect(page.locator('#fv-name')).toHaveText('README.md');
  await page.locator('#fv-close').click();
  await expect(page.locator('#files-list [data-type=file]')).toHaveCount(2);
  await page.locator('#files-list [data-type=file]').first().click();
  await expect(page.locator('#fv-name')).toHaveText('one.txt');
  await page.locator('#fv-next').click();
  await expect(page.locator('#fv-name')).toHaveText('two.txt');
  await page.locator('#fv-prev').click();
  await expect(page.locator('#fv-name')).toHaveText('one.txt');
  expect(app.errors).toEqual([]);
});

test('direct relative preview uses requested directory even before slow listing completes', async ({ page }) => {
  const app = await setup(page);
  await page.locator('#files-close').click();
  await page.route('**/api/fs?*', async route => {
    await pause(650);
    return route.fulfill({ json: { path: '/workspace/other', entries: [] } });
  });
  await page.evaluate(() => ccFilePreview.launch('/workspace/other'));
  await expect(page.locator('#files-path-input')).toHaveValue('/workspace/other');
  await openPath(page, 'config.json');
  await expect(page.locator('#fv-name')).toHaveText('config.json');
  expect(app.calls[0].base).toBe('/workspace/other');
  await page.waitForTimeout(700);
  await expect(page.locator('#fv-name')).toHaveText('config.json');
});

for (const [width, theme] of [[1440, 'dark'], [1440, 'light'], [390, 'dark'], [320, 'light']]) {
  test(`path preview fits ${width}px ${theme} with visible controls`, async ({ page }) => {
    await page.setViewportSize({ width, height: width > 820 ? 900 : 780 });
    const app = await setup(page, theme);
    await openPath(page, 'README.md');
    await expect(page.locator('.fv-markdown h1')).toBeVisible();
    await expect(page.locator('#fv')).not.toHaveClass(/is-opening/);
    await expect(page.locator('#files-modal')).not.toHaveClass(/is-opening/);
    for (const selector of ['#fv-path-input', '#fv-parent', '#fv-close', '#fv-dl', '#fv-modes']) {
      const rect = await page.locator(selector).boundingBox();
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width + 1);
      expect(rect.height).toBeGreaterThan(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/webcc-v112-preview-${theme}-${width}.png` });
    if (process.env.WEBCC_AXE) {
      const AxeBuilder = require(process.env.WEBCC_AXE).default;
      const report = await new AxeBuilder({ page }).include('#fv').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      expect(report.violations).toEqual([]);
    }
    expect(app.errors).toEqual([]);
  });
}
