import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildViteProject } from './vite-build.mjs';
import { snapshotTree } from '../../scripts/compatibility/snapshot.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

async function fixture(t, { plugin = '', delay = false } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), '3jsn-vite-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const workspace = join(temporary, 'workspace');
  const project = join(workspace, 'packages', 'game');
  const out = join(temporary, 'captured');
  await mkdir(join(project, 'src'), { recursive: true });
  await mkdir(join(project, 'public'));
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'fixture-workspace', private: true, workspaces: ['packages/*'] }));
  await symlink(join(repository, 'node_modules'), join(workspace, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'vite-fixture', private: true, type: 'module' }));
  await writeFile(join(project, 'index.html'), '<!doctype html><html><head></head><body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>');
  await writeFile(join(project, 'vite.config.js'), `import { writeFileSync } from 'node:fs';\nexport default { plugins: [{ name: 'artifact-fixture', generateBundle() { this.emitFile({ type: 'asset', fileName: 'plugin-output.txt', source: 'plugin output' }); } }, ${plugin}] };`);
  await writeFile(join(project, 'src/main.js'), `import largeAsset from './large.bin?url';
import wasmAsset from './module.wasm?url';
import('./lazy.js').then(module => { globalThis.lazyValue = module.value; });
new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
document.querySelector('#app').textContent = largeAsset + wasmAsset;
`);
  await writeFile(join(project, 'src/lazy.js'), 'export const value = 42;');
  await writeFile(join(project, 'src/worker.js'), 'postMessage("worker-ready");');
  await writeFile(join(project, 'src/large.bin'), Buffer.alloc(8192, 7));
  const wasm = Buffer.alloc(8192);
  Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]).copy(wasm);
  await writeFile(join(project, 'src/module.wasm'), wasm);
  await writeFile(join(project, 'public/from-public.txt'), 'public asset');
  if (delay) await writeFile(join(project, 'vite.config.js'), `export default { plugins: [{ name: 'wait-for-cancel', buildStart() { return new Promise(resolve => setTimeout(resolve, 60000)); } }] };`);
  return { project, out, temporary };
}

test('Vite output report captures manifest edges, source maps, plugin, worker, Wasm, public and other assets', async t => {
  const f = await fixture(t);
  const before = await snapshotTree(join(f.project, '..', '..'), { exclude: ['node_modules'] });
  const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const invocation = spawnSync(process.execPath, [cliPath, 'vite-build', f.project, '--out', f.out], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(invocation.status, 0, invocation.stderr);
  const result = JSON.parse(invocation.stdout.trim().split('\n').at(-1));
  assert.equal(result.sourcePreserved, true);
  assert.deepEqual(await snapshotTree(join(f.project, '..', '..'), { exclude: ['node_modules'] }), before);
  const report = await readJson(result.report);
  assert.equal(report.adapter, 'vite-client-artifact-graph-v1');
  assert.equal(report.executionBoundary.status, 'unclassified');
  assert.equal(report.project.relativeToSourceRoot, 'packages/game');
  assert.equal(report.source.preservation.preserved, true);
  assert.ok(report.manifest.entries.some(entry => entry.isEntry && entry.file.endsWith('.js')));
  assert.ok(report.manifest.entries.some(entry => entry.isDynamicEntry));
  assert.ok(report.sourceMaps.some(map => map.path.endsWith('.map') && map.sources.length > 0));
  assert.ok(report.documents.some(document => document.references.some(reference => reference.element === 'script' && reference.attribute === 'src')));
  const paths = new Set(report.files.map(file => file.path));
  assert.ok(paths.has('.vite/manifest.json'));
  assert.ok(paths.has('plugin-output.txt'));
  assert.ok(paths.has('from-public.txt'));
  assert.ok([...paths].some(path => path.includes('worker') && path.endsWith('.js')));
  assert.ok([...paths].some(path => path.endsWith('.wasm')));
  for (const file of report.files) {
    const bytes = await readFile(join(result.web, ...file.path.split('/')));
    assert.equal(file.bytes, bytes.length);
    assert.equal(file.sha256, hash(bytes));
  }
});

test('failed Vite build detects workspace source mutation and never publishes output', async t => {
  const f = await fixture(t, { plugin: `{ name: 'intentional-failure', buildStart() { writeFileSync(process.cwd() + '/../../workspace-mutated.txt', 'changed'); throw new Error('fixture failure'); } }` });
  const before = await snapshotTree(join(f.project, '..', '..'), { exclude: ['node_modules'] });
  await assert.rejects(buildViteProject({ project: f.project, out: f.out }), error => {
    assert.equal(error.code, 'VITE_FAILED');
    assert.equal(error.sourcePreserved, false);
    assert.deepEqual(error.source.before, before);
    assert.equal(error.source.preservation.preserved, false);
    assert.ok(error.source.preservation.changes.some(change => change.path === 'workspace-mutated.txt' && change.change === 'added'));
    return true;
  });
  await assert.rejects(readFile(f.out), { code: 'ENOENT' });
});

test('CLI exposes before/after workspace hashes when Vite fails', async t => {
  const f = await fixture(t, { plugin: `{ name: 'intentional-failure', buildStart() { throw new Error('fixture failure'); } }` });
  const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cliPath, 'vite-build', f.project, '--out', f.out], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr.trim().split('\n').at(-1));
  assert.equal(error.error.code, 'VITE_FAILED');
  assert.equal(error.error.sourcePreserved, true);
  assert.equal(error.error.source.preserved, true);
  assert.equal(error.error.source.before, error.error.source.after);
  await assert.rejects(readFile(f.out), { code: 'ENOENT' });
});

test('cancellation terminates Vite, verifies source hashes and publishes nothing', async t => {
  const f = await fixture(t, { delay: true });
  const controller = new AbortController();
  const before = await snapshotTree(join(f.project, '..', '..'), { exclude: ['node_modules'] });
  const pending = buildViteProject({ project: f.project, out: f.out, signal: controller.signal });
  setTimeout(() => controller.abort(), 500);
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'CANCELLED');
    assert.equal(error.sourcePreserved, true);
    assert.deepEqual(error.source.before, before);
    assert.equal(error.source.preservation.preserved, true);
    return true;
  });
  await assert.rejects(readFile(f.out), { code: 'ENOENT' });
});
