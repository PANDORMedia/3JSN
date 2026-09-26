import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const [playerArgument, fontArgument, outputArgument, ...extra] = process.argv.slice(2);
assert(process.platform === 'darwin', 'The Vite DOM-window probe currently requires macOS/Metal.');
assert(playerArgument && fontArgument && outputArgument && !extra.length,
  'Usage: node scripts/probe-vite-package.mjs <dom-player> <font.woff2> <new-evidence-directory>');
const output = resolve(outputArgument);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['3jsn.json', 'vite.config.mjs', 'dom-window/index.html', 'dom-window/app.mjs', 'spinning-scene/scene.mjs'];
const inputFiles = ['scripts/probe-vite-package.mjs', 'packages/cli/build.mjs', 'packages/cli/vite-build.mjs',
  'packages/cli/html.mjs', 'packages/cli/contract.mjs', 'packages/cli/cli.mjs', 'scripts/compatibility/snapshot.mjs',
  'package-lock.json', ...sourceFiles.map(path => `examples/${path}`)];
const inputs = await Promise.all(inputFiles.map(async path => ({ path, sha256: hash(await readFile(join(root, path))) })));
await mkdir(output);
const source = join(output, 'build-input');
for (const path of sourceFiles) {
  await mkdir(dirname(join(source, path)), { recursive: true });
  await copyFile(join(root, 'examples', path), join(source, path));
}
await symlink(join(root, 'node_modules'), join(source, 'node_modules'), 'dir');
const font = join(output, 'build-font.woff2');
await copyFile(resolve(fontArgument), font);
const { stdout, stderr } = await execute(process.execPath, [join(root, 'packages/cli/cli.mjs'), 'build', source,
  '--runtime', resolve(playerArgument), '--font', font, '--frontend', 'vite', '--out', join(output, 'built'), '--experimental'],
{ cwd: root, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
await writeFile(join(output, 'build-stdout.txt'), stdout);
await writeFile(join(output, 'build-stderr.txt'), stderr);
const build = JSON.parse(stdout.trim().split('\n').at(-1));
const relocated = join(output, 'Relocated Vite Demo α');
await rename(build.output, relocated);
await rm(source, { recursive: true });
await rm(font);
for (const path of [source, font]) await assert.rejects(stat(path), { code: 'ENOENT' });

const cwd = join(output, 'unrelated-working-directory');
await mkdir(cwd);
const environment = { ...process.env, PATH: '/usr/bin:/bin', MTL_DEBUG_LAYER: '1' };
await assert.rejects(execute('node', ['--version'], { env: environment }), { code: 'ENOENT' });
const executable = join(relocated, '3jsn-dom-demo');
const manifestPath = join(relocated, 'app.json');
const manifest = JSON.parse(await readFile(manifestPath));
const deniedDirectories = [source, join(root, 'node_modules'), join(root, 'examples'), join(root, 'crates'), join(root, 'experiments')];
const sandbox = join(output, 'native-only.sb');
await writeFile(sandbox, `(version 1)\n(allow default)\n(deny network*)\n(deny file-read*\n${deniedDirectories.map(path => `  (subpath ${JSON.stringify(path)})`).join('\n')}\n)\n`);
const nativeOptions = { cwd, env: environment, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 };
const nativeExecute = args => execute('/usr/bin/sandbox-exec', ['-f', sandbox, executable, ...args], nativeOptions);
const verify = await nativeExecute(['--verify-app', manifestPath]);
assert.deepEqual(JSON.parse(verify.stdout), { packageVerified: true });
const native = await nativeExecute(['--frames', '120']);
await writeFile(join(output, 'native-stdout.txt'), native.stdout);
await writeFile(join(output, 'native-stderr.txt'), native.stderr);
const completion = native.stdout.trim().split('\n').map(line => JSON.parse(line)).find(record => record.nativeDomWindow === true);
assert.equal(completion?.presentedFrames, 120);
assert.equal(completion?.cpuImageTransport, false);
assert.equal(completion?.nativeDeviceIdentityChecked, true);
assert.equal(completion?.nativeQueueIdentityChecked, true);
const metadata = JSON.parse(await readFile(join(relocated, 'metadata/build.json')));
assert.equal(metadata.vite.htmlEntry, 'dom-window/index.html');
assert.deepEqual(metadata.source.preservation.preserved, true);
assert.equal(JSON.stringify(metadata).includes(output), false, 'Package metadata must not retain temporary build paths.');
for (const input of inputs) assert.equal(hash(await readFile(join(root, input.path))), input.sha256, `${input.path} changed during the probe`);

const report = { kind: 'experimental-vite-native-package-relocation', profile: build.profile, target: build.target, inputs,
  vite: metadata.vite, removedDisposableBuildInput: true, removedSuppliedFont: true, nodeOnRestrictedPath: false,
  deniedBuildTimeSourceDirectories: deniedDirectories, nativeNetworkDenied: true,
  unrelatedWorkingDirectory: true, relocatedDirectoryContainsUnicodeAndSpaces: true,
  sourcePreservedDuringBuild: metadata.source.preservation.preserved, runtime: metadata.runtime,
  html: metadata.html, manifest: { sha256: hash(await readFile(manifestPath)), files: manifest.files }, completion,
  limitations: ['One development Mac with Metal validation; not a clean-machine or performance certification.',
    'Only one Vite HTML entry and a static JavaScript graph are admitted; CSS files, assets, dynamic chunks, workers, Wasm and server output are rejected.',
    'The DOM profile remains experimental and retains its runtime HTML/CSS parsers.',
    'Only the native child has a restricted PATH and file/network sandbox.'] };
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: true, report: join(output, 'report.json'), executable }));
