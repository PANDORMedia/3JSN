import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withBrowserSession } from '../../scripts/compatibility/browser-session.mjs';

const root = resolve(import.meta.dirname, '../..');
const executable = process.argv[2] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
async function inputs() {
  return Promise.all(['index.html', 'behavior.mjs'].map(async name => {
    const bytes = await readFile(join(root, 'fixtures/dom-focus', name));
    return { path: `fixtures/dom-focus/${name}`, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
}
const sourceBefore = await inputs();
const browser = await withBrowserSession(executable, async ({ command, origin, signal }) => {
  async function evaluate(expression, awaitPromise = false) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  await command('Page.enable');
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.__focusErrors=[];
    addEventListener('error',event=>__focusErrors.push(String(event.error?.stack||event.message)));
    addEventListener('unhandledrejection',event=>__focusErrors.push(String(event.reason?.stack||event.reason)));
  ` });
  await command('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: `${origin}/fixtures/dom-focus/index.html` });
  await command('Page.bringToFront');
  let ready = false;
  for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
    signal.throwIfAborted();
    try { ready = await evaluate('document.readyState === "complete" && typeof focusProbe !== "undefined"'); }
    catch (error) { if (!/context.*destroyed|Cannot find context/i.test(error.message)) throw error; }
    if (ready) break;
    await delay(25, undefined, { signal });
  }
  assert(ready, 'focus fixture module did not become ready');
  const pageHadFocus = await evaluate('document.hasFocus()');
  const programmatic = await evaluate('focusProbe.run()', true);
  const sequential = { source: 'CDP Input.dispatchKeyEvent, not physical OS input',
    programmaticNegative: await evaluate('globalThis.__sequential = focusProbe.prepareSequential(); __sequential.focusNegative()'),
    initial: await evaluate(`globalThis.__tabEvents=[]; addEventListener('keydown', event => {
      if(event.key==='Tab') __tabEvents.push({key:event.key,isTrusted:event.isTrusted,target:event.target.id||event.target.nodeName.toLowerCase()});
    }); __sequential.focusFirst()`), tabs: [] };
  for (let index = 0; index < 2; index++) {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    sequential.tabs.push(await evaluate('new Promise(resolve => setTimeout(() => resolve(__sequential.snapshot()), 0))', true));
  }
  sequential.keyEvents = await evaluate('__tabEvents');
  await evaluate('__sequential.dispose(); delete globalThis.__sequential;');
  const errors = await evaluate('__focusErrors');
  assert.deepEqual(errors, [], 'browser fixture errors');
  return { version: await command('Browser.getVersion'), viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    pageHadFocus, programmatic, sequential, errors };
});
const sourceAfter = await inputs();
assert.deepEqual(sourceAfter, sourceBefore, 'fixture source changed during capture');
await writeFile(join(import.meta.dirname, process.argv[3] || 'report.json'), `${JSON.stringify({ schemaVersion: 1,
  sourceBefore, sourceAfter, sourcePreserved: true, browser, nativeValidated: false }, null, 2)}\n`);
console.log(JSON.stringify({version:browser.version.product, initial:browser.programmatic.initial,
  cases:browser.programmatic.cases.map(value=>({name:value.name,before:value.before.activeElement,
    immediate:value.immediate.activeElement,microtask:value.afterMicrotask.activeElement,
    layout:value.afterLayout.activeElement,task:value.afterTask.activeElement,
    targetEvents:value.events.filter(event=>event.listener==='target').map(event=>({type:event.type,
      target:event.target,related:event.relatedTarget,active:event.activeElement})),actions:value.actions})),
  sequential:browser.sequential},null,2));
