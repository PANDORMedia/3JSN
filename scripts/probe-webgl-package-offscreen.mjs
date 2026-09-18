import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { PNG } from 'pngjs';

const [manifestArg, testArg, outputArg, angleArg, fontArg, ...extra] = process.argv.slice(2);
assert(process.platform === 'darwin', 'This evidence runner requires macOS sandbox-exec and Metal');
assert(manifestArg && testArg && outputArg && angleArg && fontArg && !extra.length,
  'Usage: node scripts/probe-webgl-package-offscreen.mjs <relocated-app.json> <test-binary> <new-output> <original-angle-package> <original-font>');
const manifest = resolve(manifestArg), executable = resolve(testArg), output = resolve(outputArg);
await mkdir(output);
const execute = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = resolve(import.meta.dirname, '../examples/webgl-window');
const denied = [resolve(angleArg), resolve(fontArg), source];
const policy = '(version 1)(allow default)(deny network*)' + denied.map(path => `(deny file-read* (subpath ${JSON.stringify(path)}))`).join('');
const environment = { PATH: '/usr/bin:/bin', THREEJS_NATIVE_DEMO_PACKAGE: manifest,
  THREEJS_NATIVE_DEMO_CAPTURE: join(output, 'demo.png'), THREEJS_NATIVE_ANGLE_PACKAGE: '/invalid',
  THREEJS_NATIVE_ANGLE_LIBRARY_DIR: '/invalid', THREEJS_NATIVE_COMPOSITION_FONT: '/invalid',
  THREEJS_NATIVE_DEMO_UI: '/invalid', THREEJS_NATIVE_DEMO_SCRIPT: '/invalid', MTL_DEBUG_LAYER: '1' };
const report = { status: 'failed', manifest, executable, environment, policy, controls: [],
  limits: ['Offscreen integration test consumes packaged inputs; this is not window presentation.',
    'Network denial is configured, not measured.', 'Not a clean-machine, signing or other-platform test.'] };
let failure;
try {
  report.executableSha256 = hash(await readFile(executable));
  report.manifestSha256 = hash(await readFile(manifest));
  report.buildMetadataSha256 = hash(await readFile(join(dirname(manifest), 'metadata/build.json')));
  for (const path of [join(denied[0], 'deps/darwin/dylib/libEGL.dylib'), denied[1], join(source, 'main.mjs')]) {
    await readFile(path);
    let deniedRead = false;
    try { await execute('/usr/bin/sandbox-exec', ['-p', policy, '/bin/cat', path], { maxBuffer: 64 * 1024 }); }
    catch (error) {
      assert.equal(error.code, 1); assert.match(error.stderr, /Operation not permitted/); deniedRead = true;
    }
    assert(deniedRead, 'original input read unexpectedly succeeded');
    report.controls.push({ path, denied: true });
  }
  let nodeAbsent = false;
  try { await execute('/bin/sh', ['-c', 'command -v node'], { env: { PATH: environment.PATH } }); }
  catch (error) { assert.equal(error.code, 1); nodeAbsent = true; }
  assert(nodeAbsent, 'Node remains available on native PATH');
  report.nodeAbsent = true;
  const args = ['-p', policy, executable, '--exact', 'demo_offscreen::animated_three_demo_offscreen', '--ignored', '--nocapture'];
  let result;
  try { result = await execute('/usr/bin/sandbox-exec', args, { cwd: '/tmp', env: { ...process.env, ...environment }, timeout: 60_000, maxBuffer: 1024 * 1024 }); }
  catch (error) { result = error; throw error; }
  finally {
    await writeFile(join(output, 'stdout.txt'), result?.stdout ?? '');
    await writeFile(join(output, 'stderr.txt'), result?.stderr ?? '');
  }
  assert.match(result.stdout, /test result: ok\. 1 passed;/);
  const records = result.stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const summaries = records.filter(record => record.webglDemoOffscreen);
  assert.equal(summaries.length, 1);
  report.demo = summaries[0].webglDemoOffscreen;
  assert.equal(report.demo.packagedInputs, true);
  for (const [key, value] of Object.entries({ frames:60, checkpoints:5, snapshotGenerations:4, canvasContexts:2, cleanup:'passed', surfacePresentation:false, cpuFrameTransport:false })) assert.equal(report.demo[key], value);
  const bytes = await readFile(join(output, 'demo.png')), png = PNG.sync.read(bytes);
  assert.equal(png.width, 960); assert.equal(png.height, 640);
  report.capture = { width: png.width, height: png.height, sha256: hash(bytes) };
  report.status = 'passed';
} catch (error) { failure = error; report.error = String(error.message ?? error); }
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, report: join(output, 'report.json') }));
if (failure) throw failure;
