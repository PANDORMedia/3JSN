import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import test from 'node:test';
import { buildProject } from './build.mjs';
import { hostTarget } from './contract.mjs';
import { snapshotTree } from '../../scripts/compatibility/snapshot.mjs';

const PROFILE = 'compiled-dom-window-v1';
const FORMAT = '3jsn-static-ui-experiment';
const domHost = { skip: process.platform !== 'darwin' ? 'Compiled DOM packaging currently requires macOS' : false };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const attr = (node, name) => node.attributes.find(attribute => attribute.name === name)?.value;

async function fixture(t, { webFonts = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), '3jsn-compiled-build-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'source'), runtime = join(base, 'runtime'), font = join(base, 'fallback.woff2');
  await mkdir(join(project, 'ui'), { recursive: true });
  await mkdir(join(project, 'code'));
  const config = { schemaVersion: 1, profile: PROFILE, name: 'compiled-example', entry: 'ui/index.html' };
  await writeFile(join(project, '3jsn.json'), JSON.stringify(config));
  const html = '<!doctype html>\r\n<html><head><meta charset="utf-8">'
    + (webFonts ? '<link rel="stylesheet" href="https://fonts.test/style.css">' : '<style>body{color:#123}</style>')
    + '</head><body><!-- Original 😀 source --><p id="label">Original &amp; unchanged</p><canvas id="scene"></canvas>'
    + '<script type="module" src="../code/main.ts"></script></body></html>';
  await writeFile(join(project, config.entry), html);
  await writeFile(join(project, 'code/main.ts'), 'export const original: number = 42;');
  await writeFile(runtime, 'explicit synthetic compiled runtime');
  // Header-only bytes exercise package/resource identities, not native decoding.
  const fontBytes = Buffer.alloc(49); fontBytes.write('wOF2'); fontBytes.writeUInt32BE(49, 8);
  fontBytes.writeUInt16BE(1, 12); fontBytes.writeUInt32BE(128, 16); fontBytes.writeUInt32BE(1, 20);
  await writeFile(font, fontBytes);
  const options = { project, runtime, font, out: join(base, 'output'), experimental: true, ...(webFonts ? { bundleWebFonts: true } : {}) };
  const description = { schemaVersion: 1, playerVersion: '0.0.0', packageVersions: [1], profiles: [PROFILE],
    capabilities: ['dom-package-fonts-v1'], target: hostTarget(), backend: 'metal', v8: 'test',
    compiledUi: { format: FORMAT, versions: [1], htmlParser: 'preserved' } };
  const requests = [];
  const fetchImpl = async url => {
    requests.push(url);
    return new Response(url.endsWith('.css')
      ? '/* Fixture font notice */ @font-face{font-family:Original;src:url(font) format("woff2");font-weight:100 900;unicode-range:U+0-FF;font-display:swap}'
      : fontBytes, { headers: { 'content-type': url.endsWith('.css') ? 'text/css' : 'font/woff2' } });
  };
  return { base, project, runtime, font, config, html, options, description, requests,
    build: (overrides = {}, dependencies = {}) => buildProject({ ...options, ...overrides },
      { describeRuntime: async () => description, fetchImpl, ...dependencies }) };
}

async function failed(f, code, run) {
  const before = await snapshotTree(f.project);
  await assert.rejects(run, { code });
  assert.deepEqual(await snapshotTree(f.project), before);
  await assert.rejects(access(f.options.out), { code: 'ENOENT' });
  assert.equal((await readdir(f.base)).some(name => name.startsWith('.3jsn-build-')), false);
}

