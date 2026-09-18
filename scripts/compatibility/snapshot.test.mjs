import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, toNamespacedPath } from 'node:path';
import { test } from 'node:test';
import { compareSnapshots, readSnapshot, snapshotTree, validateSnapshot } from './snapshot.mjs';

async function setup(t) {
  const temporary = await mkdtemp(join(tmpdir(), '3jsn-preservation-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'project');
  await mkdir(root);
  return { root, temporary };
}

test('content identity is deterministic across ordering and timestamps, with explicit exclusions', async (t) => {
  const { root } = await setup(t);
  await mkdir(join(root, 'assets'));
  await mkdir(join(root, '.git'));
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'z.js'), 'unchanged source');
  await writeFile(join(root, 'assets', 'pixels.bin'), Buffer.from([0, 255, 10, 0]));
  const before = await snapshotTree(root, { exclude: ['dist'] });
  await utimes(join(root, 'z.js'), 1, 1);
  await writeFile(join(root, '.git', 'index'), 'not source');
  await writeFile(join(root, 'dist', 'bundle.js'), 'generated');
  const after = await snapshotTree(root, { exclude: ['dist', 'dist'] });
  assert.deepEqual(before, after);
  assert.equal(compareSnapshots(before, after).preserved, true);
  assert.deepEqual(before.entries.map((entry) => entry.path), ['assets', 'assets/pixels.bin', 'z.js']);
  assert.equal(before.entries[1].bytes, 4);
});

test('same-size edits, deletion, addition and empty directory removal are reported', async (t) => {
  const { root } = await setup(t);
  await writeFile(join(root, 'game.js'), '1234');
  await writeFile(join(root, 'asset.png'), 'abc');
  await mkdir(join(root, 'empty'));
  const before = await snapshotTree(root);
  await writeFile(join(root, 'game.js'), '4321');
  await unlink(join(root, 'asset.png'));
  await rm(join(root, 'empty'), { recursive: true });
  await writeFile(join(root, 'new.css'), 'body{}');
  const result = compareSnapshots(before, await snapshotTree(root));
  assert.equal(result.preserved, false);
  assert.deepEqual(result.changes, [
    { path: 'asset.png', change: 'removed' },
    { path: 'empty', change: 'removed' },
    { path: 'game.js', change: 'modified' },
    { path: 'new.css', change: 'added' },
  ]);
});

test('exclusions are root-relative, not a blanket exclusion of nested assets', async (t) => {
  const { root } = await setup(t);
  await mkdir(join(root, 'assets', 'dist'), { recursive: true });
  await writeFile(join(root, 'assets', 'dist', 'keep.bin'), 'include');
  const snapshot = await snapshotTree(root, { exclude: ['dist'] });
  assert(snapshot.entries.some((entry) => entry.path === 'assets/dist/keep.bin'));
  for (const path of ['../assets', '/absolute', 'assets/../secret', 'assets//x', './assets', 'C:/escape', 'assets\\x', '']) {
    await assert.rejects(snapshotTree(root, { exclude: [path] }), { code: 'INVALID_PATH' });
  }
  assert.throws(() => compareSnapshots(snapshot, { ...snapshot, exclusions: [] }), { code: 'INVALID_MANIFEST' });
  const otherScope = await snapshotTree(root, { exclude: ['assets'] });
  assert.throws(() => compareSnapshots(snapshot, otherScope), { code: 'SCOPE_CHANGED' });
});

test('manifest tampering, traversal, duplicates and invalid hashes fail closed', async (t) => {
  const { root } = await setup(t);
  await writeFile(join(root, 'game.js'), 'source');
  const original = await snapshotTree(root);
  for (const mutation of [
    (snapshot) => { snapshot.entries[0].bytes += 1; },
    (snapshot) => { snapshot.entries[0].sha256 = 'x'; },
    (snapshot) => { snapshot.entries.push(snapshot.entries[0]); },
    (snapshot) => { snapshot.schemaVersion = 2; },
    (snapshot) => { snapshot.entries = [null]; },
    (snapshot) => { snapshot.entries = ['bad']; },
    (snapshot) => { delete snapshot.exclusions; },
    (snapshot) => { snapshot.exclusions = 'not-an-array'; },
  ]) {
    const copy = structuredClone(original);
    mutation(copy);
    assert.throws(() => validateSnapshot(copy), { code: 'INVALID_MANIFEST' });
  }
  const copy = structuredClone(original);
  copy.entries[0].path = '../outside';
  assert.throws(() => validateSnapshot(copy), { code: 'INVALID_MANIFEST' });
  for (const malformed of [null, [], 3, true, 'manifest']) assert.throws(() => validateSnapshot(malformed), { code: 'INVALID_MANIFEST' });
});

