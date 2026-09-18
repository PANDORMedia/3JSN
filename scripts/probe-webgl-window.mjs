import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { PNG } from 'pngjs';
import { compileHtml } from '../experiments/compiled-ui/compiler.mjs';

const [playerArg, fontArg, angleArg, outputArg, ...extra] = process.argv.slice(2);
assert(playerArg && fontArg && angleArg && outputArg && !extra.length,
  'Usage: node scripts/probe-webgl-window.mjs <compiled-ui-player> <font> <ANGLE-lib-dir> <new-output-directory>');
const root = resolve(import.meta.dirname, '..');
const output = resolve(outputArg);
await mkdir(output); // Refuse an existing evidence directory.
const player = resolve(playerArg), font = resolve(fontArg), angle = resolve(angleArg);
const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = ['examples/webgl-window/index.html', 'examples/webgl-window/main.mjs'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(join(root, path)))])));
const report = {
  status: 'failed',
  limits: [
    'ANGLE libraries and font are external runtime inputs; this is not a self-contained package.',
    'This fixture does not certify other operating systems, arbitrary Three.js applications, or WebGL conformance.',
    'No FPS or performance claim; PNG readback is assertion evidence only, never frame transport.',
  ],
};
let failure;
async function run(label, args, env = process.env) {
  try {
    const result = await execute(player, args, { cwd: output, env, timeout: 95_000,
      killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
    await writeFile(join(output, `${label}-stdout.txt`), result.stdout);
    await writeFile(join(output, `${label}-stderr.txt`), result.stderr);
    return result.stdout;
  } catch (error) {
    await writeFile(join(output, `${label}-stdout.txt`), error.stdout ?? '');
    await writeFile(join(output, `${label}-stderr.txt`), error.stderr ?? String(error));
    report.processFailure = { label, code: error.code, signal: error.signal, killed: error.killed };
    throw error;
  }
}
try {
  report.sourceBefore = await sourceHashes();
  report.player = { path: player, sha256: hash(await readFile(player)) };
  report.font = { path: font, sha256: hash(await readFile(font)) };
  report.angleLibraryDirectory = angle;
  report.runtimeDescription = JSON.parse(await run('describe', ['--describe']));
  const ui = join(output, 'ui.json'), app = join(output, 'app.mjs');
  await writeFile(ui, JSON.stringify(compileHtml(await readFile(join(root, sources[0]), 'utf8'), { sourceName: sources[0] })));
  const bundle = await build({ entryPoints: [join(root, sources[1])], outfile: app,
    bundle: true, platform: 'browser', format: 'esm', logLevel: 'silent' });
  assert.equal(bundle.warnings.length, 0, 'fixture bundle warnings');
  report.generated = { uiSha256: hash(await readFile(ui)), appSha256: hash(await readFile(app)) };
  const pngPath = join(output, 'window.png');
  const args = ['--compiled-ui', ui, font, app, '--frames', '120'];
  report.command = { executable: player, args, environment: {
    THREEJS_NATIVE_ANGLE_LIBRARY_DIR: angle, THREEJS_NATIVE_CAPTURE_PNG: pngPath, MTL_DEBUG_LAYER: '1',
  } };
  const stdout = await run('window', args, { ...process.env, ...report.command.environment });
  const records = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  report.parser = records.find(record => record.compiledUi)?.compiledUi;
  assert.equal(report.parser?.initialDocumentHtmlParserUsed, false);
  const phases = records.filter(record => record.webglWindow).map(record => record.webglWindow);
  report.phases = phases;
  assert.deepEqual(phases.map(phase => phase.phase), ['First frame', 'Bitmap resized', 'Same-width reset', 'Canvas replaced', 'Lifecycle complete']);
  for (const phase of phases) {
    assert.equal(phase.contextIdentity, true);
    assert.equal(phase.contextLost, false);
    assert.equal(phase.connected, true);
    assert(phase.bitmap.width > 0 && phase.bitmap.height > 0);
  }
  const [initial, resized, reset, replaced, complete] = phases;
  for (const dimension of ['width', 'height']) {
    assert(Math.abs(resized.bitmap[dimension] - initial.bitmap[dimension] * 1.25) <= 1,
      `resized ${dimension} must follow 1.25 bitmap scale`);
    assert.equal(reset.bitmap[dimension], resized.bitmap[dimension]);
  }
  assert.equal(replaced.replacementContextDistinct, true);
  assert.equal(replaced.generation, 2);
  assert.equal(complete.generation, 2);
  assert.equal(complete.replacementContextDistinct, true);
  const completions = records.filter(record => record.nativeDomWindow);
  assert.equal(completions.length, 1);
  const completion = completions[0];
  report.completion = completion;
  assert.equal(completion.presentedFrames, 120);
  assert(completion.canvasSnapshots >= completion.presentedFrames);
  assert.equal(completion.canvasApi, 'webgl2');
  assert.equal(completion.nativeQueueIdentityChecked, false);
  assert.equal(completion.nativeEventHandoff, true);
  assert.equal(completion.cpuImageTransport, false);
  assert.equal(completion.nativeDeviceIdentityChecked, true);
  const pngBytes = await readFile(pngPath);
  const png = PNG.sync.read(pngBytes);
  assert(png.width > 0 && png.height > 0);
  report.capture = { path: 'window.png', width: png.width, height: png.height, sha256: hash(pngBytes), purpose: 'final-frame assertion only' };
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.error = String(error);
} finally {
  try {
    report.sourceAfter = await sourceHashes();
    assert.deepEqual(report.sourceAfter, report.sourceBefore, 'fixture sources changed during probe');
    report.sourcePreserved = true;
  } catch (error) {
    report.sourcePreserved = false;
    report.sourceError = String(error);
    failure ??= error;
  }
  if (failure) report.status = 'failed';
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
if (failure) throw failure;
console.log(JSON.stringify({ status: report.status, report: join(output, 'report.json') }));
