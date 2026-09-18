import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { compileHtml } from '../experiments/compiled-ui/compiler.mjs';

const root = resolve(import.meta.dirname, '..'), execute = promisify(execFile);
const { values } = parseArgs({ options: Object.fromEntries(
  ['preserved', 'restricted', 'font', 'out'].map(name => [name, { type: 'string' }]),
), strict: true });
assert(process.platform === 'darwin' && process.arch === 'arm64'
  && ['preserved', 'restricted', 'font', 'out'].every(key => values[key]),
'Usage: node scripts/probe-dom-window-completion.mjs --preserved EXE --restricted EXE --font FONT --out NEWDIR (macOS arm64)');
assert.notEqual(resolve(values.preserved), resolve(values.restricted), 'Supply distinct parser-mode binaries.');
const output = resolve(values.out), outputRelative = relative(root, output);
assert(outputRelative.startsWith('artifacts/') && !isAbsolute(outputRelative), 'Use a fresh directory under checkout artifacts/.');
await mkdir(output);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function identity(path) { const bytes = await readFile(path); return { path, bytes: bytes.length, sha256: hash(bytes) }; }
const report = { status: 'running', nativeWindowValidated: false, frameLimits: [1, 4, 120], repetitions: 2,
  steps: [], modes: {}, limits: [
    'Direct compiled-UI host invocation with one public WebGPU clear-pass canvas; no React, Three.js, pixel-parity or performance claim.',
    'RAF count assumes a visible, unchanged window: one startup callback plus one callback per composed/presented frame. Resizing or occluding the window invalidates that control.',
    'Exercises successful frame-budget completion and pre-limit application errors; user-close and deadline interruption are separate gates.',
    'Parser feature descriptions do not establish binary linkage or parser omission.',
  ] };