test('malformed JSON and unsupported manifest versions retain structured read errors', async (t) => {
  const { temporary } = await setup(t);
  const manifest = join(temporary, 'bad.json');
  for (const contents of ['{invalid', 'null', '{"schemaVersion":99}', '{"schemaVersion":1,"algorithm":"sha256","entries":[null]}']) {
    await writeFile(manifest, contents);
    await assert.rejects(readSnapshot(manifest), { code: 'INVALID_MANIFEST' });
  }
  await assert.rejects(readSnapshot(join(temporary, 'missing.json')), { code: 'ENOENT' });
});

test('contained links preserve target content and link identity without walking aliases', async (t) => {
  const { root } = await setup(t);
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets', 'a'), 'first');
  await writeFile(join(root, 'assets', 'b'), 'second');
  try { await symlink('assets/a', join(root, 'texture'), 'file'); } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows runner requires symlink privileges.');
    throw error;
  }
  const before = await snapshotTree(root);
  await writeFile(join(root, 'assets', 'a'), 'changed');
  assert.deepEqual(compareSnapshots(before, await snapshotTree(root)).changes, [{ path: 'assets/a', change: 'modified' }]);
  await unlink(join(root, 'texture'));
  await symlink('assets/b', join(root, 'texture'), 'file');
  assert(compareSnapshots(before, await snapshotTree(root)).changes.some((entry) => entry.path === 'texture'));
  await symlink('assets', join(root, 'alias'), 'dir');
  const withDirectory = await snapshotTree(root);
  assert.equal(withDirectory.entries.filter((entry) => entry.path.startsWith('alias/')).length, 0);
  assert(withDirectory.entries.some((entry) => entry.path === 'alias' && entry.kind === 'symlink'));
});

test('external, excluded, dangling and cyclic links cannot hide unmeasured content', async (t) => {
  const { root, temporary } = await setup(t);
  await writeFile(join(temporary, 'outside'), 'private');
  try { await symlink('../outside', join(root, 'link'), 'file'); } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows runner requires symlink privileges.');
    throw error;
  }
  await assert.rejects(snapshotTree(root), { code: 'EXTERNAL_LINK' });
  await unlink(join(root, 'link'));
  await symlink('absent', join(root, 'link'), 'file');
  await assert.rejects(snapshotTree(root), { code: 'INVALID_LINK' });
  await unlink(join(root, 'link'));
  await mkdir(join(root, 'ignored'));
  await writeFile(join(root, 'ignored', 'data'), 'input');
  await symlink('ignored/data', join(root, 'link'), 'file');
  await assert.rejects(snapshotTree(root, { exclude: ['ignored'] }), { code: 'EXCLUDED_LINK' });
  await unlink(join(root, 'link'));
  await writeFile(join(root, 'visible'), 'input');
  await symlink('../visible', join(root, 'ignored', 'alias'), 'file');
  await symlink('ignored/alias', join(root, 'link'), 'file');
  await assert.rejects(snapshotTree(root, { exclude: ['ignored'] }), { code: 'EXCLUDED_LINK' });
  await unlink(join(root, 'link'));
  await symlink('link', join(root, 'link'), 'file');
  await assert.rejects(snapshotTree(root), { code: 'INVALID_LINK' });
});

test('CLI captures outside the input tree and returns preservation failure after mutation', async (t) => {
  const { root, temporary } = await setup(t);
  const cli = resolve(import.meta.dirname, 'snapshot-cli.mjs');
  const manifest = join(temporary, 'snapshot.json');
  await writeFile(join(root, 'game.js'), 'original');
  const capture = execFileSync(process.execPath, [cli, 'capture', root, manifest], { encoding: 'utf8' });
  assert.equal(JSON.parse(capture).captured, true);
  const verify = execFileSync(process.execPath, [cli, 'verify', root, manifest], { encoding: 'utf8' });
  assert.equal(JSON.parse(verify).preserved, true);
  await writeFile(join(root, 'game.js'), 'changed');
  const failure = spawnSync(process.execPath, [cli, 'verify', root, manifest], { encoding: 'utf8' });
  assert.equal(failure.status, 4);
  assert.equal(JSON.parse(failure.stdout).preserved, false);
  const overwrite = spawnSync(process.execPath, [cli, 'capture', root, manifest], { encoding: 'utf8' });
  assert.equal(overwrite.status, 3);
  assert.equal(JSON.parse(overwrite.stderr).error.code, 'EEXIST');
  const invalidOutput = spawnSync(process.execPath, [cli, 'capture', root, join(root, 'manifest.json')], { encoding: 'utf8' });
  assert.equal(invalidOutput.status, 2);
  assert.equal(JSON.parse(invalidOutput.stderr).error.code, 'INVALID_OUTPUT');
  const unavailable = spawnSync(process.execPath, [cli, 'verify', root, join(temporary, 'missing.json')], { encoding: 'utf8' });
  assert.equal(unavailable.status, 3);
  assert.equal(JSON.parse(unavailable.stderr).error.code, 'ENOENT');
  assert.equal(JSON.parse(await readFile(manifest, 'utf8')).schemaVersion, 1);
});

