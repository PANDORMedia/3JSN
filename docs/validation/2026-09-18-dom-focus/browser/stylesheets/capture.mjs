import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withBrowserSession } from '../../scripts/compatibility/browser-session.mjs';

const root = resolve(import.meta.dirname, '../..');
const executable = process.argv[2] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const name = process.argv[3] || 'report';
assert(/^[a-z0-9-]+$/u.test(name));
const sourcePath = 'experiments/dom-canvas/tests/fixtures/focus-stylesheets.js';
const bytes = await readFile(join(root, sourcePath));
const identify = data => ({ path: sourcePath, byteLength: data.length,
  sha256: createHash('sha256').update(data).digest('hex') });
const before = identify(bytes);
await writeFile(join(import.meta.dirname, `${name}-source.js`), bytes);
const browser = await withBrowserSession(executable, async ({ command, signal }) => {
  const evaluate = async (expression, awaitPromise = false) => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await command('Page.enable');
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.stylesheetErrors=[];
    addEventListener('error', event => stylesheetErrors.push({kind:'error',message:event.message,stack:String(event.error?.stack||'')}));
    addEventListener('unhandledrejection', event => stylesheetErrors.push({kind:'unhandledrejection',reason:String(event.reason?.stack||event.reason)}));
  ` });
  await command('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: 'data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Chtml%3E%3Chead%3E%3Ctitle%3EFocus%20stylesheet%20control%3C/title%3E%3C/head%3E%3Cbody%3E%3C/body%3E%3C/html%3E' });
  let ready = false;
  for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
    signal.throwIfAborted();
    try { ready = await evaluate('document.readyState === "complete" && document.title === "Focus stylesheet control"'); }
    catch (error) { if (!/context.*destroyed|Cannot find context/i.test(error.message)) throw error; }
    if (ready) break;
    await delay(20, undefined, { signal });
  }
  assert(ready, 'Fresh document did not become ready.');
  await command('Page.bringToFront');
  const initial = await evaluate('({active:document.activeElement.nodeName.toLowerCase(),hasFocus:document.hasFocus(),readyState:document.readyState})');
  assert.deepEqual(initial, { active: 'body', hasFocus: true, readyState: 'complete' });
  const installation = await command('Runtime.evaluate', { expression: bytes.toString('utf8'), returnByValue: true });
  const execution = installation.exceptionDetails ? null : await command('Runtime.evaluate', {
    expression: 'runFocusStylesheetBehavior()', awaitPromise: true, returnByValue: true,
  });
  const rawErrors = { installation: installation.exceptionDetails ?? null,
    execution: execution?.exceptionDetails ?? null, events: await evaluate('stylesheetErrors') };
  const after = await evaluate('({active:document.activeElement.nodeName.toLowerCase(),hasFocus:document.hasFocus(),bodyChildren:document.body.children.length,focus:document.querySelector(":focus")?.id??null})');
  return { version: await command('Browser.getVersion'), viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    initial, result: execution?.result.value ?? null, after, rawErrors, rawExecution: execution };
});
const after = identify(await readFile(join(root, sourcePath)));
const expected = ['append-stylesheet', 'replace-stylesheet-text', 'focus-hides-self'].map(mode => ({
  mode, immediate: 'focus-stylesheet-target', afterMicrotask: 'focus-stylesheet-target',
  afterLayout: 'focus-stylesheet-target', afterTask: 'body', focus: null,
}));
const report = { schemaVersion: 1, sourceBefore: before, sourceAfter: after,
  sourcePreserved: JSON.stringify(before) === JSON.stringify(after),
  exactSourceEvaluatedWithoutRewriting: true, browser, expected, nativeValidated: false };
await writeFile(join(import.meta.dirname, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(import.meta.dirname, `${name}-raw-errors.json`), `${JSON.stringify(browser.rawErrors, null, 2)}\n`);
assert.deepEqual(after, before, 'Input changed during capture.');
assert.deepEqual(browser.rawErrors, { installation: null, execution: null, events: [] });
assert.deepEqual(browser.result, expected, 'Measured timing differs from the proposed native expectations.');
assert.deepEqual(browser.after, { active: 'body', hasFocus: true, bodyChildren: 0, focus: null });
console.log(JSON.stringify({ version: browser.version.product, source: before, result: browser.result }, null, 2));
