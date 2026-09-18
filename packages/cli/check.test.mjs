import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { checkProject } from './check.mjs';
import { analyzeProjectFiles } from './check-discovery.mjs';
import { snapshotTree } from '../../scripts/compatibility/snapshot.mjs';

async function fixture(t) {
  const project = await mkdtemp(join(tmpdir(), '3jsn-check-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'game',
    scripts: { build: 'node malicious-command-with-SECRET.mjs' },
    dependencies: { three: '^0.186.0', vite: '^7.0.0' } }));
  await writeFile(join(project, 'index.html'), '<!doctype html><title>Game</title><canvas></canvas><script type="module" src="./main.ts"></script>');
  await writeFile(join(project, 'main.ts'), 'import { WebGLRenderer as Renderer } from "three"; new Renderer(); fetch("https://user:SECRET@example.test/data?token=SECRET");');
  return { project, options: { project, targets: 'macos-arm64,windows-x64' } };
}

test('check inventories an unconfigured project, preserves sources and refuses unverified compatibility', async t => {
  const f = await fixture(t);
  const before = await snapshotTree(f.project, { exclude: ['node_modules'] });
  const report = await checkProject(f.options);
  assert.equal(report.operation, 'check');
  assert.equal(report.exitCode, 1);
  assert.equal(report.preservation.preserved, true);
  assert.deepEqual(await snapshotTree(f.project, { exclude: ['node_modules'] }), before);
  assert.equal(report.project.entryPages[0].path, 'index.html');
  assert.equal(report.project.packages[0].three, '^0.186.0');
  assert(report.project.requirements.some(item => item.feature === 'graphics.webgl2'));
  assert(report.project.requirements.some(item => item.feature === 'services.fetch'));
  assert(report.diagnostics.some(item => item.code === 'DYNAMIC_BEHAVIOR_UNRESOLVED'));
  assert.equal(report.diagnostics.filter(item => item.code === 'TARGET_UNVERIFIED').length, 2);
  assert.equal(JSON.stringify(report).includes('SECRET'), false);
  assert.deepEqual(report.artifacts, []);
});

test('inline JavaScript has original locations and its source never enters reports', async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'index.html'), '<!doctype html>\n<script>\nfetch("https://example.test/?SECRET");\n</script>');
  const report = await checkProject(f.options);
  assert(report.project.requirements.some(item => item.feature === 'services.fetch'
    && item.location.path === 'index.html' && item.location.line === 3 && item.location.column === 1));
  assert(report.project.entryPages.every(page => page.scripts.every(script => !Object.hasOwn(script, 'source'))));
  assert.equal(JSON.stringify(report).includes('SECRET'), false);
});

test('concurrent source mutation takes precedence over analysis failure and cancellation', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const report = await checkProject({ ...f.options, signal: controller.signal }, {
    discover: async files => {
      await writeFile(join(f.project, 'main.ts'), 'changed');
      controller.abort();
      return analyzeProjectFiles(files);
    },
  });
  assert.equal(report.exitCode, 4);
  assert.equal(report.preservation.preserved, false);
  assert(report.preservation.changes.some(item => item.path === 'main.ts'));
});

test('cancellation verifies source and unreadable final state is never called preserved', async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  const cancelled = await checkProject({ ...f.options, signal: controller.signal });
  assert.equal(cancelled.exitCode, 130);
  assert.equal(cancelled.preservation.preserved, true);
  let calls = 0;
  const report = await checkProject(f.options, { snapshot: async (...args) => {
    if (++calls === 2) throw new Error('SECRET');
    return snapshotTree(...args);
  } });
  assert.equal(report.exitCode, 3);
  assert.equal(report.preservation.preserved, null);
  assert.equal(JSON.stringify(report).includes('SECRET'), false);
});

test('invalid target selection fails as configuration; malformed JS retains preservation', async t => {
  const f = await fixture(t);
  for (const targets of ['unknown', 'macos-arm64,macos-arm64', '', 42]) {
    const report = await checkProject({ ...f.options, targets });
    assert.equal(report.exitCode, 2);
  }
  await writeFile(join(f.project, 'main.ts'), 'const bad = ;');
  const report = await checkProject(f.options);
  assert.equal(report.exitCode, 1);
  assert.equal(report.preservation.preserved, true);
  assert(report.diagnostics.some(item => item.location?.path === 'main.ts' && item.feature === 'analysis'));
});

test('cancellation during final verification retains cancellation status', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let calls = 0;
  const report = await checkProject({ ...f.options, signal: controller.signal }, { snapshot: async (...args) => {
    const result = await snapshotTree(...args);
    if (++calls === 2) controller.abort();
    return result;
  } });
  assert.equal(report.exitCode, 130);
  assert.equal(report.preservation.preserved, true);
  assert(report.diagnostics.some(item => item.code === 'CANCELLED'));
});

test('a detected mutation inside final snapshot has source-change precedence', async t => {
  const f = await fixture(t);
  let calls = 0;
  const report = await checkProject(f.options, { snapshot: async (...args) => {
    if (++calls === 2) throw Object.assign(new Error(), { code: 'INPUT_CHANGED' });
    return snapshotTree(...args);
  } });
  assert.equal(report.exitCode, 4);
  assert.equal(report.preservation.preserved, null);
  assert(report.diagnostics.some(item => item.code === 'INPUT_CHANGED'));
});

test('analysis limits and omitted dependency source are explicit', async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'large.js'), ' '.repeat(2 * 1024 * 1024 + 1));
  await mkdir(join(f.project, 'node_modules'));
  await writeFile(join(f.project, 'node_modules', 'ignored.js'), 'throw new Error("SECRET")');
  const report = await checkProject(f.options);
  assert.deepEqual(report.analysisCoverage.skippedFiles, ['large.js']);
  assert(report.diagnostics.some(item => item.code === 'ANALYSIS_INCOMPLETE'));
  assert.equal(report.analysisCoverage.sourceFiles.some(file => file.path.includes('node_modules')), false);
  assert.equal(report.exitCode, 1);
});

test('undecodable sources consume the analysis budget', async t => {
  const f = await fixture(t);
  const invalid = Buffer.alloc(2 * 1024 * 1024, 255);
  for (let i = 0; i < 17; i++) await writeFile(join(f.project, `00-invalid-${String(i).padStart(2, '0')}.js`), invalid);
  const report = await checkProject(f.options);
  assert.equal(report.diagnostics.filter(item => item.code === 'INVALID_TEXT_ENCODING').length, 16);
  assert(report.analysisCoverage.skippedFiles.includes('00-invalid-16.js'));
  assert.equal(report.preservation.preserved, true);
});

test('CLI check emits its report and exit status; build options cannot accidentally invoke code', async t => {
  const f = await fixture(t);
  const cli = resolve('packages/cli/cli.mjs');
  const result = spawnSync(process.execPath, [cli, 'check', f.project, '--targets', 'linux-x64'], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).targets[0].id, 'linux-x64');
  assert.equal(result.stderr, '');
  const invalid = spawnSync(process.execPath, [cli, 'check', f.project, '--runtime', 'do-not-run'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'USAGE');
  assert((await readFile(join(f.project, 'package.json'), 'utf8')).includes('malicious-command'));
});