test('compiled package replaces generated HTML payload with bounded IR and preserves original source provenance', domHost, async t => {
  const f = await fixture(t), before = await snapshotTree(f.project);
  const result = await f.build();
  const manifest = await json(result.manifest), metadata = await json(result.metadata);
  assert.equal(result.profile, PROFILE);
  assert.equal(manifest.profile, PROFILE);
  assert.equal(manifest.entry, 'app/main.mjs');
  assert.equal(manifest.font, 'app/font.woff2');
  assert.equal(Object.hasOwn(manifest, 'html'), false);
  assert.deepEqual(manifest.compiledUi, { path: 'app/ui.json', format: FORMAT, version: 1, htmlParser: 'preserved' });
  assert.deepEqual(manifest.files.map(file => file.path), ['app/font.woff2', 'app/main.mjs', 'app/main.mjs.map', 'app/ui.json']);
  await assert.rejects(access(join(result.output, 'app/index.html')), { code: 'ENOENT' });
  for (const file of manifest.files) {
    const bytes = await readFile(join(result.output, file.path));
    assert.equal(file.bytes, bytes.length); assert.equal(file.sha256, hash(bytes));
  }
  const irBytes = await readFile(join(result.output, manifest.compiledUi.path));
  const ir = JSON.parse(irBytes);
  const generated = f.html.replace('src="../code/main.ts"', 'src="./main.mjs"');
  assert.equal(ir.format, FORMAT); assert.equal(ir.version, 1);
  assert.deepEqual(ir.source, { name: 'generated/app/index.html', sha256: hash(generated), byteLength: Buffer.byteLength(generated) });
  assert.equal(attr(ir.nodes.find(node => node.kind === 'element' && node.name === 'script'), 'src'), './main.mjs');
  const label = ir.nodes.find(node => node.kind === 'element' && attr(node, 'id') === 'label');
  assert.equal(ir.nodes[label.children[0]].value, 'Original & unchanged');
  assert(ir.nodes.some(node => node.kind === 'comment' && node.value.includes('Original 😀 source')));
  assert.deepEqual(metadata.html.source, { path: f.config.entry, bytes: Buffer.byteLength(f.html), sha256: hash(f.html) });
  assert.equal(metadata.html.generated.sha256, hash(generated));
  assert.equal(metadata.html.generated.bytes, Buffer.byteLength(generated));
  assert.equal(Object.hasOwn(metadata.html.generated, 'path'), false);
  assert.deepEqual(metadata.compiledUi, { source: ir.source,
    generated: { path: 'app/ui.json', bytes: irBytes.length, sha256: hash(irBytes) }, format: FORMAT, version: 1, htmlParser: 'preserved' });
  assert.equal(metadata.compatibility.certified, false);
  assert.equal(metadata.compatibility.unresolvedDynamicBehavior, true);
  assert.deepEqual(await snapshotTree(f.project), before);
});

test('explicit restricted mode is retained and preserved mode is never inferred from a different runtime', domHost, async t => {
  const f = await fixture(t);
  const restricted = { ...f.description, compiledUi: { ...f.description.compiledUi, htmlParser: 'restricted' } };
  await failed(f, 'INCOMPATIBLE_RUNTIME', () => f.build({}, { describeRuntime: async () => restricted }));
  await failed(f, 'INCOMPATIBLE_RUNTIME', () => f.build({ htmlParser: 'restricted' }));
  const result = await f.build({ htmlParser: 'restricted' }, { describeRuntime: async () => restricted });
  const manifest = await json(result.manifest), metadata = await json(result.metadata);
  assert.equal(manifest.compiledUi.htmlParser, 'restricted');
  assert.equal(metadata.compiledUi.htmlParser, 'restricted');
  assert.equal(metadata.compatibility.unresolvedDynamicBehavior, true);
  assert.equal(metadata.compatibility.certified, false);
});

test('compiled runtime format/version/mode handshake fails before font requests or state creation', domHost, async t => {
  const f = await fixture(t, { webFonts: true });
  for (const compiledUi of [undefined, null, {}, { ...f.description.compiledUi, format: 'unknown' },
    { ...f.description.compiledUi, versions: [2] }, { ...f.description.compiledUi, versions: [] },
    { ...f.description.compiledUi, htmlParser: 'restricted' }, { ...f.description.compiledUi, htmlParser: 'automatic' }]) {
    await failed(f, 'INCOMPATIBLE_RUNTIME', () => f.build({}, { describeRuntime: async () => ({ ...f.description, compiledUi }),
      fetchImpl: () => assert.fail('runtime handshake must precede font downloads') }));
  }
  assert.equal((await readdir(f.base)).includes('.3jsn-web-fonts'), false);
  assert.deepEqual(f.requests, []);
});

