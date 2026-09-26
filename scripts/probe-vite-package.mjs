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
const sourceFiles = ['3jsn.json', 'vite.config.mjs', 'dom-window/index.html', 'dom-window/style.css', 'dom-window/app.mjs', 'spinning-scene/scene.mjs'];
const inputFiles = ['scripts/probe-vite-package.mjs', 'packages/cli/build.mjs', 'packages/cli/vite-build.mjs',
  'packages/cli/html.mjs', 'packages/cli/contract.mjs', 'packages/cli/cli.mjs', 'packages/cli/web-fonts.mjs',
  'packages/cli/web-font-cache.mjs', 'packages/cli/web-font-policy.mjs', 'scripts/compatibility/snapshot.mjs',
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
const fontState = join(dirname(output), `.3jsn-vite-font-${hash(Buffer.from(output)).slice(0, 16)}`);
await copyFile(resolve(fontArgument), font);
await copyFile(font, join(source, 'dom-window/probe.woff2'));
await writeFile(join(source, 'dom-window/style.css'), `${await readFile(join(source, 'dom-window/style.css'), 'utf8')}\n`
  + '@font-face { font-family: "3JSN Probe"; src: url("./probe.woff2") format("woff2"); font-display: swap; }\n'
  + 'body { font-family: "3JSN Probe", sans-serif; }\n');
const { stdout, stderr } = await execute(process.execPath, [join(root, 'packages/cli/cli.mjs'), 'build', source,
  '--runtime', resolve(playerArgument), '--font', font, '--frontend', 'vite', '--bundle-web-fonts', '--web-fonts-state', fontState,
  '--out', join(output, 'built'), '--experimental'],
{ cwd: root, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
await writeFile(join(output, 'build-stdout.txt'), stdout);
await writeFile(join(output, 'build-stderr.txt'), stderr);
const build = JSON.parse(stdout.trim().split('\n').at(-1));
const relocated = join(output, 'Relocated Vite Demo α');
await rename(build.output, relocated);
await rm(source, { recursive: true });
await rm(font);
await rm(fontState, { recursive: true, force: true });
for (const path of [source, font, fontState]) await assert.rejects(stat(path), { code: 'ENOENT' });

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
const runtimeRecords = native.stdout.trim().split('\n').map(line => JSON.parse(line));
const completion = runtimeRecords.find(record => record.nativeDomWindow === true);
const resourceDelivery = runtimeRecords.find(record => record.packagedResources)?.packagedResources;
const webFonts = runtimeRecords.find(record => record.packagedResources)?.webFonts;
assert.equal(completion?.presentedFrames, 120);
assert.equal(completion?.cpuImageTransport, false);
assert.equal(completion?.nativeDeviceIdentityChecked, true);
assert.equal(completion?.nativeQueueIdentityChecked, true);
assert.equal(resourceDelivery?.stylesheetDeliveries, 1);
assert.equal(resourceDelivery?.fontDeliveries, 1);
assert.equal(resourceDelivery?.fontRegistrationVerified, true);
assert.equal(resourceDelivery?.transportDrained, true);
assert.ok(resourceDelivery.deliveredUrls.some(url => url.endsWith('.css')));
assert.ok(resourceDelivery.deliveredUrls.some(url => url.endsWith('.woff2')));
assert.equal(webFonts?.requested, 1);
assert.equal(webFonts?.registered, 1);
assert.ok(webFonts?.decodedBytes > 0);
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
  html: metadata.html, manifest: { sha256: hash(await readFile(manifestPath)), files: manifest.files },
  packagedResources: resourceDelivery, webFonts, completion,
  limitations: ['One development Mac with Metal validation; not a clean-machine or performance certification.',
    'Only one Vite HTML entry and static JavaScript graph are admitted; opt-in webfont localization handles supported CSS/font resources, while other emitted assets, dynamic chunks, workers, Wasm and server output are rejected.',
    'The DOM profile remains experimental and retains its runtime HTML/CSS parsers.',
    'Only the native child has a restricted PATH and file/network sandbox.'] };
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: true, report: join(output, 'report.json'), executable }));
