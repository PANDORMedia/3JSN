import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildProject, describeRuntime } from './build.mjs';
import { hostTarget, portablePath, validateDescription } from './contract.mjs';
import { snapshotTree } from '../../scripts/compatibility/snapshot.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const description = () => ({ schemaVersion: 1, playerVersion: '0.0.0', packageVersions: [1],
  profiles: ['native-window-v1'], target: hostTarget(),
  backend: { darwin: 'metal', linux: 'vulkan', win32: 'dx12' }[process.platform], v8: 'test-version' });

async function fixture(t, entry = 'import { answer } from "./answer.ts"; console.log(answer);') {
  const temporary = await mkdtemp(join(tmpdir(), '3jsn-cli-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = join(temporary, 'project');
  const runtime = join(temporary, 'supplied-player');
  const out = join(temporary, 'packed');
  await mkdir(project);
  await writeFile(runtime, 'explicit test player bytes');
  const config = { schemaVersion: 1, profile: 'native-window-v1', name: 'original-game', entry: 'main.ts' };
  await writeFile(join(project, '3jsn.json'), JSON.stringify(config));
  await writeFile(join(project, 'main.ts'), entry);
  await writeFile(join(project, 'answer.ts'), 'export const answer: number = 42;');
  return { temporary, project, runtime, out, config,
    options: { project, runtime, out, experimental: true },
    build(overrides = {}, describe = async () => description()) {
      return buildProject({ project, runtime, out, experimental: true, ...overrides }, { describeRuntime: describe });
    } };
}

async function failed(f, code, action = () => f.build()) {
  let error;
  await assert.rejects(action, value => { error = value; return value.code === code; });
  assert.equal((await readdir(f.temporary)).some(name => name.startsWith('.3jsn-build-')), false);
  if (error.receipt) {
    const receipt = await readJson(error.receipt);
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.error.code, code);
    assert.equal((await lstat(error.receipt)).isFile(), true);
    if (process.platform !== 'win32') assert.equal((await stat(error.receipt)).mode & 0o777, 0o600);
  }
  return error;
}

test('real bundling emits a relocatable manifest, linked map, identities and unchanged source', async t => {
  const f = await fixture(t);
  await mkdir(join(f.project, 'assets'));
  await mkdir(join(f.project, 'empty'));
  await mkdir(join(f.project, '.git'));
  await mkdir(join(f.project, 'node_modules'));
  await writeFile(join(f.project, 'assets', 'original.bin'), Buffer.from([0, 128, 255]));
  await writeFile(join(f.project, '.git', 'index'), 'ignored');
  await writeFile(join(f.project, 'node_modules', 'unused'), 'ignored');
  await writeFile(join(f.project, 'package.json'), JSON.stringify({ scripts: { build: 'touch must-not-run' } }));
  const before = await snapshotTree(f.project, { exclude: ['node_modules'] });
  const result = await f.build({ targets: hostTarget() });
  assert.equal(result.status, 'experimental');
  assert.equal(result.sourcePreserved, true);
  assert.deepEqual(await snapshotTree(f.project, { exclude: ['node_modules'] }), before);
  const manifest = await readJson(result.manifest);
  assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'profile', 'name', 'target', 'entry', 'files']);
  assert.equal(manifest.entry, 'app/main.mjs');
  assert.deepEqual(manifest.files.map(item => item.path), ['app/main.mjs', 'app/main.mjs.map']);
  for (const item of manifest.files) {
    const bytes = await readFile(join(f.out, item.path));
    assert.equal(hash(bytes), item.sha256);
    assert.equal(bytes.length, item.bytes);
    assert.equal((await lstat(join(f.out, item.path))).isFile(), true);
  }
  assert.deepEqual(await readFile(result.executable), await readFile(f.runtime));
  if (process.platform !== 'win32') assert.equal((await stat(result.executable)).mode & 0o777, 0o755);
  const bundle = await readFile(join(f.out, manifest.entry), 'utf8');
  assert.match(bundle, /sourceMappingURL=main\.mjs\.map/);
  assert.equal(execFileSync(process.execPath, [join(f.out, manifest.entry)], { encoding: 'utf8' }).trim(), '42');
  const map = await readJson(join(f.out, 'app/main.mjs.map'));
  assert.ok(map.sources.every(source => source.startsWith('3jsn-source:///project/')));
  assert.equal(JSON.stringify(map).includes(f.temporary), false);
  assert.ok(map.sourcesContent.some(source => source.includes('answer: number = 42')));
  const metadata = await readJson(result.metadata);
  assert.equal(metadata.status, 'experimental');
  assert.equal(metadata.compatibility.certified, false);
  assert.equal(metadata.compatibility.unresolvedDynamicBehavior, true);
  assert.deepEqual(metadata.source.before, before);
  assert.deepEqual(metadata.source.after, before);
  assert.equal(metadata.source.preservation.preserved, true);
  assert.ok(metadata.source.before.entries.some(item => item.path === 'assets/original.bin'));
  assert.ok(metadata.source.before.entries.some(item => item.path === 'empty'));
  assert.equal(metadata.runtime.sha256, hash(await readFile(f.runtime)));
  assert.equal(metadata.manifest.sha256, hash(await readFile(result.manifest)));
  assert.ok(metadata.esbuild.inputs.some(item => item.path === 'project/answer.ts'));
  assert.equal((await readdir(f.temporary)).some(name => name.startsWith('.3jsn-')), false);
});