test('CLI rejects output aliases into the source tree', async (t) => {
  const { root, temporary } = await setup(t);
  const alias = join(temporary, 'alias');
  try { await symlink(root, alias, 'dir'); } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows runner requires symlink privileges.');
    throw error;
  }
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, 'snapshot-cli.mjs'), 'capture', root, join(alias, 'new', 'manifest.json')], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_OUTPUT');
  await assert.rejects(snapshotTree(alias), { code: 'INVALID_ROOT' });
});

test('explicit basename exclusions skip nested dependency trees and record their scope', async t => {
  const { root } = await setup(t);
  await mkdir(join(root, 'packages/a/node_modules'), { recursive: true });
  await mkdir(join(root, 'node_modules/.pnpm/foo'), { recursive: true });
  await writeFile(join(root, 'packages/a/main.js'), 'export {};');
  await writeFile(join(root, 'node_modules/.pnpm/foo/index.js'), 'dependency');
  await symlink(process.platform === 'win32' ? join(root, 'node_modules/.pnpm/foo') : '../../../node_modules/.pnpm/foo', join(root, 'packages/a/node_modules/foo'), process.platform === 'win32' ? 'junction' : 'dir');
  const policy = { exclude: ['node_modules'], excludeBasenames: ['node_modules'] };
  const before = await snapshotTree(root, policy);
  assert.deepEqual(before.excludeBasenames, ['node_modules']);
  assert.ok(before.entries.every(entry => !entry.path.split('/').includes('node_modules')));
  await writeFile(join(root, 'node_modules/.pnpm/foo/index.js'), 'changed excluded dependency');
  assert.equal(compareSnapshots(before, await snapshotTree(root, policy)).preserved, true);
  const tampered = structuredClone(before);
  delete tampered.excludeBasenames;
  assert.throws(() => validateSnapshot(tampered), { code: 'INVALID_MANIFEST' });
  await symlink(process.platform === 'win32' ? join(root, 'packages/a/node_modules') : 'packages/a/node_modules', join(root, 'source-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(snapshotTree(root, policy), { code: 'EXCLUDED_LINK' });
});

test('basename exclusions do not alter legacy exact-path snapshot scope', async t => {
  const { root } = await setup(t);
  await mkdir(join(root, 'nested/node_modules'), { recursive: true });
  await writeFile(join(root, 'nested/node_modules/file.js'), 'dependency');
  const legacy = await snapshotTree(root, { exclude: ['node_modules'] });
  assert.ok(legacy.entries.some(entry => entry.path === 'nested/node_modules/file.js'));
  assert.equal(Object.hasOwn(legacy, 'excludeBasenames'), false);
  const excluded = await snapshotTree(root, { exclude: ['node_modules'], excludeBasenames: ['node_modules'] });
  assert.throws(() => compareSnapshots(legacy, excluded), { code: 'SCOPE_CHANGED' });
  await assert.rejects(snapshotTree(root, { excludeBasenames: ['nested/node_modules'] }), { code: 'INVALID_EXCLUSIONS' });
});

test('absolute directory links preserve raw spelling and match canonical root scope', async t => {
  const { root, temporary } = await setup(t);
  const target = join(root, 'included');
  await mkdir(target);
  await writeFile(join(target, 'value.txt'), 'included');
  const alias = join(root, 'alias');
  // Junctions expose namespace-prefixed readlink targets on Windows even when
  // the caller supplied an ordinary absolute drive path.
  await symlink(await realpath(target), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const captured = await snapshotTree(toNamespacedPath(root));
  assert.equal(captured.entries.find(entry => entry.path === 'alias').target, await readlink(alias));
  assert.ok(captured.entries.some(entry => entry.path === 'included/value.txt'));
  await assert.rejects(snapshotTree(root, { exclude: ['included'] }), { code: 'EXCLUDED_LINK' });
  await unlink(alias);
  const outside = join(temporary, 'outside');
  await mkdir(outside);
  await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(snapshotTree(root), { code: 'EXTERNAL_LINK' });
});


test('root ancestor aliases retain lexical exclusions and canonical containment', async t => {
  const { root, temporary } = await setup(t);
  const aliasParent = join(temporary, 'root-parent-alias');
  await symlink(await realpath(temporary), aliasParent, process.platform === 'win32' ? 'junction' : 'dir');
  const inputRoot = join(aliasParent, 'project');
  await mkdir(join(root, 'included'));
  await writeFile(join(root, 'included/value.txt'), 'measured');
  await symlink(join(inputRoot, 'included'), join(root, 'source-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const snapshot = await snapshotTree(inputRoot);
  assert.ok(snapshot.entries.some(entry => entry.path === 'included/value.txt'));
  await assert.rejects(snapshotTree(inputRoot, { exclude: ['included'] }), { code: 'EXCLUDED_LINK' });
  await unlink(join(root, 'source-alias'));
  await mkdir(join(temporary, 'outside'));
  await symlink(join(aliasParent, 'outside'), join(root, 'source-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(snapshotTree(inputRoot), { code: 'EXTERNAL_LINK' });
});
