import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/window-lifecycle');
const fixture = 'examples/runtime/window-lifecycle.mjs';
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const fixtureHash = await hash(resolve(root, fixture));
const run = (command, args) => execFileSync(command, args, {
  cwd: root, encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
run('cargo', ['build', '--locked', '--release', '-p', 'threejs-native-player']);
const compiler = run('rustc', ['-vV']);
const target = compiler.match(/^host: (.+)$/m)?.[1];
assert(target);
const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1']));
const binary = resolve(metadata.target_directory, 'release', `threejs-native-player${process.platform === 'win32' ? '.exe' : ''}`);
const runs = [];
for (let attempt = 0; attempt < 3; attempt++) {
  const result = spawnSync(binary, ['--window', fixture, '--frames', '1'], {
    cwd: root, encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024,
    env: { ...process.env, ...(process.platform === 'darwin' ? { MTL_DEBUG_LAYER: '1' } : {}) },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /EXPECTED_NATIVE_LIFECYCLE_COMPLETE/);
  assert.doesNotMatch(result.stderr, /30-second deadline|panicked|Validation Error/);
  const observation = JSON.parse(result.stdout.trim());
  assert.equal(observation.nativeLifecycle, true);
  assert.equal(observation.cycles, 12);
  assert.deepEqual(observation.errors, []);
  const metalValidation = result.stderr.includes('Metal API Validation Enabled');
  if (process.platform === 'darwin') assert(metalValidation);
  runs.push({ attempt: attempt + 1, exitCode: result.status, expectedSentinel: true, metalValidation, ...observation });
}
assert.equal(await hash(resolve(root, fixture)), fixtureHash);
const report = { recordedAt: new Date().toISOString(), kind: 'native-canvas-lifecycle',
  target, compiler: compiler.split('\n')[0], runtime: run(binary, ['--version']),
  binary: { bytes: (await stat(binary)).size, sha256: await hash(binary) },
  inputs: [{ path: fixture, sha256: fixtureHash }, { path: 'Cargo.lock', sha256: await hash(resolve(root, 'Cargo.lock')) }],
  runs, limitations: ['Executes outside RAF and also works with an occluded window.',
    'No visible presentation, display pacing, device-loss recovery or platform certification.',
    'Exit code 1 is expected only after all assertions and the completion sentinel; ordinary errors fail this probe.'] };
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`PASS: three native processes, 36 configure/resize/expiry cycles; ${output}/report.json`);
