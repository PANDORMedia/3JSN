import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { PNG } from 'pngjs';
import { compileHtml } from '../experiments/compiled-ui/compiler.mjs';

const [testArg, fontArg, angleArg, outputArg, ...extra] = process.argv.slice(2);
assert(testArg && fontArg && angleArg && outputArg && !extra.length,
  'Usage: node scripts/probe-webgl-demo-offscreen.mjs <webgl_composition-test-binary> <font> <ANGLE-package> <new-output-directory>');
const root = resolve(import.meta.dirname, '..');
const output = resolve(outputArg);
await mkdir(output); // Preserve prior evidence by refusing an existing directory.
const executable = resolve(testArg), font = resolve(fontArg), angle = resolve(angleArg);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = ['examples/webgl-window/index.html', 'examples/webgl-window/main.mjs'];
const identities = async () => Object.fromEntries(await Promise.all(sources.map(async path =>
  [path, hash(await readFile(join(root, path)))])));
const report = { status: 'failed', presentation: 'offscreen-only',
  limits: ['No window, surface, input or presentation evidence.',
    'External ANGLE and font inputs; not a standalone application package.',
    'No performance or general WebGL compatibility claim.'] };
let failure;
try {
  report.sourceBefore = await identities();
  report.executableSha256 = hash(await readFile(executable));
  report.fontSha256 = hash(await readFile(font));
  const ui = join(output, 'ui.json'), script = join(output, 'app.js'), capture = join(output, 'demo.png');
  await writeFile(ui, JSON.stringify(compileHtml(await readFile(join(root, sources[0]), 'utf8'), { sourceName: sources[0] })));
  const bundle = await build({ entryPoints: [join(root, sources[1])], outfile: script,
    bundle: true, format: 'iife', platform: 'browser', logLevel: 'silent' });
  assert.equal(bundle.warnings.length, 0);
  report.generated = { uiSha256: hash(await readFile(ui)), scriptSha256: hash(await readFile(script)) };
  const args = ['--exact', 'demo_offscreen::animated_three_demo_offscreen', '--ignored', '--nocapture'];
  const environment = { THREEJS_NATIVE_DEMO_UI: ui, THREEJS_NATIVE_DEMO_SCRIPT: script,
    THREEJS_NATIVE_DEMO_CAPTURE: capture, THREEJS_NATIVE_COMPOSITION_FONT: font,
    THREEJS_NATIVE_ANGLE_PACKAGE: angle, MTL_DEBUG_LAYER: '1' };
  report.command = { executable, args, environment };
  let processResult;
  try {
    processResult = await promisify(execFile)(executable, args, { cwd: root,
      env: { ...process.env, ...environment }, timeout: 120_000,
      killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    processResult = error;
    throw error;
  } finally {
    await writeFile(join(output, 'stdout.txt'), processResult?.stdout ?? '');
    await writeFile(join(output, 'stderr.txt'), processResult?.stderr ?? '');
  }
  assert.match(processResult.stdout, /test result: ok\. 1 passed;/, 'expected exactly one passing hardware test');
  const records = processResult.stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const summaries = records.filter(record => record.webglDemoOffscreen);
  assert.equal(summaries.length, 1, 'missing or duplicate demo receipt');
  report.demo = summaries[0].webglDemoOffscreen;
  assert.equal(report.demo.frames, 60);
  assert.equal(report.demo.checkpoints, 5);
  assert.equal(report.demo.snapshotGenerations, 4);
  assert.equal(report.demo.canvasContexts, 2);
  assert.equal(report.demo.cleanup, 'passed');
  assert.equal(report.demo.surfacePresentation, false);
  assert.equal(report.demo.cpuFrameTransport, false);
  const pngBytes = await readFile(capture);
  const png = PNG.sync.read(pngBytes);
  assert.equal(png.width, 960); assert.equal(png.height, 640);
  report.capture = { width: png.width, height: png.height, sha256: hash(pngBytes) };
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.error = String(error.message ?? error);
} finally {
  report.sourceAfter = await identities();
  report.sourcePreserved = JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter);
  if (!report.sourcePreserved) {
    report.status = 'failed';
    failure ??= new Error('Demo source changed during the probe');
  }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, report: join(output, 'report.json') }));
if (failure) throw failure;