test('experimental opt-in and every unsupported or multi target fail before writing or describing', async t => {
  const f = await fixture(t);
  const names = await readdir(f.temporary);
  for (const targets of ['', 'other-target', `${hostTarget()},${hostTarget()}`, `${hostTarget()},linux-x64`, ['linux-x64']]) {
    await failed(f, 'UNSUPPORTED_TARGET', () => f.build({ targets }, () => assert.fail('must not inspect runtime')));
    assert.deepEqual(await readdir(f.temporary), names);
  }
  await failed(f, 'EXPERIMENTAL_REQUIRED', () => f.build({ experimental: false }, () => assert.fail('must not inspect runtime')));
  assert.deepEqual(await readdir(f.temporary), names);
});

test('host targets and portable paths match the initial player contract', () => {
  for (const [platform, arch, target, backend] of [['darwin', 'arm64', 'macos-arm64', 'metal'], ['darwin', 'x64', 'macos-x64', 'metal'],
    ['linux', 'x64', 'linux-x64', 'vulkan'], ['win32', 'x64', 'windows-x64', 'dx12']]) {
    assert.equal(hostTarget(platform, arch), target);
    assert.equal(validateDescription({ ...description(), target, backend }, target).backend, backend);
  }
  for (const [platform, arch] of [['linux', 'arm64'], ['win32', 'arm64'], ['freebsd', 'x64'], ['linux', 'riscv64']]) {
    assert.throws(() => hostTarget(platform, arch), { code: 'UNSUPPORTED_HOST' });
  }
  for (const path of ['dir*/main.js', 'a?/main.js', 'a</main.js', 'a>/main.js', 'a|/main.js', 'a"/main.js', 'dir./main.js',
    'dir /main.js', 'CON.js', 'dir/Lpt9/main.js', 'x\u0085/main.js']) assert.equal(portablePath(path), false, path);
  assert.equal(portablePath('source/some component/main.ts'), true);
});

test('strict configuration rejects unknown fields, wrong versions/profiles and unsafe names or entries', async t => {
  const f = await fixture(t);
  for (const config of [null, [], { ...f.config, extra: true }, { ...f.config, schemaVersion: 2 },
    { ...f.config, profile: 'unchanged-browser-game' }, ...['CON', 'con', 'aux', 'com1', 'lpt9', 'app', 'metadata', '../escape', 'has space', 'UPPER', 'a'.repeat(65)].map(name => ({ ...f.config, name })),
    ...['../outside.mjs', '/tmp/a.mjs', './main.ts', 'a//b.js', 'a/../b.js', 'C:/a.js', 'a\\b.js', 'a\n.js', 'main.html'].map(entry => ({ ...f.config, entry }))]) {
    await writeFile(join(f.project, '3jsn.json'), JSON.stringify(config));
    const error = await failed(f, 'INVALID_CONFIG');
    assert.equal(error.sourcePreserved, true);
    await assert.rejects(lstat(f.out), { code: 'ENOENT' });
  }
  await writeFile(join(f.project, '3jsn.json'), '{bad');
  await failed(f, 'INVALID_CONFIG');
});

test('existing empty directories, occupied directories and files are never clobbered', async t => {
  const f = await fixture(t);
  for (const kind of ['empty', 'occupied', 'file']) {
    if (kind === 'file') await writeFile(f.out, 'keep me');
    else { await mkdir(f.out); if (kind === 'occupied') await writeFile(join(f.out, 'keep'), 'keep me'); }
    await failed(f, 'OUTPUT_EXISTS', () => f.build({}, () => assert.fail('must not inspect runtime')));
    if (kind === 'file') assert.equal(await readFile(f.out, 'utf8'), 'keep me');
    else assert.deepEqual(await readdir(f.out), kind === 'empty' ? [] : ['keep']);
    await rm(f.out, { recursive: true });
  }
});

