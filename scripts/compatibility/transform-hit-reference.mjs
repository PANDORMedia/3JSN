import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withBrowserSession } from './browser-session.mjs';

const [executable, output] = process.argv.slice(2);
assert(executable && output && process.argv.length === 4,
  'Usage: node scripts/compatibility/transform-hit-reference.mjs <chrome-executable> <report.json>');
const root = resolve(import.meta.dirname, '../..');
const htmlPath = 'fixtures/transform-context/hit.html';
const inputs = [htmlPath, 'experiments/dom-canvas/src/transform_context_tests.rs',
  'scripts/compatibility/transform-hit-reference.mjs', 'scripts/compatibility/browser-session.mjs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const states = [
  ['transform:none', false],
  ['transform:translate(0px)', true],
  ['transform:translate(8px,6px)', true],
  ['transform:none', false],
  ['transform:matrix(1,0,0,1,0,0)', true],
  ['transform:none', false],
  ['translate:0px', true],
  ['translate:8px 6px', true],
  ['translate:none', false],
  ['rotate:0deg', true],
  ['rotate:5deg', true],
  ['rotate:none', false],
  ['scale:1', true],
  ['scale:1.1', true],
  ['scale:none', false],
  ['perspective:600px', true],
  ['perspective:none', false],
  ['transform-style:preserve-3d', true],
  ['transform-style:flat', false],
];

await withBrowserSession(executable, async ({ command, origin, signal }) => {
  const sourceSha256 = Object.fromEntries(await Promise.all(inputs.map(async path =>
    [path, hash(await readFile(resolve(root, path), { signal }))])));
  const browser = await command('Browser.getVersion');
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 448, height: 256, deviceScaleFactor: 1, mobile: false });
  const navigation = await command('Page.navigate', { url: `${origin}/${htmlPath}` });
  assert(!navigation.errorText, navigation.errorText);
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert(!result.exceptionDetails, result.exceptionDetails?.text);
    return result.result.value;
  };
  const deadline = Date.now() + 20_000;
  while (!await evaluate('document.readyState === "complete" && !!document.getElementById("peer")')) {
    assert(Date.now() < deadline, 'Transform reference did not load.');
    await delay(100, undefined, { signal });
  }
  const samples = [];
  for (const mode of ['positive', 'negative']) {
    await evaluate(`{
      document.getElementById('subject').style.zIndex = ${JSON.stringify(mode === 'positive' ? '2' : '-1')};
      document.getElementById('peer').style.zIndex = ${JSON.stringify(mode === 'positive' ? '1' : '-1')};
    }`);
    for (let iteration = 0; iteration < 3; iteration++) {
      // Keep frame waits within the browser session's per-command deadline.
      samples.push(...await evaluate(`(async () => {
        const host = document.getElementById('host');
        const samples = [];
        for (const [declaration, context] of ${JSON.stringify(states)}) {
          host.setAttribute('style', declaration);
          for (let repeat = 0; repeat < 2; repeat++) {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            samples.push({ mode: ${JSON.stringify(mode)}, iteration: ${iteration}, declaration, context, repeat,
              hit: document.elementFromPoint(32,32)?.id ?? null });
          }
        }
        return samples;
      })()`));
    }
  }
  assert.equal(samples.length, 228);
  for (const sample of samples) {
    const expected = sample.mode === 'positive'
      ? (sample.context ? 'peer' : 'subject') : (sample.context ? 'subject' : 'peer');
    assert.equal(sample.hit, expected, JSON.stringify(sample));
  }
  for (const path of inputs) assert.equal(hash(await readFile(resolve(root, path), { signal })), sourceSha256[path]);
  const report = { schemaVersion: 1, kind: 'transform-context-hit-reference', browser, sourceSha256,
    viewport: { width: 448, height: 256, scale: 1 }, point: [32, 32],
    matchedHitAssertions: samples.length, samples };
  await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { signal });
  console.log(`PASS: ${samples.length} browser hit assertions match the native test expectations. Report: ${resolve(output)}`);
});
