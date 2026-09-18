import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const [playerArgument, fontArgument, outputArgument, ...extra] = process.argv.slice(2);
assert(process.platform === 'darwin', 'The DOM window probe currently requires macOS/Metal.');
assert(playerArgument && fontArgument && outputArgument && !extra.length,
  'Usage: node scripts/probe-dom-package.mjs <dom-player> <font.woff2> <new-evidence-directory>');
const output = resolve(outputArgument);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['3jsn.json', 'dom-window/index.html', 'dom-window/app.mjs', 'spinning-scene/scene.mjs'];
const inputPaths = ['scripts/probe-dom-package.mjs', 'packages/cli/build.mjs', 'packages/cli/html.mjs',
  'packages/cli/contract.mjs', 'packages/cli/cli.mjs', 'scripts/compatibility/snapshot.mjs', 'package-lock.json',
  ...sourceFiles.map(path => `examples/${path}`)];
const inputs = await Promise.all(inputPaths.map(async path => ({ path, sha256: hash(await readFile(join(root, path))) })));
await mkdir(output);
const source = join(output, 'build-input');
for (const path of sourceFiles) {
  await mkdir(dirname(join(source, path)), { recursive: true });
  await copyFile(join(root, 'examples', path), join(source, path));
}
const font = join(output, 'build-font.woff2');
await copyFile(resolve(fontArgument), font);
const { stdout, stderr } = await execute(process.execPath, [join(root, 'packages/cli/cli.mjs'), 'build', source,
  '--runtime', resolve(playerArgument), '--font', font, '--out', join(output, 'built'), '--experimental'],
{ cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
await writeFile(join(output, 'build-stdout.txt'), stdout);
await writeFile(join(output, 'build-stderr.txt'), stderr);
const build = JSON.parse(stdout);
const relocated = join(output, 'Relocated DOM é #');
await rename(build.output, relocated);
await rm(source, { recursive: true });
await rm(font);
for (const path of [source, font]) await assert.rejects(stat(path), { code: 'ENOENT' });
const cwd = join(output, 'unrelated-working-directory');
await mkdir(cwd);
const environment = { ...process.env, PATH: '/usr/bin:/bin', MTL_DEBUG_LAYER: '1' };
let nodeOnPath = false;
try { await execute('node', ['--version'], { env: environment }); nodeOnPath = true; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
assert.equal(nodeOnPath, false, 'Native validation requires a PATH without Node.');
const executable = join(relocated, '3jsn-dom-demo');
const manifestPath = join(relocated, 'app.json');
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes);
const options = { cwd, env: environment, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 };
const deniedDirectories = ['.cache', 'node_modules', 'crates', 'experiments', 'examples'].map(path => join(root, path));
const sandbox = join(output, 'native-only.sb');
await writeFile(sandbox, `(version 1)\n(allow default)\n(deny network*)\n(deny file-read*\n${deniedDirectories.map(path => `  (subpath ${JSON.stringify(path)})`).join('\n')}\n)\n`);
const readControls = ['.cache/dom-canvas/blitz/examples/wasm_hello/assets/DejaVuSans.woff2',
  'node_modules/three/package.json', 'crates/runtime/src/lib.rs',
  'experiments/dom-canvas/src/window_probe.rs', 'examples/dom-window/index.html'];
for (const path of readControls) {
  assert((await stat(join(root, path))).isFile());
  await assert.rejects(execute('/usr/bin/sandbox-exec', ['-f', sandbox, '/bin/cat', join(root, path)], options), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Operation not permitted/);
    return true;
  });
}
const nativeExecute = args => execute('/usr/bin/sandbox-exec', ['-f', sandbox, executable, ...args], options);
const verified = await nativeExecute(['--verify-app', manifestPath]);
assert.deepEqual(JSON.parse(verified.stdout), { packageVerified: true });
async function run(label, args) {
  try {
    const result = await nativeExecute(args);
    await writeFile(join(output, `${label}-stdout.txt`), result.stdout);
    await writeFile(join(output, `${label}-stderr.txt`), result.stderr);
    return result;
  } catch (error) {
    await writeFile(join(output, `${label}-stdout.txt`), error.stdout ?? '');
    await writeFile(join(output, `${label}-stderr.txt`), error.stderr ?? String(error));
    throw error;
  }
}
const native = await run('native', ['--frames', '120']);
const completion = native.stdout.trim().split('\n').map(line => JSON.parse(line)).find(record => record.nativeDomWindow === true);
assert.equal(completion?.presentedFrames, 120);
assert.equal(completion?.cpuImageTransport, false);
assert.equal(completion?.nativeDeviceIdentityChecked, true);
assert.equal(completion?.nativeQueueIdentityChecked, true);

