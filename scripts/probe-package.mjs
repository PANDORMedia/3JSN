import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildProject } from '../packages/cli/build.mjs';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const [playerArgument, outputArgument, ...extra] = process.argv.slice(2);
assert(playerArgument && outputArgument && !extra.length,
  'Usage: node scripts/probe-package.mjs <native-player> <new-evidence-directory>');
const player = resolve(playerArgument);
const output = resolve(outputArgument);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputPaths = ['scripts/probe-package.mjs', 'packages/cli/build.mjs',
  'packages/cli/contract.mjs', 'scripts/compatibility/snapshot.mjs', 'package-lock.json',
  'examples/spinning-scene/3jsn.json', 'examples/spinning-scene/native.mjs',
  'examples/spinning-scene/scene.mjs', 'examples/spinning-scene/controls.mjs'];
const inputs = await Promise.all(inputPaths.map(async path => ({ path,
  sha256: hash(await readFile(join(root, path))) })));
await mkdir(output);
const source = join(output, 'build-input');
await mkdir(source);
for (const name of ['3jsn.json', 'native.mjs', 'scene.mjs', 'controls.mjs']) {
  await copyFile(join(root, 'examples/spinning-scene', name), join(source, name));
}
// Keep the disposable project under this checkout so esbuild can resolve its
// installed Three.js dependency without copying or installing node_modules.
const build = await buildProject({ project: source, runtime: player,
  out: join(output, 'built'), experimental: true });
await writeFile(join(output, 'build-result.json'), `${JSON.stringify(build, null, 2)}\n`);
const relocated = join(output, 'Relocated Demo é #');
await rename(build.output, relocated);
await rm(source, { recursive: true });
await assert.rejects(stat(source), { code: 'ENOENT' });
const cwd = join(output, 'unrelated-working-directory');
await mkdir(cwd);
const environment = { ...process.env,
  PATH: process.platform === 'win32' ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin',
  ...(process.platform === 'darwin' ? { MTL_DEBUG_LAYER: '1' } : {}),
};
let nodeOnPath = false;
try { await execute('node', ['--version'], { env: environment }); nodeOnPath = true; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const executable = join(relocated, `3jsn-demo${process.platform === 'win32' ? '.exe' : ''}`);
const manifestPath = join(relocated, 'app.json');
const verified = await execute(executable, ['--verify-app', manifestPath], { cwd, env: environment });
assert.deepEqual(JSON.parse(verified.stdout), { packageVerified: true });

let native;
try {
  native = await execute(executable, ['--frames', '120'], { cwd, env: environment,
    timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
} catch (error) {
  await writeFile(join(output, 'native-stdout.txt'), error.stdout ?? '');
  await writeFile(join(output, 'native-stderr.txt'), error.stderr ?? String(error));
  throw error;
}
await writeFile(join(output, 'native-stdout.txt'), native.stdout);
await writeFile(join(output, 'native-stderr.txt'), native.stderr);
const records = native.stdout.trim().split('\n').map(line => JSON.parse(line));
const rendering = records.find(record => record.nativeThree === true);
const completion = records.find(record => record.nativeWindow === true);
assert.equal(rendering?.sameJavaScriptDevice, true);
assert.equal(rendering?.adapter.isFallbackAdapter, false);
assert.equal(completion?.presentedFrames, 120);

const mapPath = join(relocated, 'app/main.mjs.map');
const originalMap = await readFile(mapPath);
await writeFile(mapPath, `${originalMap.toString()}\n`);
let corruption;
try {
  await execute(executable, ['--verify-app', manifestPath], { cwd, env: environment });
  assert.fail('corrupt source map was accepted');
} catch (error) {
  assert.equal(error.code, 1);
  assert.match(error.stderr, /integrity verification: app\/main\.mjs\.map/);
  corruption = { exitCode: error.code, stderr: error.stderr };
} finally { await writeFile(mapPath, originalMap); }

const failureSource = join(output, 'failure-input');
await mkdir(failureSource);
await writeFile(join(failureSource, '3jsn.json'), JSON.stringify({ schemaVersion: 1,
  profile: 'native-window-v1', name: 'failure-fixture', entry: 'main.mjs' }));
await writeFile(join(failureSource, 'main.mjs'), "import './failure.mjs';\n");
await writeFile(join(failureSource, 'failure.mjs'),
  "setTimeout(() => { throw new Error('packaged asynchronous failure'); }, 0);\n");
const faulted = await buildProject({ project: failureSource, runtime: player,
  out: join(output, 'failure-package'), experimental: true });
await rm(failureSource, { recursive: true });
let applicationFailure;
try {
  await execute(faulted.executable, ['--frames', '120'], { cwd, env: environment,
    timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  assert.fail('packaged asynchronous throw unexpectedly succeeded');
} catch (error) {
  await writeFile(join(output, 'failure-stdout.txt'), error.stdout ?? '');
  await writeFile(join(output, 'failure-stderr.txt'), error.stderr ?? String(error));
  assert.equal(error.code, 1);
  assert.match(error.stderr, /packaged asynchronous failure/);
  assert.match(error.stderr, /app\/main\.mjs:\d+:\d+/);
  applicationFailure = { exitCode: error.code, generatedSourceLocation: true,
    manifestSha256: hash(await readFile(faulted.manifest)) };
}
const metadata = JSON.parse(await readFile(join(relocated, 'metadata/build.json')));
assert.equal(metadata.source.preservation.preserved, true);
const manifest = await readFile(manifestPath);
for (const input of inputs) {
  assert.equal(hash(await readFile(join(root, input.path))), input.sha256,
    `${input.path} changed during the probe`);
}
const report = { kind: 'experimental-native-package-relocation', target: build.target,
  profile: build.profile, inputs, nodeOnRestrictedPath: nodeOnPath,
  removedDisposableBuildInput: true, unrelatedWorkingDirectory: true,
  relocatedDirectoryContainsUnicodeAndSpaces: true, sourcePreservedDuringBuild: true,
  runtime: metadata.runtime, manifest: { sha256: hash(manifest), bytes: manifest.length },
  applicationFiles: JSON.parse(manifest).files, completion, corruption, applicationFailure,
  limitations: ['One-machine hardware observation; not a clean-machine or performance certification.',
    'No-node PATH is evidence only when nodeOnRestrictedPath is false; the parent probe uses Node.',
    'The disposable build input was intentionally deleted after the preservation check.',
    'Other copies of fixture sources and system/dependency libraries may exist on this development machine.',
    'No original-source stack mapping, web-game compatibility or binary redistribution certification.'] };
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: true, report: join(output, 'report.json'), executable }));
