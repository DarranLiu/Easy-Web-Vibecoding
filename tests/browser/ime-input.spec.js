const { test, expect } = require('@playwright/test');
const { workspace } = require('./workspace.fixture.cjs');

async function setup(page) {
  await workspace(page);
  await page.evaluate(() => {
    active.term.focus(); sent.length = 0; window.imeEvents = [];
    for (const type of ['keydown', 'keypress', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend']) {
      active.term.textarea.addEventListener(type, event => imeEvents.push({ type, inputType: event.inputType,
        data: event.data, composing: event.isComposing, key: event.key, code: event.keyCode, canceled: event.defaultPrevented }), true);
    }
  });
  return page.context().newCDPSession(page);
}
async function compose(cdp, input, commit) {
  await cdp.send('Input.imeSetComposition', { text: input, selectionStart: input.length, selectionEnd: input.length });
  await cdp.send('Input.insertText', { text: commit });
}
const inputs = page => page.evaluate(() => sent.filter(item => item.type === 'input').map(item => item.data).join(''));

test('non-cancelable commit survives when the next composition starts before timers', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const ta = active.term.textarea;
    ta.value = '';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true }));
    ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '中文', bubbles: true, composed: true }));
    ta.value = '中文';
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '中文', bubbles: true, composed: true }));
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    ta.value = '中文输入';
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '输入' }));
  });
  await page.waitForTimeout(40);
  expect(await inputs(page)).toBe('中文输入');
});

test('input-only text commit is not lost behind xterm keydown guard', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const ta = active.term.textarea;
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 0, bubbles: true }));
    ta.value = '已确认';
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '已确认', bubbles: true, composed: true }));
  });
  expect(await inputs(page)).toBe('已确认');
});

test('real browser composition commits every Chinese character exactly once', async ({ page }) => {
  const cdp = await setup(page);
  await compose(cdp, 'nihao', '你好');
  await page.waitForTimeout(50);
  expect(await inputs(page)).toBe('你好');
});

test('rapid successive composition commits keep their ordering', async ({ page }) => {
  const cdp = await setup(page);
  await compose(cdp, 'ni', '你');
  await compose(cdp, 'hao', '好');
  await compose(cdp, 'shijie', '世界');
  await page.waitForTimeout(50);
  expect(await inputs(page)).toBe('你好世界');
});

test('IME keypress cannot swallow a committed insertText', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const ta = active.term.textarea;
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, which: 229, bubbles: true, cancelable: true, isComposing: true }));
    ta.dispatchEvent(new KeyboardEvent('keypress', { key: 'Process', keyCode: 229, which: 229, bubbles: true, cancelable: true, isComposing: true }));
    ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '汉字', bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(50);
  expect(await inputs(page)).toBe('汉字');
});

test('an unrelated handled keypress never suppresses a later IME commit', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const ta = active.term.textarea;
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, which: 229, bubbles: true, cancelable: true }));
    ta.dispatchEvent(new KeyboardEvent('keypress', { key: 'x', charCode: 120, keyCode: 120, which: 120, bubbles: true, cancelable: true }));
    ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '中文', bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(30);
  expect(await inputs(page)).toBe('x中文');
});

test('ordinary typing, punctuation and CJK commits do not duplicate each other', async ({ page }) => {
  const cdp = await setup(page);
  await page.keyboard.type('abc,');
  await compose(cdp, 'zhongwen', '中文');
  await page.waitForTimeout(30);
  await page.keyboard.type('.xyz');
  expect(await inputs(page)).toBe('abc,中文.xyz');
});

test('ordinary spaces and repeated spaces are sent exactly once', async ({ page }) => {
  const cdp = await setup(page);
  await page.keyboard.type('manual input  with   spaces');
  await compose(cdp, 'zhongwen', '中文');
  await page.keyboard.type(' next');
  expect(await inputs(page)).toBe('manual input  with   spaces中文 next');
});

test('a process key and mobile insertText preserve punctuation', async ({ page }) => {
  const cdp = await setup(page);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'Process', windowsVirtualKeyCode: 229 });
  await cdp.send('Input.insertText', { text: '，' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: 'Process', windowsVirtualKeyCode: 229 });
  await page.waitForTimeout(30);
  expect(await inputs(page)).toBe('，');
});

test('terminal redraw during an active composition does not lose the committed text', async ({ page }) => {
  const cdp = await setup(page);
  await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
  await page.evaluate(() => new Promise(resolve => active.term.write('\x1b[2J\x1b[Hsynthetic output', resolve)));
  await cdp.send('Input.insertText', { text: '中文' });
  await page.waitForTimeout(30);
  expect(await inputs(page)).toBe('中文');
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
});

