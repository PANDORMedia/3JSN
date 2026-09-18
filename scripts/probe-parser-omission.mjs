import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { compileHtml } from '../experiments/compiled-ui/compiler.mjs';
import { withBrowserSession } from './compatibility/browser-session.mjs';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: {
  ...Object.fromEntries(['enabled', 'disabled', 'font', 'out', 'browser'].map(name => [name, { type: 'string' }])),
  'cpu-only': { type: 'boolean', default: false },
}, strict: true });
assert(process.platform === 'darwin' && process.arch === 'arm64' && ['enabled', 'disabled', 'font', 'out'].every(key => values[key]),
  'Usage: node scripts/probe-parser-omission.mjs --enabled EXE --disabled EXE --font FONT --out NEW_DIRECTORY [--browser CHROME] [--cpu-only] (macOS arm64)');
assert.notEqual(resolve(values.enabled), resolve(values.disabled), 'Use distinct variant executables.');
const output = resolve(values.out);
await mkdir(output);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', scope: values['cpu-only'] ? 'CPU DOM/layout only' : 'CPU DOM/layout and native window',
  nativeWindowValidated: false, steps: [], variants: {}, limits: [
  'Experimental direct runtime invocation; no production package profile or application compatibility certification.',
  'The optional browser comparison covers sampled DOM/layout behavior only; GPU pixel equivalence remains unverified.',
  'Parser omission requires separate Cargo/build/link evidence; runtime feature declarations alone do not prove it.',
  'CSS and selector parsing remain. This probe does not measure performance.',
] };
const save = () => writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