const save = () => writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Native frame completion control</title>
<style>body{margin:16px;background:#14202c;color:white;font:16px sans-serif}canvas{display:block;width:320px;height:180px}</style>
</head><body><p>Native frame completion control</p><canvas id="scene" width="320" height="180"></canvas></body></html>
`;

function moduleSource(limit, failure = null) {
  return `const expectedPresentations = ${limit};
const failure = ${JSON.stringify(failure)};
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Hardware WebGPU adapter required');
const device = await adapter.requestDevice();
device.addEventListener('uncapturederror', event => { throw event.error; });
const canvas = document.getElementById('scene');
const context = canvas.getContext('webgpu');
context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(),
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, alphaMode: 'opaque' });
let callback = 0;
function frame() {
  callback++;
  console.log(JSON.stringify({ completionProbe: 'callback-start', callback }));
  if (callback > expectedPresentations + 1) throw new Error('COMPLETION_PROBE_EXTRA_CALLBACK');
  if (failure && callback === 3) {
    console.log(JSON.stringify({ completionProbe: 'expected-failure', kind: failure, callback }));
    if (failure === 'javascript') throw new Error('COMPLETION_PROBE_ORDINARY_JS_ERROR');
    device.createCommandEncoder().beginRenderPass({ colorAttachments: 7 });
    throw new Error('COMPLETION_PROBE_INVALID_DESCRIPTOR_WAS_ACCEPTED');
  }
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{
    view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store',
    clearValue: { r: (callback % 8) / 8, g: 0.25, b: 0.5, a: 1 },
  }] });
  pass.end();
  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(frame);
  console.log(JSON.stringify({ completionProbe: 'callback-end', callback }));
}
requestAnimationFrame(frame);
`;
}

function one(records, field) {
  const selected = records.filter(record => Object.hasOwn(record, field));
  assert.equal(selected.length, 1, `Expected exactly one ${field} record`);
  return selected[0];
}
function callbacks(records, count, completed = count) {
  const expected = length => Array.from({ length }, (_, index) => index + 1);
  const starts = records.filter(record => record.completionProbe === 'callback-start').map(record => record.callback);
  const ends = records.filter(record => record.completionProbe === 'callback-end').map(record => record.callback);
  assert.deepEqual(starts, expected(count), 'Unexpected callback starts; check logs for work beyond the final frame or viewport interference.');
  assert.deepEqual(ends, expected(completed), 'Unexpected completed callbacks.');
  return { started: starts.length, completed: ends.length, first: starts[0], last: starts.at(-1) };
}

try {
  const runDirectory = join(output, 'Native completion é #');
  await mkdir(runDirectory);
  const font = join(runDirectory, 'font.woff2'), original = join(runDirectory, 'original.html'), ui = join(runDirectory, 'ui.json');
  await copyFile(resolve(values.font), font);
  await writeFile(original, html);
  const compiled = compileHtml(html, { sourceName: 'dom-window-completion.html' });
  assert.equal(compiled.diagnosticsTotal, 0, 'Minimal fixture must parse without recovery diagnostics.');
  assert.equal(compiled.source.sha256, hash(html));
  await writeFile(ui, `${JSON.stringify(compiled)}\n`);
  const modules = {};
  for (const limit of report.frameLimits) modules[`frames-${limit}`] = moduleSource(limit);
  modules['error-javascript'] = moduleSource(120, 'javascript');
  modules['error-descriptor'] = moduleSource(120, 'descriptor');
  const modulePaths = {};
  for (const [name, source] of Object.entries(modules)) {
    modulePaths[name] = join(runDirectory, `${name}.mjs`);
    await writeFile(modulePaths[name], source);
  }
  const players = {};
  report.binaryInputs = {};
  for (const mode of ['preserved', 'restricted']) {
    report.binaryInputs[mode] = await identity(resolve(values[mode]));
    players[mode] = join(runDirectory, `runtime-${mode}`);
    await copyFile(resolve(values[mode]), players[mode]);
    await chmod(players[mode], 0o755);
    assert.equal((await identity(players[mode])).sha256, report.binaryInputs[mode].sha256, 'Copied binary differs.');
  }
  const policy = join(output, 'native-offline.sb');
  const denied = ['.cache', 'node_modules', 'crates', 'experiments', 'examples', 'fixtures'].map(path => join(root, path));
  await writeFile(policy, `(version 1)\n(allow default)\n(deny network*)\n(deny file-read*\n${denied.map(path => ` (subpath ${JSON.stringify(path)})`).join('\n')}\n (literal ${JSON.stringify(original)}))\n`);
  const inputs = { harness: resolve(import.meta.filename), compiler: join(root, 'experiments/compiled-ui/compiler.mjs'),
    font, original, ui, policy, ...players, ...modulePaths };
  report.inputs = Object.fromEntries(await Promise.all(Object.entries(inputs).map(async ([name, path]) => [name, await identity(path)])));
  await save();
  const options = { cwd: runDirectory, env: { ...process.env, PATH: '/usr/bin:/bin', MTL_DEBUG_LAYER: '1' },
    timeout: 100_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 };
  async function run(label, executable, args, expectedFailure) {
    let stdout = '', stderr = '', failure;
    const started = performance.now();
    try { ({ stdout, stderr } = await execute('/usr/bin/sandbox-exec', ['-f', policy, executable, ...args], options)); }
    catch (error) { stdout = error.stdout ?? ''; stderr = error.stderr ?? String(error); failure = error; }
    await writeFile(join(output, `${label}-stdout.txt`), stdout);
    await writeFile(join(output, `${label}-stderr.txt`), stderr);
    const step = { label, executable, args, expectedFailure: expectedFailure?.source ?? null,
      exitCode: failure?.code ?? 0, signal: failure?.signal ?? null, killed: failure?.killed ?? false,
      elapsedMs: Math.round(performance.now() - started), stdout: `${label}-stdout.txt`, stderr: `${label}-stderr.txt` };
    report.steps.push(step);
    await save();
    if (expectedFailure) {
      assert(failure?.code === 1 && !failure.killed && !failure.signal, `${label}: expected explicit exit 1, not success, timeout or signal`);
      assert.match(stderr, expectedFailure, `${label}: missing expected application diagnostic`);
    } else if (failure) throw failure;
    const records = stdout.split('\n').filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line));
    return { records, step };
  }
  await run('denied-original-html', '/bin/cat', [original], /Operation not permitted/);
  report.originalHtmlReadDenied = true;
  for (const mode of ['preserved', 'restricted']) {
    const { records } = await run(`${mode}-describe`, players[mode], ['--describe']);
    const description = one(records, 'experiment');
    assert.equal(description.experiment, 'compiled-ui-runtime');
    assert.equal(description.dynamicHtml, mode === 'preserved');
    report.modes[mode] = { description, positive: [], negative: [] };
    for (const limit of report.frameLimits) {
      for (let repetition = 1; repetition <= report.repetitions; repetition++) {
        const label = `${mode}-frames-${limit}-repeat-${repetition}`;
        const { records } = await run(label, players[mode], ['--compiled-ui', ui, font, modulePaths[`frames-${limit}`], '--frames', String(limit)]);
        const loading = one(records, 'compiledUi').compiledUi;
        assert.equal(loading.initialDocumentHtmlParserUsed, false);
        assert.equal(loading.dynamicHtmlParserProvider, mode === 'preserved' ? 'blitz-html' : 'absent');
        const completion = one(records, 'nativeDomWindow');
        assert.equal(completion.presentedFrames, limit);
        assert.equal(completion.backend, 'Metal');
        assert.equal(completion.cpuImageTransport, false);
        assert.equal(completion.nativeDeviceIdentityChecked, true);
        assert.equal(completion.nativeQueueIdentityChecked, true);
        assert.equal(completion.canvasSnapshots, limit);
        const progression = callbacks(records, limit + 1);
        assert.equal(records.at(-1), completion, 'Completion must be the final JSON record.');
        report.modes[mode].positive.push({ label, limit, repetition, completion, callbacks: progression });
        await save();
      }
    }
    for (const [kind, diagnostic] of [
      ['javascript', /COMPLETION_PROBE_ORDINARY_JS_ERROR/],
      ['descriptor', /colorAttachments.*GPURenderPassDescriptor.*sequence/],
    ]) {
      const label = `${mode}-error-${kind}`;
      const { records } = await run(label, players[mode], ['--compiled-ui', ui, font, modulePaths[`error-${kind}`], '--frames', '120'], diagnostic);
      assert(!records.some(record => Object.hasOwn(record, 'nativeDomWindow')), 'Application failure was reported as native success.');
      const failures = records.filter(record => record.completionProbe === 'expected-failure');
      assert.deepEqual(failures, [{ completionProbe: 'expected-failure', kind, callback: 3 }]);
      report.modes[mode].negative.push({ label, kind, frameLimit: 120, failedCallback: 3, callbacks: callbacks(records, 3, 2) });
      await save();
    }
  }
  report.inputsAfter = Object.fromEntries(await Promise.all(Object.entries(inputs).map(async ([name, path]) => [name, await identity(path)])));
  assert.deepEqual(report.inputsAfter, report.inputs, 'Probe inputs changed during execution.');
  for (const mode of ['preserved', 'restricted']) assert.deepEqual(await identity(resolve(values[mode])), report.binaryInputs[mode]);
  report.nativeWindowValidated = true;
  report.status = 'passed';
  await save();
  console.log(JSON.stringify({ status: report.status, report: join(output, 'report.json') }));
} catch (error) {
  report.status = 'failed';
  report.failure = { message: error.message, stack: error.stack };
  await save();
  throw error;
}
