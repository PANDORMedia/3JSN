import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildProject } from './build.mjs';
import { validatePackagedStylesheet } from './html.mjs';
import { hostTarget } from './contract.mjs';
import { buildViteProject, normalizeViteHtml, validateViteDomGraph, validateViteFontJavaScriptReferences } from './vite-build.mjs';
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
  assert.deepEqual(report.documents.urlAttributes, ['src', 'href', 'poster']);
  assert.ok(report.documents.files.some(document => document.references.some(reference => reference.element === 'script' && reference.attribute === 'src')));
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

test('Vite DOM graph admits one static HTML and JavaScript entry with linked CSS', () => {
  const files = ['index.html', 'assets/main.js', 'assets/main.css', 'assets/main.js.map', '.vite/manifest.json'].map(path => ({ path }));
  const record = { key: 'index.html', file: 'assets/main.js', isEntry: true, isDynamicEntry: false,
    imports: [], dynamicImports: [], css: ['assets/main.css'], assets: [] };
  const artifacts = { graph: [record], files, manifestPath: '.vite/manifest.json' };
  const admitted = validateViteDomGraph(artifacts, 'index.html');
  assert.equal(admitted.htmlFile, 'index.html');
  assert.equal(admitted.entryScript, 'assets/main.js');
  assert.deepEqual([...admitted.jsFiles], ['assets/main.js']);
  assert.deepEqual([...admitted.cssFiles], ['assets/main.css']);
  for (const edge of ['dynamicImports', 'assets']) {
    assert.throws(() => validateViteDomGraph({ ...artifacts, graph: [{ ...record, [edge]: ['unsupported.js'] }] }, 'index.html'),
      { code: 'UNSUPPORTED_VITE_GRAPH' });
  }
  const fontRecord = { ...record, assets: ['assets/font.woff2'] };
  const emittedFont = { key: 'assets/font.woff2', file: 'assets/font.woff2', isEntry: false, isDynamicEntry: false,
    imports: [], dynamicImports: [], css: [], assets: [] };
  assert.deepEqual([...validateViteDomGraph({ ...artifacts, graph: [fontRecord, emittedFont], files: [...files, { path: 'assets/font.woff2' }] },
    'index.html', { webFonts: true }).fontFiles], ['assets/font.woff2']);
  const jsEntry = { ...record, imports: ['assets/chunk.js'] };
  const jsChunk = { key: 'assets/chunk.js', file: 'assets/chunk.mjs', isEntry: false, isDynamicEntry: false,
    imports: [], dynamicImports: [], css: [], assets: ['assets/font.woff2'] };
  assert.throws(() => validateViteDomGraph({ ...artifacts, graph: [jsEntry, jsChunk, emittedFont],
    files: [...files, { path: 'assets/font.woff2' }, { path: 'assets/chunk.mjs' }] }, 'index.html', { webFonts: true }),
  { code: 'UNSUPPORTED_VITE_GRAPH' });
  assert.throws(() => validateViteDomGraph({ ...artifacts, graph: [fontRecord], files: [...files, { path: 'assets/image.png' }] },
    'index.html', { webFonts: true }), { code: 'UNSUPPORTED_VITE_GRAPH' });
  assert.throws(() => validateViteDomGraph({ ...artifacts, files: files.filter(file => file.path !== 'assets/main.css') }, 'index.html'),
    { code: 'UNSUPPORTED_VITE_GRAPH' });
  assert.throws(() => validateViteDomGraph({ ...artifacts, files: [...files, { path: 'plugin-output.txt' }] }, 'index.html'),
    { code: 'UNSUPPORTED_VITE_GRAPH' });
});

test('webfont packaging rejects generated font URLs retained by JavaScript', () => {
  const fontFiles = new Set(['assets/fixture-Skh_p6iR.woff2']);
  assert.doesNotThrow(() => validateViteFontJavaScriptReferences(fontFiles,
    new Map([['assets/main.js', 'console.log("game ready")']])));
  for (const javascriptPath of ['assets/main.js', 'assets/chunk.js']) {
    assert.throws(() => validateViteFontJavaScriptReferences(fontFiles,
      new Map([[javascriptPath, 'const font = "./assets/fixture-Skh_p6iR.woff2";']])),
    { code: 'UNSUPPORTED_VITE_GRAPH' });
  }
});