for (const composingFlag of [true, false]) {
  test(`confirming an IME candidate never submits when isComposing=${composingFlag}`, async ({ page }) => {
    const cdp = await setup(page);
    await cdp.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 });
    await page.evaluate(flag => active.term.textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, isComposing: flag, bubbles: true, cancelable: true,
    })), composingFlag);
    await cdp.send('Input.insertText', { text: '你好' });
    await page.waitForTimeout(50);
    expect(await inputs(page)).toBe('你好');
  });
}

test('cancelling composition does not send draft text or break ordinary typing', async ({ page }) => {
  const cdp = await setup(page);
  await cdp.send('Input.imeSetComposition', { text: 'unfinished', selectionStart: 10, selectionEnd: 10 });
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await page.waitForTimeout(30);
  await page.keyboard.type('ok');
  expect(await inputs(page)).toBe('ok');
});

test('a same-turn post-composition commit event is not sent twice', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const ta = active.term.textarea;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    ta.value = '你好';
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }));
    ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '你好', bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(30);
  expect(await inputs(page)).toBe('你好');
});

test('a new keystroke after composition can legitimately repeat the same text', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const ta = active.term.textarea;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    ta.value = '你好';
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, which: 229, bubbles: true, cancelable: true }));
    ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '你好', bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(30);
  expect(await inputs(page)).toBe('你好你好');
});

test('a pending 229 textarea diff never repeats a completed composition', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const ta = active.term.textarea;
    ta.value = '';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, which: 229, bubbles: true, cancelable: true }));
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    ta.value = '你';
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' }));
  });
  await page.waitForTimeout(30);
  expect(await inputs(page)).toBe('你');
});

test('a non-cancelable mobile text event is delivered exactly once', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const ta = active.term.textarea;
    ta.value = '';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, which: 229, bubbles: true, cancelable: true }));
    ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '，', bubbles: true, cancelable: false, composed: true }));
    ta.value = '，';
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '，', bubbles: true, composed: true }));
  });
  await page.waitForTimeout(30);
  expect(await inputs(page)).toBe('，');
});

test('many non-cancelable edits in one turn keep repeated characters and order', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const ta = active.term.textarea;
    ta.value = '';
    for (const text of ['你好', '好', 'abc', '，', '世界'].flatMap(x => Array(10).fill(x))) {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true }));
      ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, composed: true }));
      ta.value += text;
      ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true, composed: true }));
    }
  });
  await page.waitForTimeout(40);
  expect(await inputs(page)).toBe(['你好', '好', 'abc', '，', '世界'].map(x => x.repeat(10)).join(''));
});

test('non-cancelable input after a handled keypress does not duplicate it', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const ta = active.term.textarea;
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keypress', { key: 'a', charCode: 97, keyCode: 97, bubbles: true }));
    ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'a', bubbles: true, composed: true }));
    ta.value = 'a';
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'a', bubbles: true, composed: true }));
  });
  await page.waitForTimeout(40);
  expect(await inputs(page)).toBe('a');
});

test('input echo after composition commit is not sent twice', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const ta = active.term.textarea;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    ta.value = '你好';
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }));
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '你好', bubbles: true, composed: true }));
  });
  await page.waitForTimeout(40);
  expect(await inputs(page)).toBe('你好');
});

test('replacing a pane cancels pending IME callbacks from its old terminal', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(tab => {
    const pane = active, ta = pane.term.textarea;
    sent.length = 0;
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, which: 229, bubbles: true, cancelable: true }));
    ta.value = 'pending';
    attachTerminal(tab, pane);
  }, fixture.tabs[1]);
  await page.waitForFunction(() => active.ws?.readyState === 1);
  await page.waitForTimeout(40);
  expect(await inputs(page)).toBe('');
});

test('IME composition still works after a terminal connection is rebuilt', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { window.previousImeSocket = active.ws; active._resumeConnection(); });
  await page.waitForFunction(() => active.ws && active.ws !== previousImeSocket && active.ws.readyState === 1);
  await page.evaluate(() => { sent.length = 0; active.term.focus(); });
  const cdp = await page.context().newCDPSession(page);
  await compose(cdp, 'huifu', '恢复');
  await page.waitForTimeout(30);
  expect(await inputs(page)).toBe('恢复');
});

test('composition in a split sends text to that split only', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(tab => { attachTerminal(tab, makePane()); active.term.focus(); sent.length = 0; }, fixture.tabs[1]);
  await page.waitForFunction(() => panes.every(pane => pane.ws?.readyState === 1));
  const cdp = await page.context().newCDPSession(page);
  await compose(cdp, 'wenti', '问题');
  await page.waitForTimeout(30);
  expect(await inputs(page)).toBe('问题');
  expect(await page.evaluate(() => sent.filter(item => item.type === 'input').every(item => item.socket === panes[1].ws.url))).toBe(true);
});
