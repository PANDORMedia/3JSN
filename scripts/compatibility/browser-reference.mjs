import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withBrowserSession } from './browser-session.mjs';

const root = resolve(import.meta.dirname, '../..');
const availableFixtures = ['webgl-dom', 'workers-wasm', 'audio-worklet', 'network', 'webgpu-canvas', 'dom-geometry'];
const [browserExecutable, selection = 'webgl-dom'] = process.argv.slice(2);
if (!browserExecutable || process.argv.length > 4 || (selection !== 'all' && !availableFixtures.includes(selection))) {
  console.error('Usage: node scripts/compatibility/browser-reference.mjs <chrome-or-chromium-executable> [webgl-dom|workers-wasm|audio-worklet|network|webgpu-canvas|dom-geometry|all]');
  process.exit(2);
}
const fixtures = selection === 'all' ? availableFixtures : [selection];

try {
  await withBrowserSession(browserExecutable, async ({ command, origin, signal }) => {
    const version = await command('Browser.getVersion');
    const reports = [];
    for (const fixture of fixtures) {
      await command('Page.navigate', { url: `${origin}/fixtures/${fixture}/index.html` });
      let result;
      const fixtureDeadline = Date.now() + 20000;
      while (!result && Date.now() < fixtureDeadline) {
        const evaluation = await command('Runtime.evaluate', { expression: 'globalThis.__3jsnFixtureResult ?? null', returnByValue: true });
        if (evaluation.exceptionDetails) throw new Error('Browser could not read the fixture result.');
        if (evaluation.result.value?.fixture === fixture) result = evaluation.result.value;
        if (!result) await delay(100, undefined, { signal });
      }
      if (!result) throw new Error(`Fixture did not finish within 20 seconds: ${fixture}`);
      const fixtureInputs = [];
      const sources = (await readdir(join(root, 'fixtures', fixture))).filter((file) => /\.(html|css|mjs|js)$/.test(file)).map((file) => `fixtures/${fixture}/${file}`);
      sources.push('fixtures/harness.mjs', 'scripts/compatibility/fixture-server.mjs', 'package-lock.json');
      for (const path of sources.sort()) {
        fixtureInputs.push({ path, sha256: createHash('sha256').update(await readFile(join(root, path), { signal })).digest('hex') });
      }
      reports.push({ schemaVersion: 1, kind: 'browser-reference', capturedAt: new Date().toISOString(), host: { platform: process.platform, architecture: process.arch }, browser: version, fixtureInputs, result });
      if (result.status !== 'passed') process.exitCode = 1;
    }
    console.log(JSON.stringify(selection === 'all' ? { schemaVersion: 1, kind: 'browser-reference-suite', reports } : reports[0], null, 2));
  });
} catch (error) {
  if (error.sessionFailure !== false) console.error(JSON.stringify({ error: error.message, browserLogTail: error.browserLogTail ?? '' }));
  if (error.cleanupError) console.error(JSON.stringify({ error: `Cleanup failed: ${error.cleanupError.message}` }));
  process.exitCode = error.cleanupError || error.sessionFailure !== false ? 3 : error.terminationSignal === 'SIGINT' ? 130 : 143;
}
