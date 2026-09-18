import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PNG } from 'pngjs';
import { withBrowserSession } from './browser-session.mjs';

const root = resolve(import.meta.dirname, '../..');
const [executable, outputArgument, fixture = 'overflow-paint'] = process.argv.slice(2);
if (!executable || !outputArgument || process.argv.length > 5 || !['overflow-paint', 'positioned-layout', 'initial-containing-block', 'paint-order', 'auto-paint'].includes(fixture)) {
  console.error('Usage: node scripts/compatibility/paint-reference.mjs <chrome-executable> <output-dir> [overflow-paint|positioned-layout|initial-containing-block|paint-order|auto-paint]');
  process.exit(2);
}
const output = resolve(outputArgument);
const cssViewport = { width: 448, height: 256 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = [
  `fixtures/${fixture}/index.html`, `fixtures/${fixture}/fixture.js`,
  `fixtures/${fixture}/cases.json`, 'scripts/compatibility/paint-reference.mjs',
  'scripts/compatibility/browser-session.mjs', 'scripts/compatibility/fixture-server.mjs',
  'package-lock.json',
];

try {
  await mkdir(output, { recursive: true });
  await withBrowserSession(executable, async ({ command, origin, signal }) => {
    const contents = await Promise.all(sources.map(path => readFile(resolve(root, path), { signal })));
    const fixtureInputs = sources.map((path, index) => ({ path, sha256: hash(contents[index]) }));
    const requested = JSON.parse(contents[2].toString('utf8'));
    assert(Array.isArray(requested) && requested.length > 0, 'Paint cases must be a nonempty array.');
    const filenames = new Set();
    for (const { name, scale = 1 } of requested) {
      assert(typeof name === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(name), 'Invalid paint case name.');
      assert(typeof scale === 'number' && Number.isFinite(scale) && scale > 0
        && Number.isSafeInteger(cssViewport.width * scale) && Number.isSafeInteger(cssViewport.height * scale),
      `Invalid device scale for ${name}.`);
      const file = `${name}-${scale}x.png`;
      assert(!filenames.has(file), `Duplicate paint case: ${name} at ${scale}x.`);
      filenames.add(file);
    }
    const browser = await command('Browser.getVersion');
    await command('Page.enable');
    await command('Emulation.setDeviceMetricsOverride', { ...cssViewport, deviceScaleFactor: 1, mobile: false });
    const navigation = await command('Page.navigate', { url: `${origin}/fixtures/${fixture}/index.html` });
    if (navigation.errorText) throw new Error(`Paint fixture navigation failed: ${navigation.errorText}`);

    async function evaluate(expression, awaitPromise = false) {
      const evaluation = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
      if (evaluation.exceptionDetails) {
        throw new Error(evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text);
      }
      return evaluation.result.value;
    }
    const deadline = Date.now() + 20000;
    while (!await evaluate('document.readyState === "complete" && typeof globalThis.clipFixture?.prepare === "function"')) {
      if (Date.now() >= deadline) throw new Error('Paint fixture did not load within 20 seconds.');
      await delay(100, undefined, { signal });
    }

    const cases = [];
    for (const { name, scale = 1 } of requested) {
      await command('Emulation.setDeviceMetricsOverride', { ...cssViewport, deviceScaleFactor: scale, mobile: false });
      const layout = await evaluate(`(async () => {
        await clipFixture.prepare(${JSON.stringify(name)});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return Object.fromEntries(['outer', 'middle', 'subject'].map(id => {
          const element = document.getElementById(id);
          if (!element) throw new Error('Missing paint element: ' + id);
          const rect = element.getBoundingClientRect();
          return [id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left }];
        }));
      })()`, true);
      const capture = await command('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false,
        clip: { x: 0, y: 0, ...cssViewport, scale: 1 },
      });
      const bytes = Buffer.from(capture.data, 'base64');
      const png = PNG.sync.read(bytes);
      const width = cssViewport.width * scale;
      const height = cssViewport.height * scale;
      assert.equal(png.width, width, `Wrong physical screenshot width for ${name}.`);
      assert.equal(png.height, height, `Wrong physical screenshot height for ${name}.`);
      const file = `${name}-${scale}x.png`;
      await writeFile(resolve(output, file), bytes, { signal });
      cases.push({ name, scale, width, height, layout, pixelSha256: hash(png.data), file });
    }
    for (const input of fixtureInputs) {
      assert.equal(hash(await readFile(resolve(root, input.path), { signal })), input.sha256,
        `Reference input changed during capture: ${input.path}`);
    }
    const report = {
      schemaVersion: 1, kind: `${fixture}-browser-reference`, capturedAt: new Date().toISOString(),
      browser, cssViewport,
      inputs: { htmlSha256: fixtureInputs[0].sha256, scriptSha256: fixtureInputs[1].sha256, casesSha256: fixtureInputs[2].sha256 },
      fixtureInputs, cases,
    };
    await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { signal });
    console.log(`PASS: ${cases.length} browser paint references. Report: ${resolve(output, 'report.json')}`);
  });
} catch (error) {
  if (error.sessionFailure !== false) console.error(JSON.stringify({ error: error.message, browserLogTail: error.browserLogTail ?? '' }));
  if (error.cleanupError) console.error(JSON.stringify({ error: `Cleanup failed: ${error.cleanupError.message}` }));
  process.exitCode = error.cleanupError || error.sessionFailure !== false ? 3 : error.terminationSignal === 'SIGINT' ? 130 : 143;
}