try {
  const runDirectory = join(output, 'Native parser é #');
  await mkdir(runDirectory);
  const font = join(runDirectory, 'font.woff2');
  const html = join(runDirectory, 'original.html');
  const ui = join(runDirectory, 'ui.json');
  const behavior = join(runDirectory, 'behavior.js');
  const module = join(runDirectory, 'app.mjs');
  const sourcePaths = Object.fromEntries(['index.html', 'behavior.js', 'app.mjs'].map(name => [name, join(root, 'fixtures/parser-omission', name)]));
  const sources = Object.fromEntries(await Promise.all(Object.entries(sourcePaths).map(async ([name, path]) => [name, await readFile(path)])));
  await copyFile(resolve(values.font), font);
  await writeFile(html, sources['index.html']);
  await writeFile(behavior, sources['behavior.js']);
  await writeFile(ui, JSON.stringify(compileHtml(sources['index.html'].toString('utf8'), { sourceName: 'fixtures/parser-omission/index.html' })));
  const bundle = await build({ entryPoints: [sourcePaths['app.mjs']], outfile: module, bundle: true, platform: 'browser', format: 'esm', logLevel: 'silent' });
  assert.equal(bundle.warnings.length, 0);
  const players = {};
  for (const variant of ['enabled', 'disabled']) {
    players[variant] = join(runDirectory, `runtime-${variant}`);
    await copyFile(resolve(values[variant]), players[variant]);
    await chmod(players[variant], 0o755);
  }
  const deniedPaths = ['.cache', 'node_modules', 'crates', 'experiments', 'examples', 'fixtures'].map(path =>
    ` (subpath ${JSON.stringify(join(root, path))})`).join('\n');
  const policy = join(output, 'restricted-inputs.sb');
  await writeFile(policy, `(version 1)\n(allow default)\n(deny network*)\n(deny file-read*\n${deniedPaths}\n (literal ${JSON.stringify(html)}))\n`);
  const identityPaths = { ...players, font, html, ui, behavior, module };
  report.inputs = Object.fromEntries(await Promise.all(Object.entries(identityPaths).map(async ([name, path]) => {
    const bytes = await readFile(path);
    return [name, { path, bytes: bytes.length, sha256: hash(bytes) }];
  })));
  report.sourceHashes = Object.fromEntries(Object.entries(sources).map(([name, bytes]) => [name, hash(bytes)]));
  const options = { cwd: runDirectory, env: { ...process.env, PATH: '/usr/bin:/bin', MTL_DEBUG_LAYER: '1' },
    timeout: 90_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 };
  async function run(label, executable, args, expectedFailure) {
    let stdout = '', stderr = '', failure;
    try {
      ({ stdout, stderr } = await execute('/usr/bin/sandbox-exec', ['-f', policy, executable, ...args], options));
    } catch (error) {
      stdout = error.stdout ?? ''; stderr = error.stderr ?? String(error); failure = error;
    }
    await writeFile(join(output, `${label}-stdout.txt`), stdout);
    await writeFile(join(output, `${label}-stderr.txt`), stderr);
    report.steps.push({ label, expectedFailure: Boolean(expectedFailure), exitCode: failure?.code ?? 0,
      signal: failure?.signal ?? null, stdout: `${label}-stdout.txt`, stderr: `${label}-stderr.txt` });
    await save();
    if (expectedFailure) {
      assert(failure && failure.code === 1 && !failure.killed && !failure.signal, `${label}: expected an explicit exit 1, not success, timeout or signal`);
      assert.match(stderr, expectedFailure);
    } else if (failure) throw failure;
    return stdout.split('\n').filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line));
  }
  function one(records, field) {
    const matches = records.filter(record => Object.hasOwn(record, field));
    assert.equal(matches.length, 1, `Expected exactly one ${field} record`);
    return matches[0];
  }
  function loading(records, variant) {
    const value = one(records, 'compiledUi').compiledUi;
    assert.equal(value.initialDocumentHtmlParserUsed, false);
    assert.equal(value.dynamicHtmlParserProvider, variant === 'enabled' ? 'blitz-html' : 'absent');
    return value;
  }
  await run('denied-original-html', '/bin/cat', [html], /Operation not permitted/);
  report.originalHtmlReadDenied = true;
  const rejectionNames = ['innerHTML', 'emptyInnerHTML', 'bodyInnerHTML', 'iframe', 'outerHTML', 'insertAdjacentHTML', 'setHTML', 'setHTMLUnsafe',
    'DOMParser', 'contextualFragment', 'documentWrite', 'documentWriteln', 'documentOpen', 'documentParse', 'documentParseUnsafe', 'navigation', 'documentNavigation'];
  for (const variant of ['enabled', 'disabled']) {
    const player = players[variant];
    const description = one(await run(`${variant}-describe`, player, ['--describe']), 'experiment');
    assert.equal(description.experiment, 'compiled-ui-runtime');
    assert.equal(description.target, 'macos-arm64');
    assert.equal(description.backend, 'Metal');
    assert.equal(description.dynamicHtml, variant === 'enabled');
    assert.deepEqual(description.packageProfiles, []);
    const layoutRecords = await run(`${variant}-layout-verify`, player, ['--measure-layout', ui, font, behavior, '--verify']);
    const layout = one(layoutRecords, 'layoutMeasurement');
    assert.equal(layout.layoutMeasurement, true);
    assert.equal(layout.dynamicHtml, variant === 'enabled');
    assert.equal(layout.gpuDeviceRequested, false);
    assert(layout.initial && layout.verification?.positive);
    loading(layoutRecords, variant);
    if (variant === 'enabled') assert.equal(layout.verification.dynamicMarkup, true);
    else {
      assert.equal(layout.verification.treePreserved, true);
      assert.deepEqual(layout.verification.rejected.map(item => item.operation).sort(), [...rejectionNames].sort());
      for (const rejection of layout.verification.rejected) assert.match(rejection.message, /HTML pars|restricted artifact/i);
    }
    report.variants[variant] = { description, layout, loading: loading(layoutRecords, variant) };
    if (values['cpu-only']) continue;
    const windowRecords = await run(`${variant}-window`, player, ['--compiled-ui', ui, font, module, '--frames', '120']);
    const completion = one(windowRecords, 'nativeDomWindow');
    assert.equal(completion.nativeDomWindow, true);
    assert.equal(completion.backend, 'Metal');
    assert.equal(completion.presentedFrames, 120);
    assert.equal(completion.cpuImageTransport, false);
    assert.equal(completion.nativeDeviceIdentityChecked, true);
    assert.equal(completion.nativeQueueIdentityChecked, true);
    assert(completion.canvasSnapshots > 0, 'No canvas snapshots were transported.');
    const phases = windowRecords.filter(record => Object.hasOwn(record, 'uiPhase'));
    assert.deepEqual(phases.map(record => record.uiPhase), ['initial', 'mutated']);
    for (const phase of phases) assert(phase.result && Array.isArray(phase.result.samples));
    assert.equal(phases[0].result.clicks, 0);
    assert.equal(phases[1].result.clicks, 1);
    report.variants[variant] = { description, layout, completion, loading: loading(windowRecords, variant),
      observations: Object.fromEntries(phases.map(record => [record.uiPhase, record.result])) };
    await save();
  }
  assert.deepEqual(report.variants.enabled.layout.initial, report.variants.disabled.layout.initial);
  assert.deepEqual(report.variants.enabled.layout.verification.positive, report.variants.disabled.layout.verification.positive);
  if (!values['cpu-only']) {
    assert.deepEqual(report.variants.enabled.observations, report.variants.disabled.observations);
    report.nativeWindowValidated = true;
  }
  const badUi = join(runDirectory, 'unsupported-iframe.ui.json');
  const badHtml = sources['index.html'].toString('utf8').replace('</body>', '<iframe srcdoc="<p>Requires parsing</p>"></iframe></body>');
  assert.notEqual(badHtml, sources['index.html'].toString('utf8'));
  await writeFile(badUi, JSON.stringify(compileHtml(badHtml, { sourceName: 'unsupported-iframe-control.html' })));
  await run('disabled-iframe', players.disabled, ['--measure-layout', badUi, font, behavior, '--verify'], /unsupported compiled UI capability: HTML iframe requires a configured dynamic HTML parser/);
  report.unsupportedIframeRejected = true;
  const foreignUi = join(runDirectory, 'unsupported-foreign-iframe.ui.json');
  const foreign = compileHtml(badHtml, { sourceName: 'unsupported-foreign-iframe-control.html' });
  const iframe = foreign.nodes.find(node => node.kind === 'element' && node.name === 'iframe');
  iframe.namespace = 'http://www.w3.org/2000/svg';
  await writeFile(foreignUi, JSON.stringify(foreign));
  await run('disabled-foreign-iframe', players.disabled, ['--measure-layout', foreignUi, font, behavior, '--verify'], /unsupported compiled UI capability:.*iframe.*parser/);
  report.unsupportedForeignIframeRejected = true;
  if (values.browser) {
    report.browser = await withBrowserSession(resolve(values.browser), async ({ command, origin, signal }) => {
      async function evaluate(expression, awaitPromise = false) {
        const response = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
        assert(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
        return response.result.value;
      }
      await command('Page.enable');
      await command('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
      const url = `${origin}/fixtures/parser-omission/index.html`;
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
        const bytes=Uint8Array.from(atob(${JSON.stringify((await readFile(font)).toString('base64'))}), c=>c.charCodeAt(0));
        const face=new FontFace('3JSN Fixture',bytes); await face.load(); document.fonts.add(face);
        await document.fonts.ready;
        ${sources['behavior.js'].toString('utf8')}
      })()`, true);
      return { version: await command('Browser.getVersion'), initial: await evaluate('uiProbe.snapshot()'),
        positive: await evaluate('uiProbe.mutate()') };
    });
    const differences = [];
    function compare(actual, expected, path) {
      if (typeof expected === 'number' && path.includes('.rect.')) {
        if (typeof actual !== 'number' || Math.abs(actual - expected) > 0.25) differences.push({ path, actual, expected });
      } else if (expected !== null && typeof expected === 'object') {
        if (!actual || typeof actual !== 'object') differences.push({ path, actual, expected });
        else for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) compare(actual[key], expected[key], `${path}.${key}`);
      } else if (actual !== expected) differences.push({ path, actual, expected });
    }
    compare(report.variants.disabled.layout.initial, report.browser.initial, 'initial');
    compare(report.variants.disabled.layout.verification.positive, report.browser.positive, 'positive');
    report.browser.differences = differences;
    report.browser.rectangleToleranceCssPixels = 0.25;
  }
  for (const [name, path] of Object.entries(identityPaths)) assert.equal(hash(await readFile(path)), report.inputs[name].sha256, `Runtime changed ${name}`);
  for (const [name, path] of Object.entries(sourcePaths)) assert.equal(hash(await readFile(path)), report.sourceHashes[name], `Source changed: ${name}`);
  report.sourcePreserved = true;
  report.networkDenied = true;
  report.testedDomObservationsEquivalent = true;
  report.status = report.browser?.differences.length ? 'partial' : 'passed';
  await save();
  console.log(JSON.stringify({ status: report.status, report: join(output, 'report.json') }));
  if (report.status === 'partial') process.exitCode = 1;
} catch (error) {
  report.status = 'failed';
  report.failure = { message: error.message, stack: error.stack };
  await save();
  throw error;
}
