import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { build } from 'esbuild';
import { withBrowserSession } from './compatibility/browser-session.mjs';
import { snapshotTree } from './compatibility/snapshot.mjs';

const root = resolve(import.meta.dirname, '..'), execute = promisify(execFile);
const { values } = parseArgs({ options: {
  ...Object.fromEntries(['preserved', 'restricted', 'font', 'out', 'browser'].map(name => [name, { type: 'string' }])),
  'cpu-only': { type: 'boolean', default: false },
}, strict: true });
assert(process.platform === 'darwin' && process.arch === 'arm64'
  && ['preserved', 'restricted', 'font', 'out', 'browser'].every(key => values[key]),
'Usage: node scripts/probe-react-dom.mjs --preserved EXE --restricted EXE --font FONT --out NEWDIR --browser CHROME [--cpu-only] (macOS arm64)');
assert.notEqual(resolve(values.preserved), resolve(values.restricted), 'Supply distinct parser-mode binaries.');
const output = resolve(values.out), fixture = join(root, 'fixtures/react-dom'), source = join(output, 'input');
const outputRelative = relative(root, output);
assert(outputRelative.startsWith('artifacts/') && !isAbsolute(outputRelative),
  'Use a fresh output under checkout artifacts/ for dependency resolution and source-denial isolation.');
await mkdir(output);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function identity(path) { const bytes = await readFile(path); return { path, bytes: bytes.length, sha256: hash(bytes) }; }
const report = { status: 'running', cpuOnly: values['cpu-only'], nativeWindowValidated: false, steps: [], modes: {}, knownDifferences: [], limits: [
  'One public client-rendered React fixture; no general React/framework or browser compatibility certification.',
  'Semantic DOM/event/effect observations are compared exactly; no geometry, pixel equivalence or performance claim.',
  'Synthetic dispatched clicks do not establish native OS input behavior.',
  'CPU/browser behavior explicitly uses development React, matching the unmodified build CLI default for native windows.',
  'Parser capability declarations and successful execution do not prove exact-binary parser linkage.',
  'Mixed HTMLCollection ID/name collisions follow the DOM first-match rule natively; Chrome 153 prefers ID. That observable difference is retained explicitly.',
] };
const save = () => writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
const processOptions = { cwd: root, timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 };
async function recorded(label, executable, args, options = processOptions, expectedFailure) {
  let stdout = '', stderr = '', failure;
  try { ({ stdout, stderr } = await execute(executable, args, options)); }
  catch (error) { stdout = error.stdout ?? ''; stderr = error.stderr ?? String(error); failure = error; }
  await writeFile(join(output, `${label}-stdout.txt`), stdout);
  await writeFile(join(output, `${label}-stderr.txt`), stderr);
  report.steps.push({ label, expectedFailure: Boolean(expectedFailure), exitCode: failure?.code ?? 0,
    signal: failure?.signal ?? null, stdout: `${label}-stdout.txt`, stderr: `${label}-stderr.txt` });
  await save();
  if (expectedFailure) {
    assert(failure && failure.code === 1 && !failure.killed && !failure.signal, `${label}: expected diagnostic exit 1`);
    assert.match(stderr, expectedFailure);
  } else if (failure) throw failure;
  return stdout.split('\n').filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line));
}
function one(records, field) {
  const matches = records.filter(record => Object.hasOwn(record, field));
  assert.equal(matches.length, 1, `Expected exactly one ${field} record`);
  return matches[0];
}
function compareInitial(actual, expected, label) {
  const path = 'domContract.collections.namedCollision';
  const native = actual.domContract.collections.namedCollision;
  const browser = expected.domContract.collections.namedCollision;
  assert.deepEqual(native, { property: 'first', namedItem: 'first' }, `${label}: native DOM first-match rule`);
  assert.deepEqual(browser, { property: 'second', namedItem: 'second' }, `${label}: recorded Chrome collision behavior changed`);
  report.knownDifferences.push({ label, path, native, browser,
    rule: 'https://dom.spec.whatwg.org/#dom-htmlcollection-nameditem' });
  const withoutCollision = value => {
    const copy = structuredClone(value);
    delete copy.domContract.collections.namedCollision;
    return copy;
  };
  assert.deepEqual(withoutCollision(actual), withoutCollision(expected), `${label}: unexpected browser/native observations differ`);
}

