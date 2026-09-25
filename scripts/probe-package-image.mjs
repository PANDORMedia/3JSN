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
  'Usage: node scripts/probe-package-image.mjs <native-player> <new-evidence-directory>');
const player = resolve(playerArgument);
const output = resolve(outputArgument);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = join(root, 'examples/package-image');
const inputNames = ['3jsn.json', 'native.mjs', 'checker.png'];
const inputs = await Promise.all(inputNames.map(async name => ({ name,
  sha256: hash(await readFile(join(fixture, name))) })));
await mkdir(output);
const source = join(output, 'build-input');
await mkdir(source);
for (const name of inputNames) await copyFile(join(fixture, name), join(source, name));

const build = await buildProject({ project: source, runtime: player,
  out: join(output, 'built'), experimental: true });
await writeFile(join(output, 'build-result.json'), `${JSON.stringify(build, null, 2)}\n`);
const manifestBeforeMove = JSON.parse(await readFile(build.manifest, 'utf8'));
assert.deepEqual(manifestBeforeMove.requires, ['package-assets-v1']);
assert.equal(manifestBeforeMove.resources?.length, 1);
const image = manifestBeforeMove.resources[0];
assert.equal(image.kind, 'image');
const imageRecord = manifestBeforeMove.files.find(file => file.path === image.path);
assert.ok(imageRecord, 'manifest lists the imported image');
const imageBytes = await readFile(join(build.output, image.path));
assert.equal(imageRecord.bytes, imageBytes.length);
assert.equal(imageRecord.sha256, hash(imageBytes));

const relocated = join(output, 'Relocated Image é #');
await rename(build.output, relocated);
await rm(source, { recursive: true });
await assert.rejects(stat(source), { code: 'ENOENT' });
const cwd = join(output, 'unrelated-working-directory');
await mkdir(cwd);
const environment = { ...process.env,
  PATH: process.platform === 'win32' ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin',
  ...(process.platform === 'darwin' ? { MTL_DEBUG_LAYER: '1' } : {}),
};
const executable = join(relocated, `package-image-demo${process.platform === 'win32' ? '.exe' : ''}`);
const verified = await execute(executable, ['--verify-app', join(relocated, 'app.json')], { cwd, env: environment });
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
const readback = records.find(record => record.packageImageReadback === true);
const completion = records.find(record => record.nativeWindow === true);
assert.equal(readback?.three, '186');
assert.equal(readback?.sameJavaScriptDevice, true);
assert.equal(readback?.adapter.isFallbackAdapter, false);
assert.deepEqual(readback?.samples, [
  [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255],
]);
assert.equal(completion?.presentedFrames, 120);

const metadata = JSON.parse(await readFile(join(relocated, 'metadata/build.json')));
assert.equal(metadata.source.preservation.preserved, true);
for (const input of inputs) {
  assert.equal(hash(await readFile(join(fixture, input.name))), input.sha256,
    `${input.name} changed during the probe`);
}
const manifestBytes = await readFile(join(relocated, 'app.json'));
const report = { kind: 'cli-built-packaged-image-gpu-relocation', target: build.target,
  profile: build.profile, inputs, removedDisposableBuildInput: true, unrelatedWorkingDirectory: true,
  relocatedDirectoryContainsUnicodeAndSpaces: true, sourcePreservedDuringBuild: true,
  packagedImage: { path: image.path, bytes: imageRecord.bytes, sha256: imageRecord.sha256 },
  runtime: metadata.runtime, manifest: { bytes: manifestBytes.length, sha256: hash(manifestBytes) },
  readback, completion, limitations: [
    'One-machine hardware observation; not a cross-platform or performance certification.',
    'Only the native-window-v1 profile and statically imported PNG path are exercised.',
    'This does not establish arbitrary Three.js, HTML/CSS, WebGL or browser API compatibility.',
  ] };
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: true, report: join(output, 'report.json'), executable }));
