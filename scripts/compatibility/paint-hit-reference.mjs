import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withBrowserSession } from './browser-session.mjs';

const [executable, output] = process.argv.slice(2);
assert(executable && output && process.argv.length === 4,
  'Usage: node scripts/compatibility/paint-hit-reference.mjs <chrome-executable> <report.json>');
const root = resolve(import.meta.dirname, '../..');
const htmlPath = 'fixtures/paint-order/hit.html';
const inputs = [htmlPath, 'experiments/dom-canvas/src/paint_order_hit_tests.rs',
  'scripts/compatibility/paint-hit-reference.mjs', 'scripts/compatibility/browser-session.mjs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

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
  while (!await evaluate('document.readyState === "complete" && !!document.getElementById("later")')) {
    assert(Date.now() < deadline, 'Hit reference did not load.');
    await delay(100, undefined, { signal });
  }
  const samples = await evaluate(`(async () => {
    const body = document.getElementById('body');
    const earlier = document.getElementById('earlier');
    const later = document.getElementById('later');
    const samples = [];
    async function sample(z, iteration, order, points) {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      samples.push({ z, iteration, order, points,
        hits: points.map(([x,y]) => document.elementFromPoint(x,y)?.id ?? null) });
    }
    for (const z of ['1','-1']) {
      earlier.style.zIndex = z; later.style.zIndex = z;
      for (let iteration = 0; iteration < 3; iteration++) {
        body.appendChild(later);
        for (let repeat = 0; repeat < 2; repeat++) {
          await sample(z, iteration, 'earlier-later', [[80,70],[50,45],[164,120]]);
        }
        body.appendChild(earlier);
        await sample(z, iteration, 'later-earlier', [[80,70],[164,120]]);
      }
    }
    return samples;
  })()`);
  assert.equal(samples.length, 18);
  for (const sample of samples) {
    assert.deepEqual(sample.hits, sample.order === 'earlier-later' ? ['later', 'earlier', 'later'] : ['earlier', 'later']);
  }
  for (const path of inputs) assert.equal(hash(await readFile(resolve(root, path), { signal })), sourceSha256[path]);
  const report = { schemaVersion: 1, kind: 'paint-order-hit-reference', browser, sourceSha256,
    viewport: { width: 448, height: 256, scale: 1 }, matchedHitAssertions: 48, samples };
  await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { signal });
  console.log(`PASS: 48 browser hit assertions match the native test expectations. Report: ${resolve(output)}`);
});