test('Vite HTML normalization removes only measured module preloads and transport attributes', () => {
  const html = Buffer.from('<!doctype html><html><head><link rel="stylesheet" crossorigin href="../assets/main.css">'
    + '<link rel="modulepreload" href="../assets/chunk.js" crossorigin></head>'
    + '<body><script type="module" crossorigin src="../assets/main.js"></script></body></html>');
  const normalized = normalizeViteHtml(html, { htmlPath: 'pages/index.html',
    allowedScripts: new Set(['assets/main.js']), allowedModulePreloads: new Set(['assets/chunk.js']),
    allowedStylesheets: new Set(['assets/main.css']) }).toString();
  assert.doesNotMatch(normalized, /modulepreload|crossorigin/);
  assert.match(normalized, /href="\.\/vite\/assets\/main\.css"/);
  assert.match(normalized, /src="\.\.\/assets\/main\.js"/);
  assert.throws(() => normalizeViteHtml(html, { htmlPath: 'pages/index.html',
    allowedScripts: new Set(['assets/main.js']), allowedModulePreloads: new Set() }), { code: 'INVALID_VITE_GRAPH' });
  assert.throws(() => normalizeViteHtml(Buffer.from('<!doctype html><link rel="preload" href="./style.css">'), {
    htmlPath: 'index.html', allowedScripts: new Set(), allowedModulePreloads: new Set() }), { code: 'UNSUPPORTED_VITE_HTML' });
  assert.throws(() => normalizeViteHtml(Buffer.from('<!doctype html><link rel="stylesheet" href="./style.css">'), {
    htmlPath: 'index.html', allowedScripts: new Set(), allowedModulePreloads: new Set(), allowedStylesheets: new Set(['other.css']) }),
  { code: 'INVALID_VITE_GRAPH' });
  const unrewritten = normalizeViteHtml(html, { htmlPath: 'pages/index.html', allowedScripts: new Set(['assets/main.js']),
    allowedModulePreloads: new Set(['assets/chunk.js']), allowedStylesheets: new Set(['assets/main.css']), rewriteStylesheets: false }).toString();
  assert.match(unrewritten, /href="\.\.\/assets\/main\.css"/);
});

test('Vite stylesheet admission rejects URL and import edges outside the package graph', () => {
  validatePackagedStylesheet(Buffer.from('@media (min-width: 20px) { #scene { color: #123; } }'), 'assets/site.css');
  for (const css of ['@import "other.css";', '.logo { background: url("./logo.png"); }', '@font-face { font-family: local-face; src: local("Local Font"); }']) {
    assert.throws(() => validatePackagedStylesheet(Buffer.from(css), 'assets/site.css'), { code: 'UNSUPPORTED_VITE_CSS_RESOURCE' });
  }
});

