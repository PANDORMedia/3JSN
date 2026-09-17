import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

assert.equal(process.platform, 'darwin', 'This native interop experiment is macOS-only.');
const root = resolve(import.meta.dirname, '../..');
const { values } = parseArgs({ options: { 'deps-dir': { type: 'string', default: '.cache/native-webgl' } } });
const candidate = createRequire(join(resolve(root, values['deps-dir']), 'package.json'));
const candidateDirectory = dirname(candidate.resolve('gl/package.json'));
assert.equal(candidate('gl/package.json').version, '9.0.0-rc.10');
const source = join(import.meta.dirname, 'probe.mm');
const cache = join(root, '.cache/webgl-interop');
await mkdir(cache, { recursive: true });
const executable = join(cache, 'native-metal-probe');
const nativeDirectory = join(candidateDirectory, 'src/native');
const libraryDirectory = join(candidateDirectory, 'deps/darwin/dylib');
function run(command, args, timeout) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed:\n${result.stderr}\n${result.stdout}`);
  if (result.stderr) process.stderr.write(result.stderr);
  return { stdout: result.stdout, stderr: result.stderr };
}
const compiler = run('xcrun', ['clang++', '--version'], 10_000).stdout.split('\n')[0];
// One compiler driver builds the probe and two upstream function loaders sequentially.
run('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-O2', '-Wall', '-Wextra',
  '-I', join(nativeDirectory, 'angle-includes'), '-I', nativeDirectory,
  source, join(nativeDirectory, 'angle-loader/egl_loader.cc'), join(nativeDirectory, 'angle-loader/gles_loader.cc'),
  '-framework', 'Foundation', '-framework', 'Metal', '-o', executable], 60_000);
const nativeRun = run(executable, [libraryDirectory], 40_000);
const report = JSON.parse(nativeRun.stdout);
report.recordedOn = new Date().toISOString().slice(0, 10);
report.operatingSystem = `macOS ${run('sw_vers', ['-productVersion'], 10_000).stdout.trim()} (${run('sw_vers', ['-buildVersion'], 10_000).stdout.trim()})`;
report.arch = process.arch;
report.compiler = compiler;
report.bindingArtifact = 'gl@9.0.0-rc.10 (headers, loaders and ANGLE libraries only; no Node addon loaded)';
report.metalValidationRequested = process.env.MTL_DEBUG_LAYER === '1';
report.metalValidationObserved = nativeRun.stderr.includes('Metal API Validation Enabled');
report.sourceSHA256 = createHash('sha256').update(await readFile(source)).digest('hex');
report.nativeLibraries = [];
for (const file of ['libEGL.dylib', 'libGLESv2.dylib']) {
  const data = await readFile(join(libraryDirectory, file));
  report.nativeLibraries.push({ file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}
const output = join(root, 'artifacts/native-webgl-interop');
await mkdir(output, { recursive: true });
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
