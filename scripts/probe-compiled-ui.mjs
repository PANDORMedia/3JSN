import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { compileHtml } from '../experiments/compiled-ui/compiler.mjs';
import { withBrowserSession } from './compatibility/browser-session.mjs';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const [probeArg, fontArg, outputArg, browserArg, ...extra] = process.argv.slice(2);
assert(probeArg && fontArg && outputArg && browserArg && !extra.length,
  'Usage: node scripts/probe-compiled-ui.mjs <native-probe> <font.woff2> <new-output-directory> <Chrome>');
const probe = resolve(probeArg), font = resolve(fontArg), output = resolve(outputArg);
await mkdir(output);
const fixtures = ['dashboard', 'repaired', 'namespaces', 'templates', 'cascade-recovery'];
const scriptPath = join(root, 'fixtures/compiled-ui/behavior.js');
const behavior = await readFile(scriptPath, 'utf8');
const fontBytes = await readFile(font);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const results = [];
for (const fixture of fixtures) {
  const htmlPath = join(root, `fixtures/compiled-ui/${fixture}.html`);
  const html = await readFile(htmlPath, 'utf8');
  const compiled = compileHtml(html, { sourceName: `fixtures/compiled-ui/${fixture}.html` });
  const compiledPath = join(output, `${fixture}.ui.json`);
  await writeFile(compiledPath, JSON.stringify(compiled));
  const reports = {};
  for (const [mode, input] of [['html', htmlPath], ['ui', compiledPath]]) {
    const reportPath = join(output, `${fixture}-${mode}.json`);
    try {
      const result = await execute(probe, [`--${mode}`, input, scriptPath, font, reportPath], {
        cwd: root, timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
      });
      await writeFile(join(output, `${fixture}-${mode}-stderr.txt`), result.stderr);
      reports[mode] = JSON.parse(await readFile(reportPath));
    } catch (error) {
      await writeFile(join(output, `${fixture}-${mode}-error.txt`), `${error.stderr ?? error}\n`);
      throw error;
    }
  }
  const phases = ['initial', 'mutated', 'resized'];
  const equivalent = phases.every(phase => JSON.stringify(reports.html[phase]) === JSON.stringify(reports.ui[phase]));
  assert.equal(reports.ui.loading.initialDocumentHtmlParserUsed, false);
  assert.equal(reports.ui.loading.dynamicHtmlParserProvider, 'blitz-html');
  assert.equal(hash(await readFile(htmlPath)), hash(html), 'Compiler/native comparison changed the source.');
  results.push({ fixture, sourceSha256: hash(html), irSha256: hash(await readFile(compiledPath)),
    recoveredDiagnostics: compiled.diagnostics, equivalent, native: reports });
}

const browser = await withBrowserSession(resolve(browserArg), async ({ command, origin, signal }) => {
  await command('Page.enable');
  const observations = {};
  async function evaluate(expression, awaitPromise = false) {
    const response = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    assert(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  for (const fixture of fixtures) {
    await command('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    const url = `${origin}/fixtures/compiled-ui/${fixture}.html`;
    await command('Page.navigate', { url });
    const deadline = Date.now() + 15_000;
    let loaded = false;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      try { loaded = await evaluate(`location.href===${JSON.stringify(url)} && document.readyState==='complete'`); }
      catch (error) { if (!/context.*destroyed|Cannot find context/i.test(error.message)) throw error; }
      if (loaded) break;
      await delay(25, undefined, { signal });
    }
    assert(loaded, 'Browser navigation timed out.');
    await evaluate(`(async()=>{
      const bytes=Uint8Array.from(atob(${JSON.stringify(fontBytes.toString('base64'))}),c=>c.charCodeAt(0));
      const face=new FontFace('3JSN Fixture',bytes); await face.load(); document.fonts.add(face);
      await document.fonts.ready;
      ${behavior}
    })()`, true);
    const initial = await evaluate('uiFixture.snapshot()');
    const mutated = await evaluate('uiFixture.mutate()');
    await command('Emulation.setDeviceMetricsOverride', { width: 520, height: 420, deviceScaleFactor: 1, mobile: false });
    const resized = await evaluate('uiFixture.snapshot()');
    observations[fixture] = { initial, mutated, resized };
  }
  return { version: await command('Browser.getVersion'), observations };
});

function differences(actual, expected, path = '', output = []) {
  if (typeof expected === 'number' && path.includes('.rect.')) {
    if (typeof actual !== 'number' || Math.abs(actual - expected) > 0.25) output.push({ path, actual, expected });
  } else if (expected !== null && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') output.push({ path, actual, expected });
    else for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) differences(actual[key], expected[key], `${path}.${key}`, output);
  } else if (actual !== expected) output.push({ path, actual, expected });
  return output;
}
for (const result of results) {
  result.browserDifferences = ['initial', 'mutated', 'resized'].flatMap(phase =>
    differences(result.native.ui[phase], browser.observations[result.fixture][phase], phase));
}
const report = { status: results.every(result => result.equivalent && result.browserDifferences.length === 0) ? 'passed' : 'partial',
  compiledEquivalentToInterpreted: results.every(result => result.equivalent), results, browser,
  inputs: { probeSha256: hash(await readFile(probe)), fontSha256: hash(fontBytes), behaviorSha256: hash(behavior) },
  limits: ['CPU construction/DOM/layout comparison; no GPU or performance measurement in this probe.',
    'Native DocumentType nodes and non-no-quirks modes are unsupported; source doctype metadata remains in the IR.',
    'Initial document HTML parsing is bypassed; CSS parsing and dynamic HTML parser linkage remain. Experimental JSON is not a shipping package ABI.'] };
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, equivalent: report.compiledEquivalentToInterpreted,
  browserDifferences: results.map(({ fixture, browserDifferences }) => ({ fixture, count: browserDifferences.length })), report: join(output, 'report.json') }));
if (report.status !== 'passed') process.exitCode = 1;