try {
  report.sourceBefore = await snapshotTree(fixture);
  report.dependencies = Object.fromEntries(await Promise.all(['react', 'react-dom', 'scheduler', 'three', 'esbuild'].map(async name => {
    const path = join(root, 'node_modules', name, 'package.json');
    return [name, { version: (await json(path)).version, ...await identity(path) }];
  })));
  report.lockfile = await identity(join(root, 'package-lock.json'));
  await cp(fixture, source, { recursive: true });
  const copiedBefore = await snapshotTree(source);
  const behavior = join(output, 'behavior.js');
  const bundled = await build({ entryPoints: [join(fixture, 'behavior.mjs')], outfile: behavior,
    bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' },
    metafile: true, logLevel: 'silent' });
  assert.equal(bundled.warnings.length, 0, 'Behavior bundling emitted warnings.');
  await writeFile(join(output, 'behavior-metafile.json'), JSON.stringify(bundled.metafile, null, 2));
  report.behavior = { ...await identity(behavior), format: 'iife', nodeEnv: 'development' };
  const html = await readFile(join(fixture, 'index.html'), 'utf8');
  const referenceHtml = html.replace(/<script type="module" src="\.\/app\.mjs"><\/script>/,
    '<script src="./behavior.js"></script>');
  assert.notEqual(referenceHtml, html, 'Fixture module tag changed; update explicit browser preparation.');
  await writeFile(join(output, 'browser.html'), referenceHtml);
  report.browserHtml = await identity(join(output, 'browser.html'));

  report.browser = await withBrowserSession(resolve(values.browser), async ({ command, origin, signal }) => {
    async function evaluate(expression, awaitPromise = false) {
      const result = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    await command('Page.enable');
    await command('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    // Start from HTML: Chrome's JSON document viewer disables page scripts.
    const url = `${origin}/fixtures/compiled-ui/dashboard.html`;
    await command('Page.navigate', { url });
    let ready = false;
    for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
      signal.throwIfAborted();
      try { ready = await evaluate(`location.href===${JSON.stringify(url)} && document.readyState==='complete'`); }
      catch (error) { if (!/context.*destroyed|Cannot find context/i.test(error.message)) throw error; }
      if (ready) break;
      await delay(25, undefined, { signal });
    }
    assert(ready, 'Browser origin navigation timed out.');
    // The shared server serves only fixture paths; use a same-origin Blob for the generated external script.
    const scriptUrl = await evaluate(`URL.createObjectURL(new Blob([${JSON.stringify(await readFile(behavior, 'utf8'))}],{type:'application/javascript'}))`);
    const errors = `globalThis.__reactProbeErrors=[];addEventListener('error',e=>__reactProbeErrors.push(String(e.error?.stack||e.message||('Resource error: '+e.target?.src))),true);addEventListener('unhandledrejection',e=>__reactProbeErrors.push(String(e.reason?.stack||e.reason)));const originalConsoleError=console.error;console.error=(...args)=>{__reactProbeErrors.push(args.map(String).join(' '));originalConsoleError(...args);};`;
    const browserHtml = referenceHtml.replace('<head>', `<head><script>${errors}</script>`)
      .replace('src="./behavior.js"', `src="${scriptUrl}"`);
    const frame = (await command('Page.getFrameTree')).frameTree.frame.id;
    await command('Page.setDocumentContent', { frameId: frame, html: browserHtml });
    ready = false;
    for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
      signal.throwIfAborted();
      const state = await evaluate('({ready:typeof uiProbe!=="undefined",errors:globalThis.__reactProbeErrors||[]})');
      assert.deepEqual(state.errors, [], 'Browser script errors.');
      if (state.ready) { ready = true; break; }
      await delay(25, undefined, { signal });
    }
    assert(ready, 'Browser behavior script did not initialize.');
    const initial = await evaluate('uiProbe.snapshot()', true);
    const verification = await evaluate('uiProbe.verify()', true);
    assert.equal(verification?.passed, true, 'Browser React verification failed.');
    const browserErrors = await evaluate('__reactProbeErrors');
    assert.deepEqual(browserErrors, [], 'Browser errors occurred during verification.');
    return { version: await command('Browser.getVersion'), initial, verification, errors: browserErrors,
      transport: 'Original fixture HTML with its module replaced by the generated behavior IIFE as a same-origin Blob external script.' };
  });
  await save();

  const packages = {};
  for (const mode of ['preserved', 'restricted']) {
    const destination = join(output, `built-${mode}`);
    await recorded(`build-${mode}`, process.execPath, [join(root, 'packages/cli/cli.mjs'), 'build', source,
      '--runtime', resolve(values[mode]), '--font', resolve(values.font), '--out', destination,
      '--html-parser', mode, '--experimental']);
    const manifest = await json(join(destination, 'app.json'));
    const metadata = await json(join(destination, 'metadata/build.json'));
    assert.equal(manifest.profile, 'compiled-dom-window-v1');
    assert.equal(manifest.compiledUi.htmlParser, mode);
    assert.equal(Object.hasOwn(manifest, 'html'), false);
    assert(!manifest.files.some(file => /\.html?$/i.test(file.path)), 'Package contains HTML.');
    const relocated = join(output, `React native ${mode} é #`);
    await rename(destination, relocated);
    packages[mode] = { relocated, manifest };
    report.modes[mode] = { executable: await identity(join(relocated, manifest.name)),
      manifest: await identity(join(relocated, 'app.json')), module: await identity(join(relocated, manifest.entry)),
      ui: await identity(join(relocated, manifest.compiledUi.path)), description: metadata.runtime.description,
      moduleBuild: metadata.esbuild.options };
    assert.equal(report.modes[mode].executable.sha256, (await identity(resolve(values[mode]))).sha256);
  }
  assert.deepEqual(await snapshotTree(source), copiedBefore, 'Copied fixture changed during builds.');
  report.copiedSourcePreserved = true;
  await rm(source, { recursive: true });
  report.copiedSourceRemoved = true;
  const policy = join(output, 'native-offline.sb');
  const denied = ['.cache', 'node_modules', 'crates', 'experiments', 'examples', 'fixtures'].map(path => join(root, path)).concat(source);
  await writeFile(policy, `(version 1)\n(allow default)\n(deny network*)\n(deny file-read*\n${denied.map(path => ` (subpath ${JSON.stringify(path)})`).join('\n')}\n)\n`);
  const cwd = join(output, 'unrelated directory'); await mkdir(cwd);
  const nativeOptions = { ...processOptions, cwd, env: { ...process.env, PATH: '/usr/bin:/bin', MTL_DEBUG_LAYER: '1' } };
  for (const [index, path] of [join(fixture, 'index.html'), join(root, 'node_modules/react/package.json')].entries()) {
    await recorded(`denied-read-${index}`, '/usr/bin/sandbox-exec', ['-f', policy, '/bin/cat', path], nativeOptions, /Operation not permitted/);
  }
  for (const mode of ['preserved', 'restricted']) {
    const { relocated, manifest } = packages[mode], executable = join(relocated, manifest.name);
    const run = (label, args) => recorded(`${mode}-${label}`, '/usr/bin/sandbox-exec', ['-f', policy, executable, ...args], nativeOptions);
    await run('verify', ['--verify-app', join(relocated, 'app.json')]);
    const records = await run('measure', ['--measure-app', join(relocated, 'app.json'), behavior, '--verify']);
    const measured = one(records, 'layoutMeasurement');
    report.modes[mode].cpu = measured;
    await save();
    assert.equal(measured.dynamicHtml, mode === 'preserved');
    assert.equal(measured.gpuDeviceRequested, false);
    assert.equal(measured.verification?.passed, true);
    compareInitial(measured.initial, report.browser.initial, `${mode}: CPU initial`);
    assert.deepEqual(measured.verification, report.browser.verification, `${mode}: verified browser/native observations differ`);
    if (!values['cpu-only']) {
      const windowRecords = await run('native', ['--frames', '120']);
      const completion = one(windowRecords, 'nativeDomWindow');
      const phases = windowRecords.filter(record => Object.hasOwn(record, 'reactPhase'));
      report.modes[mode].native = { completion, phases };
      await save();
      assert.equal(completion.nativeDomWindow, true);
      assert.equal(completion.presentedFrames, 120);
      assert.equal(completion.backend, 'Metal');
      assert.equal(completion.cpuImageTransport, false);
      assert.equal(completion.nativeDeviceIdentityChecked, true);
      assert.equal(completion.nativeQueueIdentityChecked, true);
      assert(completion.canvasSnapshots > 0);
      assert.deepEqual(phases.map(record => record.reactPhase), ['initial', 'verified']);
      assert.equal(phases[1].result?.passed, true, 'Window React verification never passed.');
      compareInitial(phases[0].result, report.browser.initial, `${mode}: window initial`);
      assert.deepEqual(phases[1].result, report.browser.verification, `${mode}: window verified observations differ`);
    }
    assert.equal((await identity(executable)).sha256, report.modes[mode].executable.sha256, 'Runtime changed.');
  }
  assert.equal((await identity(behavior)).sha256, report.behavior.sha256, 'Behavior bundle changed.');
  report.sourceAfter = await snapshotTree(fixture);
  assert.deepEqual(report.sourceAfter, report.sourceBefore, 'Original fixture changed.');
  report.sourcePreserved = true;
  report.nativeNetworkAndDevelopmentReadsDenied = true;
  report.testedSemanticObservationsEquivalent = report.knownDifferences.length === 0;
  report.reactObservationsEquivalent = true;
  report.otherTestedDomObservationsEquivalent = true;
  report.nativeWindowValidated = !values['cpu-only'];
  report.status = 'passed';
  await save();
  console.log(JSON.stringify({ status: report.status, knownDifferences: report.knownDifferences.length, report: join(output, 'report.json') }));
} catch (error) {
  report.status = 'failed';
  try {
    report.sourceAfter = await snapshotTree(fixture);
    assert.deepEqual(report.sourceAfter, report.sourceBefore);
    report.sourcePreserved = true;
  } catch (preservationError) { report.sourcePreservationError = preservationError.message; }
  report.failure = { message: error.message, stack: error.stack, browserLogTail: error.browserLogTail,
    sessionFailure: error.sessionFailure, terminationSignal: error.terminationSignal };
  await save();
  throw error;
}
