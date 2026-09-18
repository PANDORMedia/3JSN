import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';
import { build } from 'esbuild';
import { withBrowserSession } from './compatibility/browser-session.mjs';
import { snapshotTree } from './compatibility/snapshot.mjs';

const root = resolve(import.meta.dirname, '..'), execute = promisify(execFile);
const { values } = parseArgs({ options: {
  ...Object.fromEntries(['preserved', 'restricted', 'font', 'out', 'browser', 'reference'].map(name => [name, { type: 'string' }])),
  'cpu-only': { type: 'boolean', default: false },
}, strict: true });
assert(process.platform === 'darwin' && process.arch === 'arm64'
  && ['preserved', 'restricted', 'font', 'out'].every(key => values[key]) && (values.browser || values.reference),
'Usage: node scripts/probe-dom-focus.mjs --preserved EXE --restricted EXE --font FONT --out NEWDIR [--browser CHROME | --reference REPORT] [--cpu-only] (macOS arm64)');
assert(!(values.browser && values.reference), 'Choose fresh browser capture or an identity-checked reference.');
assert.notEqual(resolve(values.preserved), resolve(values.restricted), 'Supply distinct parser-mode binaries.');
const output = resolve(values.out), fixture = join(root, 'fixtures/dom-focus'), source = join(output, 'input');
const outputRelative = relative(root, output);
assert(outputRelative.startsWith('artifacts/') && !isAbsolute(outputRelative), 'Use a fresh directory under checkout artifacts/.');
await mkdir(output);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function identity(path) { const bytes = await readFile(path); return { path, bytes: bytes.length, sha256: hash(bytes) }; }
const protectedSources = { focus: fixture, reactAndGenericDom: join(root, 'fixtures/react-dom') };
const snapshots = async () => Object.fromEntries(await Promise.all(Object.entries(protectedSources)
  .map(async ([name, path]) => [name, await snapshotTree(path)])));
const inputs = async () => Promise.all(['index.html', 'behavior.mjs'].map(async name => ({
  ...await identity(join(fixture, name)), path: `fixtures/dom-focus/${name}`,
})));
const report = { schemaVersion: 1, status: 'running', cpuOnly: values['cpu-only'], steps: [], modes: {}, comparisons: [],
  nativeWindowValidated: false, allObservationsEquivalent: false, limits: [
    '44 public programmatic focus cases; no general DOM, focus, accessibility or framework certification.',
    'A disclosed generated HTML wrapper adds a nonfocusable canvas for package admission; this is a harness adapter, not unchanged-game proof.',
    'Event interfaces/trust are compared separately with explicit differences; no observation fields or cases are discarded.',
    'No :focus-visible control, physical OS input, pointer defaults, native sequential-navigation, IME, forms or shadow-DOM claim.',
    'Metal presentation and semantic observations do not establish focus styling pixels, hit testing, scroll behavior or performance.',
    'Window focus checks complete during startup after Three.js/WebGPU initialization, followed by 120 presentations; concurrent focus changes and painting are not measured.',
    'Parser declarations and execution are separate from exact-binary parser-linkage evidence.',
  ] };