const failures = [];
async function mustFail(label, args, pattern) {
  await assert.rejects(run(label, args), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, pattern);
    failures.push({ check: label, exitCode: error.code, stderr: error.stderr });
    return true;
  });
}
for (const payload of ['app/index.html', 'app/font.woff2']) {
  const path = join(relocated, payload);
  const original = await readFile(path);
  try {
    await writeFile(path, Buffer.concat([original, Buffer.from('damaged')]));
    await mustFail(`corrupt-${payload.endsWith('.html') ? 'html' : 'font'}`, ['--verify-app', manifestPath], /integrity verification/);
  } finally { await writeFile(path, original); }
}
try {
  await writeFile(manifestPath, JSON.stringify({ ...manifest, profile: 'native-window-v1' }));
  await mustFail('wrong-profile', ['--verify-app', manifestPath], /requires native-window-v1.*provides dom-window-v1/);
} finally { await writeFile(manifestPath, manifestBytes); }

async function replaceVerifiedPayload(payload, bytes, label, pattern) {
  const path = join(relocated, payload);
  const original = await readFile(path);
  try {
    const changed = structuredClone(manifest);
    const record = changed.files.find(file => file.path === payload);
    record.bytes = bytes.length; record.sha256 = hash(bytes);
    await writeFile(path, bytes);
    await writeFile(manifestPath, JSON.stringify(changed));
    await mustFail(label, ['--frames', '120'], pattern);
  } finally {
    await writeFile(path, original);
    await writeFile(manifestPath, manifestBytes);
  }
}
const invalidFont = Buffer.alloc(48);
invalidFont.write('wOF2'); invalidFont.writeUInt32BE(48, 8);
await replaceVerifiedPayload('app/font.woff2', invalidFont, 'unusable-font', /did not register a usable font family/);
const module = await readFile(join(relocated, 'app/main.mjs'));
await replaceVerifiedPayload('app/main.mjs', Buffer.concat([module,
  Buffer.from("\nrequestAnimationFrame(() => { throw new Error('packaged DOM animation failure'); });\n")]),
'application-failure', /packaged DOM animation failure/);
const restored = await nativeExecute(['--verify-app', manifestPath]);
assert.deepEqual(JSON.parse(restored.stdout), { packageVerified: true });
const metadata = JSON.parse(await readFile(join(relocated, 'metadata/build.json')));
assert.equal(metadata.source.preservation.preserved, true);
assert.equal(metadata.assets.font.preserved, true);
for (const input of inputs) assert.equal(hash(await readFile(join(root, input.path))), input.sha256, `${input.path} changed during the probe`);
const report = { kind: 'experimental-dom-package-relocation', profile: build.profile, target: build.target, inputs,
  removedDisposableBuildInput: true, removedSuppliedFont: true, nodeOnRestrictedPath: nodeOnPath,
  deniedBuildTimeSourceDirectories: deniedDirectories, nativeNetworkDenied: true,
  deniedReadControls: readControls,
  unrelatedWorkingDirectory: true, relocatedDirectoryContainsUnicodeAndSpaces: true,
  sourcePreservedDuringBuild: true, runtime: metadata.runtime, html: metadata.html, font: metadata.assets.font,
  manifest: { sha256: hash(manifestBytes), bytes: manifestBytes.length }, applicationFiles: manifest.files,
  completion, failures, restoredPackageVerified: true,
  limitations: ['One development Mac with Metal validation; not a clean-machine or performance certification.',
    'Interpreted HTML/CSS with live DOM; no build-time UI compiler or parser omission.',
    'The parent build/probe uses Node; only the native child has a restricted PATH.',
    'Original repository/cache files remain but native reads are denied for the named directories; system libraries are still available.',
    'Does not certify new DOM/input semantics, arbitrary projects, other platforms, font coverage or redistribution.'] };
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: true, report: join(output, 'report.json'), executable }));
