const { test, expect } = require('@playwright/test');
const { workspace } = require('./workspace.fixture.cjs');
const fs = require('node:fs');
const nodePath = require('node:path');

const file = (name, contents = 'synthetic reference', mimeType = 'text/plain') => ({ name, mimeType, buffer: Buffer.from(contents) });
const path = '/workspace/demo/.cc-web-uploads/unique-reference.txt';
const sentInputs = page => page.evaluate(() => sent.filter(item => item.type === 'input'));

async function setup(page, options = {}) {
  const fixture = await workspace(page);
  let uploads = 0;
  await page.route('**/api/term/reference', async route => {
    uploads++;
    if (options.onUpload) return options.onUpload(route, uploads);
    return route.fulfill({ json: { ok: true, path, size: route.request().postDataBuffer()?.length || 0 } });
  });
  await page.evaluate(() => { active.term.focus(); sent.length = 0; });
  return { fixture, uploads: () => uploads };
}
async function openUpload(page, files = [file('reference.txt')]) {
  await page.getByRole('button', { name: '上传参考文件' }).click();
  await page.locator('#reference-input').setInputFiles(files);
}
async function pasteFile(page, options = {}) {
  return page.evaluate(({ name, type, content }) => {
    const data = new DataTransfer();
    data.items.add(new File([content], name, { type }));
    return active.term.textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, { name: options.name || 'note.txt', type: options.type || 'text/plain', content: options.content || 'synthetic' });
}

test('old cached HTML can load the new input script without an upload dialog', async ({ page }) => {
  const { fixture } = await setup(page);
  const frontend = process.env.WEBCC_FRONTEND || nodePath.resolve(__dirname, '../../frontend');
  const html = fs.readFileSync(nodePath.join(frontend, 'index.html'), 'utf8')
    .replace('id="reference-modal"', 'id="old-reference-modal"')
    .replace('id="btn-reference"', 'id="old-reference-button"');
  await page.route('http://workspace.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.reload();
  await page.waitForFunction(() => window.ccWorkspace?.ready && active?.ws?.readyState === 1);
  await page.evaluate(() => { sent.length = 0; active.term.focus(); });
  await page.keyboard.type('abc');
  expect((await sentInputs(page)).map(item => item.data).join('')).toBe('abc');
  expect(fixture.errors).toEqual([]);
});

test('picker uploads a reference and inserts the path without submitting a prompt', async ({ page }) => {
  const { fixture, uploads } = await setup(page);
  await openUpload(page, [file('中文资料.txt', 'text'), file('data.csv', 'x,y')]);
  await expect(page.locator('.reference-row')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '复制路径' })).toBeHidden();
  await page.getByRole('button', { name: '上传并插入' }).click();
  await expect(page.locator('#reference-modal')).toBeHidden();
  expect(uploads()).toBe(2);
  expect((await sentInputs(page)).map(value => value.data)).toEqual([' ' + path + ' ' + path + ' ']);
  expect((await sentInputs(page)).every(value => !value.data.includes('\r') && !value.data.includes('\n'))).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test('file clipboard paste uploads directly to the focused native terminal', async ({ page }) => {
  const { uploads } = await setup(page);
  expect(await pasteFile(page)).toBe(false);
  await expect(page.locator('#reference-modal')).toBeHidden();
  expect(uploads()).toBe(1);
  expect((await sentInputs(page)).map(item => item.data)).toEqual([' ' + path + ' ']);
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
});

test('ordinary text paste and image dialog are unaffected', async ({ page }) => {
  const { uploads } = await setup(page);
  await page.evaluate(() => {
    const data = new DataTransfer(); data.setData('text/plain', '一段普通文字');
    active.term.textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  expect((await sentInputs(page)).map(item => item.data)).toEqual(['一段普通文字']);
  await page.getByRole('button', { name: '发送图片', exact: true }).click();
  await page.evaluate(() => {
    const data = new DataTransfer(); data.items.add(new File(['image'], 'demo.png', { type: 'image/png' }));
    document.getElementById('img-drop').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.img-thumb')).toHaveCount(1);
  await expect(page.locator('#reference-modal')).toBeHidden();
  expect(uploads()).toBe(0);
});

test('a file dropped into a split targets that pane, with no input in others', async ({ page }) => {
  const { fixture } = await setup(page);
  await page.evaluate(tab => { window.firstPane = active; attachTerminal(tab, makePane()); focusPane(firstPane); }, fixture.tabs[1]);
  await page.waitForFunction(() => panes.every(pane => pane.ws?.readyState === 1));
  await page.evaluate(() => {
    sent.length = 0;
    const data = new DataTransfer(); data.items.add(new File(['data'], 'readme.md', { type: 'text/markdown' }));
    panes[1].host.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#reference-modal')).toBeHidden();
  const messages = await sentInputs(page);
  expect(messages.map(item => item.data)).toEqual([' ' + path + ' ']);
  expect(await page.evaluate(() => sent.filter(item => item.type === 'input').every(item => item.socket === panes[1].ws.url))).toBe(true);
});

test('slow upload cannot insert into a different pane or changed connection', async ({ page }) => {
  const { fixture } = await setup(page, { onUpload: async route => {
    await page.evaluate(tab => { attachTerminal(tab, makePane()); }, fixture.tabs[1]);
    return route.fulfill({ json: { path } });
  } });
  await openUpload(page);
  await page.getByRole('button', { name: '上传并插入' }).click();
  await expect(page.locator('#reference-state')).toContainText('已变化');
  await expect(page.getByRole('button', { name: '复制路径' })).toBeVisible();
  await page.evaluate(() => { copyText = async value => { window.referenceCopied = value; return true; }; });
  await page.getByRole('button', { name: '复制路径' }).click();
  expect(await page.evaluate(() => referenceCopied)).toBe(path);
  expect(await sentInputs(page)).toEqual([]);
});

test('paste in the upload dialog stages files without automatically uploading', async ({ page }) => {
  const { uploads } = await setup(page);
  await page.getByRole('button', { name: '上传参考文件' }).click();
  await page.evaluate(() => {
    const data = new DataTransfer(); data.items.add(new File(['sample'], 'sample.pdf', { type: 'application/pdf' }));
    document.getElementById('reference-pick').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.reference-row')).toHaveCount(1);
  expect(uploads()).toBe(0);
  await page.getByRole('button', { name: '上传并插入' }).click();
  await expect(page.locator('#reference-modal')).toBeHidden();
  expect(uploads()).toBe(1);
});

test('clipboard images also use the file-reference flow', async ({ page }) => {
  const { uploads } = await setup(page);
  await pasteFile(page, { name: 'screen.png', type: 'image/png' });
  await expect(page.locator('#reference-modal')).toBeHidden();
  expect(uploads()).toBe(1);
  expect((await sentInputs(page)).map(item => item.data)).toEqual([' ' + path + ' ']);
});

test('connection loss during upload preserves the path and never sends it', async ({ page }) => {
  await setup(page, { onUpload: async route => {
    await page.evaluate(() => { active.ws.readyState = 0; });
    return route.fulfill({ json: { path } });
  } });
  await openUpload(page);
  await page.getByRole('button', { name: '上传并插入' }).click();
  await expect(page.locator('#reference-state')).toContainText('已变化');
  await expect(page.getByRole('button', { name: '复制路径' })).toBeVisible();
  expect(await sentInputs(page)).toEqual([]);
});

test('failed upload keeps successful files and an explicit retry uploads only the failed one', async ({ page }) => {
  const { uploads } = await setup(page, { onUpload: (route, number) => number === 2 ?
    route.fulfill({ status: 503, json: { detail: 'Offline' } }) : route.fulfill({ json: { path: path + number } }) });
  await openUpload(page, [file('first.txt'), file('second.txt')]);
  await page.getByRole('button', { name: '上传并插入' }).click();
  await expect(page.locator('#reference-state')).toContainText('Offline');
  await expect(page.locator('.reference-file-meta').first()).toContainText('已上传');
  expect(await sentInputs(page)).toEqual([]);
  await page.getByRole('button', { name: '上传并插入' }).click();
  await expect(page.locator('#reference-modal')).toBeHidden();
  expect(uploads()).toBe(3);
  expect((await sentInputs(page)).map(item => item.data)).toEqual([' ' + path + '1 ' + path + '3 ']);
});

test('closing during upload aborts and a late response cannot type into a terminal', async ({ page }) => {
  let release;
  await setup(page, { onUpload: async route => {
    await new Promise(resolve => { release = resolve; });
    try { await route.fulfill({ json: { path } }); } catch (_) {}
  } });
  await openUpload(page);
  await page.getByRole('button', { name: '上传并插入' }).click();
  await expect.poll(() => typeof release).toBe('function');
  await page.getByRole('button', { name: '关闭', exact: true }).last().click();
  await expect(page.locator('#reference-modal')).toBeHidden();
  release(); await page.waitForTimeout(200);
  expect(await sentInputs(page)).toEqual([]);
});

test('offline terminal does not upload or discard the selection', async ({ page }) => {
  const { uploads } = await setup(page);
  await openUpload(page);
  await page.evaluate(() => { active.ws.readyState = 0; });
  await page.getByRole('button', { name: '上传并插入' }).click();
  await expect(page.locator('#reference-state')).toContainText('未连接');
  await expect(page.locator('.reference-row')).toHaveCount(1);
  expect(uploads()).toBe(0);
});

test('untrusted response is not pasted as terminal input', async ({ page }) => {
  await setup(page, { onUpload: route => route.fulfill({ json: { path: '/cache/file\nrun command' } }) });
  await openUpload(page);
  await page.getByRole('button', { name: '上传并插入' }).click();
  await expect(page.locator('#reference-state')).toContainText('上传结果无效');
  expect(await sentInputs(page)).toEqual([]);
});

test('shell-sensitive paths are quoted and native bracketed-paste mode is respected', async ({ page }) => {
  await setup(page, { onUpload: route => route.fulfill({ json: { path: "/workspace/a directory/中文's.txt" } }) });
  await page.evaluate(() => new Promise(resolve => active.term.write('\x1b[?2004h', resolve)));
  await openUpload(page);
  await page.getByRole('button', { name: '上传并插入' }).click();
  await expect(page.locator('#reference-modal')).toBeHidden();
  const result = (await sentInputs(page)).map(item => item.data).join('');
  expect(result).toBe("\x1b[200~ '/workspace/a directory/中文'\\''s.txt' \x1b[201~");
  expect(result).not.toContain('\r');
});

for (const theme of ['dark', 'light']) for (const width of [320, 390, 1440]) {
  test(`${theme} file dialog fits ${width}px with many long names`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await workspace(page, theme);
    await openUpload(page, Array.from({ length: 10 }, (_, i) => file(`很长的项目附件名称_${i}_very-long-document-name-reference.pdf`)));
    await expect(page.locator('.reference-row')).toHaveCount(10);
    const fits = await page.evaluate(() => {
      const box = document.querySelector('.reference-box').getBoundingClientRect();
      const footer = document.querySelector('.reference-footer').getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth && box.left >= 0 && box.right <= innerWidth &&
        box.top >= 0 && box.bottom <= innerHeight && footer.left >= box.left && footer.right <= box.right && footer.bottom <= box.bottom;
    });
    expect(fits).toBe(true);
    await expect(page.locator('#reference-modal')).not.toHaveClass(/is-opening/);
    await page.screenshot({ path: `/tmp/webcc-v121-reference-${theme}-${width}.png` });
  });
}

test.describe('touch', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test('after uploading on mobile it does not reopen the software keyboard', async ({ page }) => {
    await setup(page);
    await openUpload(page);
    await page.getByRole('button', { name: '上传并插入' }).click();
    await expect(page.locator('#reference-modal')).toBeHidden();
    expect(await page.evaluate(() => document.activeElement === active.term.textarea)).toBe(false);
  });
  test('mobile file paste targets the same terminal without forcing the keyboard open', async ({ page }) => {
    const { uploads } = await setup(page);
    await pasteFile(page, { name: 'photo.png', type: 'image/png' });
    await expect(page.locator('#reference-modal')).toBeHidden();
    expect(uploads()).toBe(1);
    expect((await sentInputs(page)).map(item => item.data)).toEqual([' ' + path + ' ']);
    await page.evaluate(() => active.ws.onopen?.());
    expect(await page.evaluate(() => document.activeElement === active.term.textarea)).toBe(false);
  });
});