const save = () => writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
const cancellation = new AbortController();
const interrupts = new Map(['SIGINT', 'SIGTERM'].map(name => [name, () => cancellation.abort(new Error(`Focus probe interrupted by ${name}`))]));
for (const [name, handler] of interrupts) process.on(name, handler);
const processOptions = { cwd: root, timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, signal: cancellation.signal };
async function recorded(label, executable, args, options = processOptions, expectedFailure) {
  let stdout = '', stderr = '', failure;
  try { ({ stdout, stderr } = await execute(executable, args, options)); }
  catch (error) { stdout = error.stdout ?? ''; stderr = error.stderr ?? String(error); failure = error; }
  await writeFile(join(output, `${label}-stdout.txt`), stdout);
  await writeFile(join(output, `${label}-stderr.txt`), stderr);
  report.steps.push({ label, exitCode: failure?.code ?? 0, signal: failure?.signal ?? null,
    expectedFailure: Boolean(expectedFailure), stdout: `${label}-stdout.txt`, stderr: `${label}-stderr.txt` });
  await save();
  if (expectedFailure) {
    assert(failure?.code === 1 && !failure.killed && !failure.signal, `${label}: expected diagnostic exit 1`);
    assert.match(stderr, expectedFailure);
  } else if (failure) throw failure;
  return stdout.split('\n').filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line));
}
function one(records, field) {
  const matches = records.filter(record => Object.hasOwn(record, field));
  assert.equal(matches.length, 1, `Expected exactly one ${field} record`);
  return matches[0];
}
function requireComplete(value) {
  assert.equal(value?.schemaVersion, 1);
  assert.equal(value.cases?.length, 44, 'All 44 focus cases must complete.');
  assert.equal(new Set(value.cases.map(item => item.name)).size, 44);
  assert(Array.isArray(value.eventInterfaces) && value.eventInterfaces.length === 4);
}
function differences(native, browser, path = '$') {
  if (isDeepStrictEqual(native, browser)) return [];
  if (native !== null && browser !== null && typeof native === 'object' && typeof browser === 'object'
    && Array.isArray(native) === Array.isArray(browser)) {
    const keys = new Set([...Object.keys(native), ...Object.keys(browser)]);
    const output = [...keys].flatMap(key => differences(native[key], browser[key], Array.isArray(native) ? `${path}[${key}]` : `${path}.${key}`));
    if (Array.isArray(native) && native.length !== browser.length) output.unshift({ path: `${path}.length`, native: native.length, browser: browser.length });
    return output;
  }
  return [{ path, native: native === undefined ? { missing: true } : native,
    browser: browser === undefined ? { missing: true } : browser }];
}
function compare(label, native) {
  requireComplete(native);
  const observed = differences(native, report.browser.programmatic).map(item => {
    const interfaceField = /^\$\.eventInterfaces\[\d+\]\.(constructor|focusEvent|isTrusted)$/.exec(item.path)?.[1];
    const known = interfaceField === 'constructor' && item.native === 'Event' && item.browser === 'FocusEvent'
      || interfaceField === 'focusEvent' && item.native === false && item.browser === true
      || interfaceField === 'isTrusted' && item.native === false && item.browser === true;
    return { ...item, category: item.path.startsWith('$.eventInterfaces') ? 'event-interface' : 'semantic-or-contract',
      known, ...(known ? { reason: 'Native focus dispatch currently uses Event with readonly relatedTarget and untrusted script dispatch.' } : {}) };
  });
  const caseComparisons = native.cases.map((item, index) => ({ name: item.name,
    equivalent: isDeepStrictEqual(item, report.browser.programmatic.cases[index]) }));
  report.comparisons.push({ label, allObservationsEquivalent: observed.length === 0,
    semanticObservationsEquivalent: observed.every(item => item.category === 'event-interface'),
    unexpectedDifferences: observed.filter(item => !item.known).length, caseComparisons, differences: observed });
}
async function browserReference() {
  if (values.reference) {
    const path = resolve(values.reference), previous = await json(path);
    assert.equal(previous.sourcePreserved, true);
    assert.deepEqual(previous.sourceBefore, report.fixtureInputs);
    assert.deepEqual(previous.sourceAfter, report.fixtureInputs);
    assert.deepEqual(previous.browser?.errors, []);
    requireComplete(previous.browser.programmatic);
    report.reference = { ...await identity(path), reused: true };
    return previous.browser;
  }
  return withBrowserSession(resolve(values.browser), async ({ command, origin, signal }) => {
    async function evaluate(expression, awaitPromise = false) {
      const result = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    await command('Page.enable');
    await command('Page.addScriptToEvaluateOnNewDocument', { source: `globalThis.__focusErrors=[];addEventListener('error',e=>__focusErrors.push(String(e.error?.stack||e.message)));addEventListener('unhandledrejection',e=>__focusErrors.push(String(e.reason?.stack||e.reason)));` });
    await command('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    const url = `${origin}/fixtures/dom-focus/index.html`;
    await command('Page.navigate', { url });
    await command('Page.bringToFront');
    let ready = false;
    for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
      signal.throwIfAborted(); cancellation.signal.throwIfAborted();
      try { ready = await evaluate(`location.href===${JSON.stringify(url)} && document.readyState==='complete' && typeof focusProbe!=='undefined'`); }
      catch (error) { if (!/context.*destroyed|Cannot find context/i.test(error.message)) throw error; }
      if (ready) break;
      await delay(25, undefined, { signal });
    }
    assert(ready, 'Focus browser fixture did not become ready.');
    const programmatic = await evaluate('focusProbe.run()', true);
    const errors = await evaluate('__focusErrors');
    assert.deepEqual(errors, []);
    requireComplete(programmatic);
    return { version: await command('Browser.getVersion'), viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      programmatic, errors, sequential: { measured: false, reason: 'This harness compares programmatic focus only.' } };
  });
}

try {
  report.sourceBefore = await snapshots();
  report.fixtureInputs = await inputs();
  report.runtimeInputs = Object.fromEntries(await Promise.all(['preserved', 'restricted']
    .map(async mode => [mode, await identity(resolve(values[mode]))])));
  report.fontInput = await identity(resolve(values.font));
  report.dependencies = Object.fromEntries(await Promise.all(['three', 'esbuild'].map(async name => {
    const path = join(root, 'node_modules', name, 'package.json');
    return [name, { version: (await json(path)).version, ...await identity(path) }];
  })));
  report.lockfile = await identity(join(root, 'package-lock.json'));
  report.browser = await browserReference();
  await save();
  const behavior = join(output, 'behavior.js');
  const bundled = await build({ stdin: { resolveDir: fixture, sourcefile: 'focus-cpu-adapter.mjs', loader: 'js', contents:
    `import {runFocusBehavior} from './behavior.mjs';let result;globalThis.uiProbe={snapshot:()=>result??=runFocusBehavior(),verify:async()=>{const value=await(result??=runFocusBehavior());return{completed:true,cases:value.cases.length};}};` },
  outfile: behavior, bundle: true, platform: 'browser', format: 'iife', metafile: true, logLevel: 'silent' });
  assert.equal(bundled.warnings.length, 0);
  await writeFile(join(output, 'behavior-metafile.json'), JSON.stringify(bundled.metafile, null, 2));
  report.behavior = await identity(behavior);
  await cp(fixture, source, { recursive: true });
  const originalHtml = await readFile(join(fixture, 'index.html'), 'utf8');
  const generatedHtml = originalHtml.replace('<script type="module" src="./behavior.mjs"></script>',
    '<canvas id="scene" width="320" height="180" style="display:block;width:320px;height:180px"></canvas>\n  <script type="module" src="./app.mjs"></script>');
  assert.notEqual(generatedHtml, originalHtml, 'The frozen HTML module tag changed.');
  await writeFile(join(source, 'index.html'), generatedHtml);
  await writeFile(join(output, 'generated-window.html'), generatedHtml);
  report.generatedWrapper = { original: await identity(join(fixture, 'index.html')),
    generated: await identity(join(output, 'generated-window.html')),
    changes: 'Added one nonfocusable canvas and changed module src from behavior.mjs to app.mjs in the disposable package input only.' };
  const copiedBefore = await snapshotTree(source), packages = {};
  report.packageInputBefore = copiedBefore;
  for (const mode of ['preserved', 'restricted']) {
    cancellation.signal.throwIfAborted();
    const destination = join(output, `built-${mode}`);
    await recorded(`build-${mode}`, process.execPath, [join(root, 'packages/cli/cli.mjs'), 'build', source,
      '--runtime', resolve(values[mode]), '--font', resolve(values.font), '--out', destination,
      '--html-parser', mode, '--experimental']);
    const manifest = await json(join(destination, 'app.json')), metadata = await json(join(destination, 'metadata/build.json'));
    assert.equal(manifest.profile, 'compiled-dom-window-v1');
    assert.equal(manifest.compiledUi.htmlParser, mode);
    assert.equal(Object.hasOwn(manifest, 'html'), false);
    assert(!manifest.files.some(file => /\.html?$/i.test(file.path)));
    const relocated = join(output, `Focus native ${mode} é #`);
    await rename(destination, relocated);
    packages[mode] = { relocated, manifest };
    report.modes[mode] = { executable: await identity(join(relocated, manifest.name)),
      manifest: await identity(join(relocated, 'app.json')), module: await identity(join(relocated, manifest.entry)),
      ui: await identity(join(relocated, manifest.compiledUi.path)), description: metadata.runtime.description };
    assert.equal(report.modes[mode].executable.sha256, report.runtimeInputs[mode].sha256);
  }
  report.packageInputAfter = await snapshotTree(source);
  assert.deepEqual(report.packageInputAfter, copiedBefore, 'Generated package input changed during builds.');
  report.copiedSourcePreserved = true;
  await rm(source, { recursive: true });
  report.copiedSourceRemoved = true;
  const policy = join(output, 'native-offline.sb');
  const denied = ['.cache', 'node_modules', 'crates', 'experiments', 'examples', 'fixtures'].map(path => join(root, path)).concat(source);
  await writeFile(policy, `(version 1)\n(allow default)\n(deny network*)\n(deny file-read*\n${denied.map(path => ` (subpath ${JSON.stringify(path)})`).join('\n')}\n)\n`);
  const cwd = join(output, 'unrelated directory'); await mkdir(cwd);
  const nativeOptions = { ...processOptions, cwd, env: { ...process.env, PATH: '/usr/bin:/bin', MTL_DEBUG_LAYER: '1' } };
  for (const [index, path] of [join(fixture, 'behavior.mjs'), join(root, 'fixtures/react-dom/dom-contract.mjs')].entries()) {
    await recorded(`denied-read-${index}`, '/usr/bin/sandbox-exec', ['-f', policy, '/bin/cat', path], nativeOptions, /Operation not permitted/);
  }
  for (const mode of ['preserved', 'restricted']) {
    const { relocated, manifest } = packages[mode], executable = join(relocated, manifest.name);
    const run = (label, args) => recorded(`${mode}-${label}`, '/usr/bin/sandbox-exec', ['-f', policy, executable, ...args], nativeOptions);
    for (const phase of values['cpu-only'] ? ['cpu'] : ['cpu', 'window']) {
      cancellation.signal.throwIfAborted();
      try {
        if (phase === 'cpu') {
          await run('verify', ['--verify-app', join(relocated, 'app.json')]);
          const measured = one(await run('measure', ['--measure-app', join(relocated, 'app.json'), behavior, '--verify']), 'layoutMeasurement');
          report.modes[mode].cpu = measured;
          assert.equal(measured.dynamicHtml, mode === 'preserved');
          assert.equal(measured.gpuDeviceRequested, false);
          assert.deepEqual(measured.verification, { completed: true, cases: 44 });
          compare(`${mode}:cpu`, measured.initial);
        } else {
          const records = await run('native', ['--frames', '120']);
          const completion = one(records, 'nativeDomWindow'), result = one(records, 'focusPhase');
          report.modes[mode].window = { completion, result };
          assert.equal(result.focusPhase, 'complete');
          assert.equal(result.completionStage, 'startup-before-animation-loop');
          assert(records.indexOf(result) < records.indexOf(completion), 'Focus completion must precede native presentation completion.');
          assert.equal(completion.nativeDomWindow, true);
          assert.equal(completion.presentedFrames, 120);
          assert.equal(completion.backend, 'Metal');
          assert.equal(completion.cpuImageTransport, false);
          assert.equal(completion.nativeDeviceIdentityChecked, true);
          assert.equal(completion.nativeQueueIdentityChecked, true);
          assert(completion.canvasSnapshots > 0);
          compare(`${mode}:window`, result.result);
          report.modes[mode].windowValidated = true;
        }
      } catch (error) {
        report.modes[mode][`${phase}Failure`] = { message: error.message, stack: error.stack };
      }
      await save();
    }
    assert.equal((await identity(executable)).sha256, report.modes[mode].executable.sha256, 'Runtime changed.');
    assert.equal((await identity(resolve(values[mode]))).sha256, report.runtimeInputs[mode].sha256, 'Supplied runtime changed.');
  }
  assert.equal((await identity(behavior)).sha256, report.behavior.sha256, 'Behavior bundle changed.');
  assert.equal((await identity(resolve(values.font))).sha256, report.fontInput.sha256, 'Supplied font changed.');
  report.nativeNetworkAndDevelopmentReadsDenied = true;
  report.sourceAfter = await snapshots();
  assert.deepEqual(report.sourceAfter, report.sourceBefore, 'Focus or React/generic fixture source changed.');
  report.sourcePreserved = true;
  const expectedComparisons = values['cpu-only'] ? 2 : 4;
  report.allObservationsEquivalent = report.comparisons.length === expectedComparisons && report.comparisons.every(value => value.allObservationsEquivalent);
  report.semanticObservationsEquivalent = report.comparisons.length === expectedComparisons && report.comparisons.every(value => value.semanticObservationsEquivalent);
  report.nativeWindowValidated = !values['cpu-only'] && Object.values(report.modes).every(value => value.windowValidated);
  const failed = report.comparisons.length !== expectedComparisons || report.comparisons.some(value => value.unexpectedDifferences)
    || Object.values(report.modes).some(value => value.cpuFailure || value.windowFailure);
  report.status = failed ? 'failed' : report.allObservationsEquivalent ? 'passed' : 'passed-with-known-interface-differences';
  await save();
  console.log(JSON.stringify({ status: report.status, allObservationsEquivalent: report.allObservationsEquivalent, report: join(output, 'report.json') }));
  if (failed) process.exitCode = 1;
} catch (error) {
  report.status = 'failed';
  try {
    report.sourceAfter = await snapshots();
    assert.deepEqual(report.sourceAfter, report.sourceBefore);
    report.sourcePreserved = true;
  } catch (preservationError) { report.sourcePreservationError = preservationError.message; }
  report.failure = { message: error.message, stack: error.stack, browserLogTail: error.browserLogTail,
    sessionFailure: error.sessionFailure, terminationSignal: error.terminationSignal };
  await save();
  throw error;
} finally {
  for (const [name, handler] of interrupts) process.off(name, handler);
}