test('a destination appearing during a build survives and staging is removed', async t => {
  const f = await fixture(t);
  const error = await failed(f, 'OUTPUT_EXISTS', () => f.build({}, async () => {
    await mkdir(f.out);
    return description();
  }));
  assert.equal(error.sourcePreserved, true);
  assert.deepEqual(await readdir(f.out), []);
});

test('output containment rejects direct and symlink aliases into the project', async t => {
  const f = await fixture(t);
  await failed(f, 'INVALID_OUTPUT', () => f.build({ out: join(f.project, 'packed') }));
  const alias = join(f.temporary, 'alias');
  try { await symlink(f.project, alias, 'junction'); } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Symlink privileges unavailable.');
    throw error;
  }
  await failed(f, 'INVALID_OUTPUT', () => f.build({ out: join(alias, 'packed') }));
  await failed(f, 'INVALID_PROJECT', () => f.build({ project: alias }));
  await assert.rejects(lstat(join(f.project, 'packed')), { code: 'ENOENT' });
});

test('entry symlinks are refused, and imported source cannot escape outside node_modules', async t => {
  const f = await fixture(t, 'import "../outside.mjs";');
  await writeFile(join(f.temporary, 'outside.mjs'), 'console.log("outside");');
  await failed(f, 'EXTERNAL_SOURCE');
  await writeFile(join(f.project, 'main.ts'), 'console.log("inside");');
  try { await symlink('main.ts', join(f.project, 'alias.mjs'), 'file'); } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Symlink privileges unavailable.');
    throw error;
  }
  await writeFile(join(f.project, '3jsn.json'), JSON.stringify({ ...f.config, entry: 'alias.mjs' }));
  await failed(f, 'INVALID_ENTRY');
});

for (const [name, source, code] of [
  ['syntax error', 'export const = ;', 'BUNDLE_FAILED'],
  ['unresolved module', 'import "not-an-installed-module";', 'BUNDLE_FAILED'],
  ['bundler warning', 'console.log({ duplicated: 1, duplicated: 2 });', 'BUNDLE_WARNING'],
  ['external URL import', 'import "https://example.invalid/module.js";', 'EXTERNAL_IMPORT'],
]) {
  test(`${name} leaves no package or staging and retains before/after preservation evidence`, async t => {
    const f = await fixture(t, source);
    const error = await failed(f, code);
    assert.equal(error.sourcePreserved, true);
    const receipt = await readJson(error.receipt);
    assert.deepEqual(receipt.source.before, receipt.source.after);
    await assert.rejects(lstat(f.out), { code: 'ENOENT' });
  });
}

test('source mutations during runtime inspection reject publication and retain the actual differences', async t => {
  const f = await fixture(t);
  const error = await failed(f, 'SOURCE_CHANGED', () => f.build({}, async () => {
    await writeFile(join(f.project, 'answer.ts'), 'export const answer = 43;');
    return description();
  }));
  assert.equal(error.sourcePreserved, false);
  const receipt = await readJson(error.receipt);
  assert.deepEqual(receipt.source.preservation.changes, [{ path: 'answer.ts', change: 'modified' }]);
  assert.equal(await readFile(join(f.project, 'answer.ts'), 'utf8'), 'export const answer = 43;');
  await assert.rejects(lstat(f.out), { code: 'ENOENT' });
});

test('cancellation after snapshot waits for cleanup and retains unchanged-source evidence', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const error = await failed(f, 'CANCELLED', () => f.build({ signal: controller.signal }, async (_path, { signal }) => {
    assert.equal(signal, controller.signal);
    controller.abort();
    return description();
  }));
  assert.equal(error.sourcePreserved, true);
  const receipt = await readJson(error.receipt);
  assert.deepEqual(receipt.source.before, receipt.source.after);
  assert.deepEqual(receipt.cleanupErrors, []);
  await assert.rejects(lstat(f.out), { code: 'ENOENT' });
});

test('failed final source verification reports unknown preservation instead of success', async t => {
  const f = await fixture(t);
  const probe = join(f.temporary, 'link-permission-probe');
  try { await symlink('missing', probe, 'file'); } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Symlink privileges unavailable.');
    throw error;
  }
  await rm(probe);
  const controller = new AbortController();
  const error = await failed(f, 'CANCELLED', () => f.build({ signal: controller.signal }, async () => {
    await symlink('missing', join(f.project, 'unreadable-link'), 'file');
    controller.abort();
    return description();
  }));
  assert.equal(error.sourcePreserved, null);
  const receipt = await readJson(error.receipt);
  assert.ok(receipt.source.before.digest);
  assert.equal(receipt.source.after, null);
  assert.equal(receipt.source.preservation, null);
  assert.equal(receipt.source.snapshotError.code, 'INVALID_LINK');
  await assert.rejects(lstat(f.out), { code: 'ENOENT' });
});

