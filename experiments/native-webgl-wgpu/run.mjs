import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

assert.equal(process.platform, 'darwin', 'This experiment currently targets Metal on macOS.');
const root = resolve(import.meta.dirname, '../..');
const { values } = parseArgs({ options: {
  'deps-dir': { type: 'string', default: '.cache/native-webgl' },
  offline: { type: 'boolean', default: false },
} });
const candidate = createRequire(join(resolve(root, values['deps-dir']), 'package.json'));
const angle = dirname(candidate.resolve('gl/package.json'));
assert.equal(candidate('gl/package.json').version, '9.0.0-rc.10');
const cache = join(root, '.cache/webgl-wgpu');
await mkdir(cache, { recursive: true });
const environment = {
  ...process.env,
  CARGO_HOME: process.env.CARGO_HOME ?? join(root, '.cache/cargo'),
  CARGO_TARGET_DIR: join(cache, 'target'),
  CARGO_BUILD_JOBS: '2',
  THREEJS_NATIVE_ANGLE_PACKAGE: angle,
};
function run(command, args, timeout) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, env: environment, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed:\n${result.stderr}\n${result.stdout}`);
  if (result.stderr) process.stderr.write(result.stderr);
  return { stdout: result.stdout, stderr: result.stderr };
}
run('cargo', ['build', '--locked', '--jobs', '2', '--manifest-path', join(import.meta.dirname, 'Cargo.toml'),
  ...(values.offline ? ['--offline'] : [])], 180_000);
const native = run(join(cache, 'target/debug/threejs-native-webgl-wgpu-probe'), [join(angle, 'deps/darwin/dylib')], 40_000);
const report = JSON.parse(native.stdout);
report.recordedOn = new Date().toISOString().slice(0, 10);
report.operatingSystem = `macOS ${run('sw_vers', ['-productVersion'], 10_000).stdout.trim()} (${run('sw_vers', ['-buildVersion'], 10_000).stdout.trim()})`;
report.arch = process.arch;
report.rustCompiler = run('rustc', ['--version'], 10_000).stdout.trim();
report.nativeCompiler = run('xcrun', ['clang++', '--version'], 10_000).stdout.split('\n')[0];
report.metalValidationRequested = process.env.MTL_DEBUG_LAYER === '1';
report.metalValidationObserved = native.stderr.includes('Metal API Validation Enabled');
report.sourceHashes = {};
for (const file of ['Cargo.toml', 'Cargo.lock', 'build.rs', 'bridge.mm', 'src/main.rs', 'src/native.rs']) {
  report.sourceHashes[file] = createHash('sha256').update(await readFile(join(import.meta.dirname, file))).digest('hex');
}
report.angleArtifact = 'gl@9.0.0-rc.10 (headers, loaders and ANGLE libraries only)';
report.nativeLibraries = [];
for (const file of ['libEGL.dylib', 'libGLESv2.dylib']) {
  const data = await readFile(join(angle, 'deps/darwin/dylib', file));
  report.nativeLibraries.push({ file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}
const output = join(root, 'artifacts/native-webgl-wgpu');
await mkdir(output, { recursive: true });
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
