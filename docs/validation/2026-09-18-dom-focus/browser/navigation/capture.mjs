import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withBrowserSession } from '../../scripts/compatibility/browser-session.mjs';

const directory = import.meta.dirname;
const executable = process.argv[2] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const output = process.argv[3] || 'report.json';
assert(/^[a-z0-9-]+\.json$/u.test(output));
const html = await readFile(join(directory, 'tree.html'), 'utf8');
const page = await readFile(join(directory, 'page.js'), 'utf8');
const identities = async () => Promise.all(['tree.html', 'page.js', 'capture.mjs'].map(async path => {
  const bytes = await readFile(join(directory, path));
  return { path, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}));
const sourceBefore = await identities();
const browser = await withBrowserSession(executable, async ({ command, signal }) => {
  const evaluate = async (expression, awaitPromise = false) => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await command('Page.enable');
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.navigationErrors=[];
    addEventListener('error', event => navigationErrors.push(String(event.error?.stack || event.message)));
    addEventListener('unhandledrejection', event => navigationErrors.push(String(event.reason?.stack || event.reason)));
  ` });
  await command('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  async function fresh(name) {
    await command('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(html.replace('</body>', `<script>${page}</script><script>globalThis.navigationCase=${JSON.stringify(name)}</script></body>`))}` });
    let ready = false;
    for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
      signal.throwIfAborted();
      try { ready = await evaluate(`document.readyState === 'complete' && globalThis.navigationCase === ${JSON.stringify(name)}`); }
      catch (error) { if (!/context.*destroyed|Cannot find context/i.test(error.message)) throw error; }
      if (ready) break;
      await delay(20, undefined, { signal });
    }
    assert(ready, `fresh page did not become ready: ${name}`);
    await command('Page.bringToFront');
    const initial = await evaluate('navigationProbe.snapshot()');
    assert.equal(initial.hasFocus, true, `${name}: document must have focus before control`);
    assert.equal(initial.activeElement, 'body', `${name}: fresh document must start at body`);
    return initial;
  }
  async function complete(result) {
    result.events = await evaluate('navigationProbe.events()');
    result.errors = await evaluate('navigationErrors');
    assert.deepEqual(result.errors, []);
    result.cleanup = await evaluate('navigationProbe.dispose()');
    assert.equal(result.cleanup.eventsBefore, result.cleanup.eventsAfter, 'cleanup contaminated events');
    assert.equal(result.cleanup.detached, true);
    return result;
  }
  const cases = [
    { name: 'initial-forward', tabs: 8 },
    { name: 'initial-backward', backward: true, tabs: 8 },
    { name: 'negative-forward', start: 'negative', tabs: 3 },
    { name: 'negative-backward', start: 'negative', backward: true, tabs: 3 },
    { name: 'negative-before-forward', start: 'negative-before', tabs: 3 },
    { name: 'negative-before-backward', start: 'negative-before', backward: true, tabs: 3 },
    { name: 'negative-after-forward', start: 'negative-after', tabs: 3 },
    { name: 'negative-after-backward', start: 'negative-after', backward: true, tabs: 3 },
    { name: 'first-backward-edge', start: 'positive-one', backward: true, tabs: 3 },
    { name: 'last-forward-edge', start: 'natural-b', tabs: 3 },
  ];
  const navigation = [];
  let tree;
  for (const control of cases) {
    const result = { ...control, initial: await fresh(control.name), steps: [] };
    tree ??= await evaluate('navigationProbe.tree()');
    if (control.start) {
      result.programmatic = await evaluate(`navigationProbe.focus(${JSON.stringify(control.start)})`);
      assert.equal(result.programmatic.activeElement, control.start);
    }
    await evaluate('navigationProbe.clearEvents()');
    for (let index = 0; index < control.tabs; index++) {
      const params = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: control.backward ? 8 : 0 };
      await command('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
      const afterKeyDown = await evaluate('navigationProbe.snapshot()');
      await command('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
      const afterTask = await evaluate('new Promise(resolve => setTimeout(() => resolve(navigationProbe.snapshot()), 0))', true);
      result.steps.push({ afterKeyDown, afterTask });
    }
    navigation.push(await complete(result));
  }
  const mouse = [];
  for (const mode of ['ordinary', 'cancel', 'remove', 'disable', 'outside', 'negative']) {
    const result = { mode, initial: await fresh(`mouse-${mode}`) };
    await evaluate('navigationProbe.focus("natural-a")');
    await evaluate(`navigationProbe.mouseControl(${JSON.stringify(mode)}); navigationProbe.clearEvents()`);
    const target = mode === 'outside' ? 'outside' : mode === 'negative' ? 'negative' : 'natural-b';
    result.point = await evaluate(`navigationProbe.point(${JSON.stringify(target)})`);
    result.before = await evaluate('navigationProbe.snapshot()');
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...result.point, button: 'left', buttons: 1, clickCount: 1 });
    result.afterMouseDown = await evaluate('navigationProbe.snapshot()');
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...result.point, button: 'left', buttons: 0, clickCount: 1 });
    result.afterTask = await evaluate('new Promise(resolve => setTimeout(() => resolve(navigationProbe.snapshot()), 0))', true);
    mouse.push(await complete(result));
  }
  const displayContents = [];
  for (const control of [
    { name: 'div-own', styled: 'zero', target: 'zero' },
    { name: 'button-own', styled: 'natural-b', target: 'natural-b' },
    { name: 'ancestor', styled: 'tree', target: 'natural-b' },
  ]) {
    const result = { ...control, initial: await fresh(`contents-${control.name}`) };
    await evaluate('navigationProbe.focus("natural-a")');
    result.computedDisplay = await evaluate(`(() => {
      const node = document.getElementById(${JSON.stringify(control.styled)});
      node.style.setProperty('display', 'contents');
      return getComputedStyle(node).display;
    })()`);
    assert.equal(result.computedDisplay, 'contents');
    await evaluate('navigationProbe.clearEvents()');
    result.afterFocus = await evaluate(`navigationProbe.focus(${JSON.stringify(control.target)})`);
    result.afterTask = await evaluate('new Promise(resolve => setTimeout(() => resolve(navigationProbe.snapshot()), 0))', true);
    displayContents.push(await complete(result));
  }
  return { version: await command('Browser.getVersion'), viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    tree, navigation, mouse, displayContents };
});
const sourceAfter = await identities();
assert.deepEqual(sourceAfter, sourceBefore);
const report = { schemaVersion: 1, sourceBefore, sourceAfter, sourcePreserved: true,
  input: 'CDP trusted keyboard/mouse dispatch, not physical OS input', freshDocumentPerControl: true,
  focusAssertedBeforeEveryControl: true, browser, nativeValidated: false };
await writeFile(join(directory, output), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ version: browser.version.product,
  navigation: browser.navigation.map(value => ({ name: value.name, states: value.steps.map(step => step.afterTask) })),
  mouse: browser.mouse.map(value => ({ mode: value.mode, down: value.afterMouseDown, final: value.afterTask })),
  displayContents: browser.displayContents.map(value => ({ name: value.name, result: value.afterTask })) }, null, 2));