for (const htmlParser of ['preserved', 'restricted']) {
  test(`compiled ${htmlParser} font opt-in localizes URLs before compilation and repeats offline byte-identically`, domHost, async t => {
    const f = await fixture(t, { webFonts: true }), before = await snapshotTree(f.project);
    f.description.compiledUi.htmlParser = htmlParser;
    const result = await f.build({ htmlParser });
    const manifest = await json(result.manifest), metadata = await json(result.metadata);
    assert.deepEqual(manifest.requires, ['dom-package-fonts-v1']);
    assert.equal(manifest.resources.length, 2);
    assert.equal(manifest.files.length, 6);
    assert.equal(Object.hasOwn(manifest, 'html'), false);
    const ir = await json(join(result.output, manifest.compiledUi.path));
    const href = attr(ir.nodes.find(node => node.kind === 'element' && node.name === 'link'), 'href');
    const stylesheet = manifest.resources.find(resource => resource.kind === 'stylesheet');
    assert.equal(posix.normalize(posix.join('app', href)), stylesheet.path);
    assert.match(href, /^\.\/styles\/[a-f0-9]{64}\.css$/);
    assert.equal(attr(ir.nodes.find(node => node.kind === 'element' && node.name === 'script'), 'src'), './main.mjs');
    const localizedHtml = f.html.replace('https://fonts.test/style.css', href).replace('../code/main.ts', './main.mjs');
    assert.equal(ir.source.sha256, hash(localizedHtml));
    assert.equal(metadata.html.generated.sha256, ir.source.sha256);
    assert.deepEqual(metadata.compiledUi.source, ir.source);
    assert.equal(metadata.webFonts.lock.entries.length, 2);
    assert.match(await readFile(join(result.output, stylesheet.path), 'utf8'), /Fixture font notice/);
    assert.equal(f.requests.length, 2);
    const repeat = await f.build({ htmlParser, out: join(f.base, 'offline'), offline: true }, { fetchImpl: () => assert.fail('offline compilation must not fetch') });
    assert.deepEqual(await json(repeat.manifest), manifest);
    for (const file of manifest.files) {
      const bytes = await readFile(join(result.output, file.path));
      assert.equal(file.sha256, hash(bytes)); assert.equal(file.bytes, bytes.length);
      assert.deepEqual(bytes, await readFile(join(repeat.output, file.path)));
    }
    assert.equal(result.webFontsState, repeat.webFontsState);
    assert.deepEqual(await snapshotTree(f.project), before);
  });
}

test('parser mode is explicit, compiled-profile-only, and never added as a config key', domHost, async t => {
  const f = await fixture(t);
  for (const htmlParser of [null, '', 'auto', true]) await failed(f, 'USAGE', () => f.build({ htmlParser }));
  await writeFile(join(f.project, '3jsn.json'), JSON.stringify({ ...f.config, htmlParser: 'restricted' }));
  await failed(f, 'INVALID_CONFIG', () => f.build());
  for (const profile of ['dom-window-v1', 'native-window-v1']) {
    await writeFile(join(f.project, '3jsn.json'), JSON.stringify({ ...f.config, profile,
      entry: profile === 'native-window-v1' ? 'code/main.ts' : f.config.entry }));
    await failed(f, 'UNEXPECTED_HTML_PARSER', () => f.build({ htmlParser: 'preserved',
      ...(profile === 'native-window-v1' ? { font: undefined } : {}) }));
  }
});

test('compiled packaging retains existing unsupported HTML and font admission gates', domHost, async t => {
  const f = await fixture(t);
  for (const html of [f.html.replace('<p id="label">', '<p onclick="alert(1)" id="label">'),
    f.html.replace('<canvas', '<template><span>inert</span></template><canvas'),
    f.html.replace('../code/main.ts', 'https://example.invalid/app.mjs')]) {
    await writeFile(join(f.project, f.config.entry), html);
    await failed(f, 'UNSUPPORTED_HTML', () => f.build({}, { describeRuntime: () => assert.fail('HTML admission must precede runtime use') }));
  }
  const web = await fixture(t, { webFonts: true });
  const options = { ...web.options }; delete options.bundleWebFonts;
  await failed(web, 'UNSUPPORTED_HTML', () => buildProject(options, { describeRuntime: () => assert.fail('font opt-in must be explicit') }));
  await failed(web, 'INCOMPATIBLE_RUNTIME', () => web.build({}, { describeRuntime: async () => ({ ...web.description, capabilities: [] }),
    fetchImpl: () => assert.fail('missing font capability must precede downloads') }));
});

test('a compiler limit after bundling removes staging and records source preservation', domHost, async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, f.config.entry), f.html.replace('Original &amp; unchanged', 'x'.repeat(65_537)));
  const before = await snapshotTree(f.project);
  let failure;
  await assert.rejects(f.build(), error => {
    failure = error;
    return error.code.startsWith('COMPILED_UI_') && /string/i.test(error.message);
  });
  assert.equal(failure.sourcePreserved, true);
  const receipt = await json(failure.receipt);
  assert.equal(receipt.source.preservation.preserved, true);
  assert.deepEqual(await snapshotTree(f.project), before);
  await assert.rejects(access(f.options.out), { code: 'ENOENT' });
  assert.equal((await readdir(f.base)).some(name => name.startsWith('.3jsn-build-')), false);
});