test('3jsn build packages the Vite-generated DOM entry and hashes original workspace inputs', {
  skip: process.platform !== 'darwin' && 'dom-window-v1 packaging is currently a macOS-only runtime profile',
}, async t => {
  const f = await fixture(t);
  const target = hostTarget();
  const runtime = join(f.temporary, 'player');
  const font = join(f.temporary, 'fallback.woff2');
  await writeFile(runtime, 'fixture runtime');
  const fontBytes = Buffer.alloc(48); fontBytes.write('wOF2'); fontBytes.writeUInt32BE(48, 8);
  await writeFile(font, fontBytes);
  await writeFile(join(f.project, '3jsn.json'), JSON.stringify({ schemaVersion: 1, profile: 'dom-window-v1', name: 'vite-fixture', entry: 'index.html' }));
  await writeFile(join(f.project, 'index.html'), '<!doctype html><html><head><style>#scene{display:block}</style></head><body>'
    + '<link rel="stylesheet" href="/src/main.css"><canvas id="scene" width="32" height="32"></canvas>'
    + '<script type="module" src="/src/main.js"></script></body></html>');
  await writeFile(join(f.project, 'vite.config.js'), 'export default { build: { modulePreload: { polyfill: false } } };');
  await writeFile(join(f.project, 'src/main.js'), "import * as THREE from 'three/webgpu'; console.log(THREE.REVISION);");
  await writeFile(join(f.project, 'src/main.css'), 'body { color: rgb(17, 34, 51); } #scene { display: block; }');
  await rm(join(f.project, 'public'), { recursive: true, force: true });
  const before = await snapshotTree(join(f.project, '..', '..'), { exclude: ['node_modules'] });
  const output = join(f.temporary, 'vite-native-package');
  const result = await buildProject({ project: f.project, runtime, out: output, font, frontend: 'vite', experimental: true }, {
    describeRuntime: async () => ({ schemaVersion: 1, playerVersion: 'fixture', packageVersions: [1], profiles: ['dom-window-v1'],
      capabilities: ['dom-package-stylesheets-v1'], target, backend: 'metal', v8: 'fixture' }),
  });
  assert.equal(result.sourcePreserved, true);
  assert.deepEqual(await snapshotTree(join(f.project, '..', '..'), { exclude: ['node_modules'] }), before);
  const manifest = await readJson(result.manifest);
  assert.equal(manifest.profile, 'dom-window-v1');
  assert.equal(manifest.entry, 'app/main.mjs');
  assert.deepEqual(manifest.files.map(file => file.path).sort(), ['app/font.woff2', 'app/index.html', 'app/main.mjs', 'app/main.mjs.map',
    ...manifest.resources.map(resource => resource.path)]);
  assert.deepEqual(manifest.requires, ['dom-package-stylesheets-v1']);
  assert.deepEqual(manifest.resources.map(resource => resource.kind), ['stylesheet']);
  assert.equal(manifest.resources[0].path.startsWith('app/vite/'), true);
  const packagedHtml = await readFile(join(output, manifest.html), 'utf8');
  assert.match(packagedHtml, /<canvas id="scene"/);
  assert.match(packagedHtml, /src="\.\/main\.mjs"/);
  assert.match(packagedHtml, /href="\.\/vite\/assets\/.*\.css"/);
  assert.doesNotMatch(packagedHtml, /modulepreload|crossorigin/);
  const bundle = await readFile(join(output, manifest.entry), 'utf8');
  assert.match(bundle, /186/);
  const metadata = await readJson(result.metadata);
  assert.equal(metadata.vite.htmlEntry, 'index.html');
  assert.equal(metadata.vite.staticModules.length, 1);
  assert.equal(metadata.vite.packagedStylesheets.length, 1);
  assert.ok(metadata.esbuild.inputs.some(input => input.path === 'project/packages/game/src/main.js'));
  assert.equal(metadata.source.preservation.preserved, true);
  assert.equal((await readFile(join(output, 'app/main.mjs.map'), 'utf8')).includes(f.temporary), false);
});