test('runtime protocol mismatch and binary mutation fail with distinct structured errors', async t => {
  const f = await fixture(t);
  for (const value of [null, [], {}, { ...description(), schemaVersion: 2 }, { ...description(), profiles: [] },
    { ...description(), packageVersions: [2] }, { ...description(), target: 'unsupported-target' }, { ...description(), backend: 'software' }]) {
    await failed(f, 'INCOMPATIBLE_RUNTIME', () => f.build({}, async () => value));
  }
  await failed(f, 'RUNTIME_CHANGED', () => f.build({}, async () => {
    await writeFile(f.runtime, 'changed player');
    return description();
  }));
});

test('a parent node_modules dependency is bundled and its actual bytes are measured', async t => {
  const f = await fixture(t, 'import { value } from "measured-package"; console.log(value);');
  const dependency = join(f.temporary, 'node_modules', 'measured-package');
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, 'package.json'), '{"name":"measured-package","main":"index.js"}');
  const source = 'exports.value = "bundled dependency";';
  await writeFile(join(dependency, 'index.js'), source);
  const result = await f.build();
  const metadata = await readJson(result.metadata);
  const input = metadata.esbuild.inputs.find(item => item.path.startsWith('dependencies/'));
  assert.equal(input.sha256, hash(source));
  assert.equal(input.bytes, Buffer.byteLength(source));
  const map = await readJson(join(f.out, 'app/main.mjs.map'));
  assert.ok(map.sources.some(path => path.startsWith('3jsn-source:///dependencies/')));
  assert.ok(map.sourcesContent.includes(source));
  assert.equal(execFileSync(process.execPath, [join(f.out, 'app/main.mjs')], { encoding: 'utf8' }).trim(), 'bundled dependency');
});

test('computed dynamic loading remains explicitly unresolved instead of claiming compatibility', async t => {
  const f = await fixture(t, 'const path = globalThis.moduleName; export const load = () => import(path);');
  const result = await f.build();
  const metadata = await readJson(result.metadata);
  assert.equal(metadata.status, 'experimental');
  assert.equal(metadata.compatibility.certified, false);
  assert.equal(metadata.compatibility.unresolvedDynamicBehavior, true);
  assert.ok(metadata.compatibility.limitations.some(item => item.includes('Computed imports')));
  assert.match(await readFile(join(f.out, 'app/main.mjs'), 'utf8'), /import\(path\)/);
});

test('chained source maps with unmeasured originals fail explicitly instead of losing source provenance', async t => {
  const map = { version: 3, file: 'compiled.js', sources: ['unavailable-original.ts'], sourcesContent: ['console.log(42);'], names: [], mappings: 'AAAA' };
  const url = `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
  const f = await fixture(t, `console.log(42);\n//# sourceMappingURL=${url}\n`);
  const error = await failed(f, 'UNSUPPORTED_SOURCE_MAP');
  assert.equal(error.sourcePreserved, true);
  await assert.rejects(lstat(f.out), { code: 'ENOENT' });
});

test('CLI reports malformed arguments and target refusal with a nonzero JSON error', async t => {
  const f = await fixture(t);
  for (const args of [[], ['run', f.project], ['build', f.project, '--experimental', '--experimental'],
    ['build', f.project, '--unknown'], ['build', f.project, '--runtime'],
    ['build', f.project, '--runtime', f.runtime, '--out', f.out, '--experimental', '--targets', 'not-this-host']]) {
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, 'cli.mjs'), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.ok(['USAGE', 'UNSUPPORTED_TARGET'].includes(JSON.parse(result.stderr).error.code));
    assert.equal(result.stdout, '');
  }
});

test('real describe subprocess uses JSON stdout and rejects malformed output or nonzero exit', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const executable = join(f.temporary, 'describe-player');
  for (const [body, code] of [
    [`console.log(${JSON.stringify(JSON.stringify(description()))});`, undefined],
    ['console.log("garbage");', 'INVALID_RUNTIME_DESCRIPTION'],
    ['process.exitCode = 3;', 'RUNTIME_DESCRIBE_FAILED'],
  ]) {
    await writeFile(executable, `#!${process.execPath}\nif(process.argv[2] !== '--describe') process.exit(9);\n${body}\n`);
    await chmod(executable, 0o755);
    if (code) await assert.rejects(describeRuntime(executable), { code });
    else assert.deepEqual(await describeRuntime(executable), description());
  }
});