test('3jsn build localizes Vite webfonts only with the explicit font capability', {
  skip: process.platform !== 'darwin' && 'dom-window-v1 packaging is currently a macOS-only runtime profile',
}, async t => {
  const f = await fixture(t);
  const target = hostTarget();
  const runtime = join(f.temporary, 'player');
  const fallback = join(f.temporary, 'fallback.woff2');
  const sourceFont = Buffer.alloc(49); sourceFont.write('wOF2'); sourceFont.writeUInt32BE(49, 8);
  sourceFont.writeUInt16BE(1, 12); sourceFont.writeUInt32BE(128, 16); sourceFont.writeUInt32BE(1, 20);
  const fallbackBytes = Buffer.from(sourceFont);
  await writeFile(runtime, 'fixture runtime'); await writeFile(fallback, fallbackBytes);
  await writeFile(join(f.project, '3jsn.json'), JSON.stringify({ schemaVersion: 1, profile: 'dom-window-v1', name: 'vite-font-fixture', entry: 'index.html' }));
  await writeFile(join(f.project, 'index.html'), '<!doctype html><html><head></head><body><canvas id="scene"></canvas>'
    + '<link rel="stylesheet" href="/src/main.css"><script type="module" src="/src/main.js"></script></body></html>');
  await writeFile(join(f.project, 'vite.config.js'), 'export default { build: { modulePreload: { polyfill: false } } };');
  await writeFile(join(f.project, 'src/main.js'), "import * as THREE from 'three/webgpu'; console.log(THREE.REVISION);");
  await writeFile(join(f.project, 'src/main.css'), '@font-face { font-family: Fixture; src: url(./fixture.woff2?no-inline) format("woff2"); } body { font-family: Fixture; }');
  await writeFile(join(f.project, 'src/fixture.woff2'), sourceFont);
  await rm(join(f.project, 'public'), { recursive: true, force: true });
  const before = await snapshotTree(join(f.project, '..', '..'), { exclude: ['node_modules'] });
  const output = join(f.temporary, 'vite-font-package');
  const describe = capabilities => async () => ({ schemaVersion: 1, playerVersion: 'fixture', packageVersions: [1],
    profiles: ['dom-window-v1'], capabilities, target, backend: 'metal', v8: 'fixture' });
  const options = { project: f.project, runtime, out: output, font: fallback, frontend: 'vite', experimental: true, bundleWebFonts: true,
    webFontsState: join(f.temporary, 'font-state') };
  const result = await buildProject(options, { describeRuntime: describe(['dom-package-fonts-v1']) });
  assert.deepEqual(await snapshotTree(join(f.project, '..', '..'), { exclude: ['node_modules'] }), before);
  const manifest = await readJson(result.manifest);
  assert.deepEqual(manifest.requires, ['dom-package-fonts-v1']);
  assert.deepEqual(manifest.resources.map(resource => resource.kind), ['font', 'stylesheet']);
  for (const item of manifest.files) assert.equal(hash(await readFile(join(output, item.path))), item.sha256);
  const stylesheet = manifest.resources.find(resource => resource.kind === 'stylesheet');
  assert.match(await readFile(join(output, stylesheet.path), 'utf8'), /@font-face/);
  const packagedHtml = await readFile(join(output, manifest.html), 'utf8');
  assert.match(packagedHtml, /href="\.\/styles\/[a-f0-9]+\.css"/);
  const metadata = await readJson(result.metadata);
  assert.equal(metadata.vite.packagedStylesheets.length, 0);
  assert.equal(metadata.webFonts.sourceInputs.some(input => input.path.endsWith('.woff2')), true);
  await assert.rejects(buildProject({ ...options, out: join(f.temporary, 'missing-capability') }, {
    describeRuntime: describe([]), fetchImpl: () => assert.fail('local font path must not fetch'),
  }), { code: 'INCOMPATIBLE_RUNTIME' });
  await writeFile(join(f.project, 'src/main.js'), "import fontUrl from './fixture.woff2?no-inline'; console.log(fontUrl);");
  const beforeJavaScriptFont = await snapshotTree(join(f.project, '..', '..'), { exclude: ['node_modules'] });
  const mixedFontOutput = join(f.temporary, 'vite-font-javascript-package');
  await assert.rejects(buildProject({ ...options, out: mixedFontOutput }, {
    describeRuntime: describe(['dom-package-fonts-v1']),
  }), async error => {
    assert.equal(error.code, 'UNSUPPORTED_VITE_GRAPH');
    assert.equal(error.sourcePreserved, true);
    assert.equal((await readJson(error.receipt)).source.preservation.preserved, true);
    return true;
  });
  assert.deepEqual(await snapshotTree(join(f.project, '..', '..'), { exclude: ['node_modules'] }), beforeJavaScriptFont);
  await assert.rejects(readFile(mixedFontOutput), { code: 'ENOENT' });
});
