import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildProject } from './build.mjs';
import { hostTarget } from './contract.mjs';
import { snapshotTree } from '../../scripts/compatibility/snapshot.mjs';

const domHost = { skip: process.platform !== 'darwin' ? 'DOM build currently requires macOS' : false };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), '3jsn-font-build-')); t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'source'), runtime = join(base, 'runtime'), font = join(base, 'fallback.woff2'); await mkdir(project);
  await writeFile(join(project, '3jsn.json'), JSON.stringify({ schemaVersion: 1, profile: 'dom-window-v1', name: 'font-example', entry: 'index.html' }));
  await writeFile(join(project, 'index.html'), '<!doctype html><link rel="stylesheet" href="https://fonts.test/style.css"><canvas id="scene"></canvas><script type="module" src="app.mjs"></script>');
  await writeFile(join(project, 'app.mjs'), 'export const original = 42;'); await writeFile(runtime, 'explicit runtime');
  const fontBytes = Buffer.alloc(49); fontBytes.write('wOF2'); fontBytes.writeUInt32BE(49, 8); fontBytes.writeUInt16BE(1, 12); fontBytes.writeUInt32BE(128, 16); fontBytes.writeUInt32BE(1, 20);
  await writeFile(font, fontBytes);
  const options = { project, runtime, font, out: join(base, 'output'), experimental: true, bundleWebFonts: true };
  const description = { schemaVersion: 1, playerVersion: '0.0.0', packageVersions: [1], profiles: ['dom-window-v1'], capabilities: ['dom-package-fonts-v1'], target: hostTarget(), backend: 'metal', v8: 'test' };
  const requests = [];
  const fetchImpl = async url => { requests.push(url); return new Response(url.endsWith('.css')
    ? '/* Original fixture notice */ @font-face{font-family:Original;src:url(font) format("woff2");font-weight:100 900;unicode-range:U+0-FF;font-display:swap}' : fontBytes,
  { headers: { 'content-type': url.endsWith('.css') ? 'text/css' : 'font/woff2' } }); };
  return { base, project, options, description, requests, build: (overrides = {}, deps = {}) => buildProject({ ...options, ...overrides }, { describeRuntime: async () => description, fetchImpl, ...deps }) };
}

test('opt-in build emits required capability/resources, notices, pinned lock and offline-identical payloads', domHost, async t => {
  const f = await fixture(t), before = await snapshotTree(f.project);
  const result = await f.build();
  assert.deepEqual(await snapshotTree(f.project), before);
  const manifest = await json(result.manifest), metadata = await json(result.metadata);
  assert.deepEqual(manifest.requires, ['dom-package-fonts-v1']); assert.equal(manifest.resources.length, 2);
  assert.equal(manifest.files.length, 6);
  for (const file of manifest.files) assert.equal(hash(await readFile(join(result.output, file.path))), file.sha256);
  const css = manifest.resources.find(resource => resource.kind === 'stylesheet');
  assert.match(await readFile(join(result.output, css.path), 'utf8'), /Original fixture notice/);
  assert.equal(metadata.webFonts.lock.entries.length, 2);
  assert.ok(metadata.compatibility.limitations.some(line => line.includes('redistribution rights')));
  assert.equal(f.requests.length, 2);
  const repeat = await f.build({ out: join(f.base, 'offline'), offline: true }, { fetchImpl: () => assert.fail('no network in offline build') });
  assert.deepEqual(await json(repeat.manifest), manifest);
  for (const file of manifest.files) assert.deepEqual(await readFile(join(result.output, file.path)), await readFile(join(repeat.output, file.path)));
  assert.equal(result.webFontsState, repeat.webFontsState);
});

test('no opt-in and old-player handshake fail before any download or state creation', domHost, async t => {
  const f = await fixture(t);
  const options = { ...f.options }; delete options.bundleWebFonts;
  await assert.rejects(buildProject(options, { describeRuntime: () => assert.fail('HTML admission fails first'), fetchImpl: () => assert.fail('must not fetch') }), { code: 'UNSUPPORTED_HTML' });
  await assert.rejects(f.build({}, { describeRuntime: async () => ({ ...f.description, capabilities: [] }), fetchImpl: () => assert.fail('must not fetch') }), { code: 'INCOMPATIBLE_RUNTIME' });
  assert.equal((await readdir(f.base)).includes('.3jsn-web-fonts'), false);
});

test('web-font options are explicit and current native semantic gaps reject with source-preservation evidence', domHost, async t => {
  const f = await fixture(t);
  for (const overrides of [{ bundleWebFonts: null }, { webFontsState: null }, { offline: null }]) await assert.rejects(f.build(overrides), { code: 'USAGE' });
  const options = { ...f.options, offline: true }; delete options.bundleWebFonts;
  await assert.rejects(buildProject(options), { code: 'UNEXPECTED_WEB_FONTS' });
  for (const css of [
    '@font-face{font-family:X;src:local("X"),url(font)}',
    '@font-face{font-family:X;src:url(first),url(second)}',
    '@media screen{@font-face{font-family:X;src:url(font)}}',
    '@font-face{font-family:X;src:url(font);font-variation-settings:"wght" 700}',
  ]) {
    let error;
    await assert.rejects(f.build({ webFontsState: join(f.base, `state-${hash(css).slice(0, 8)}`) }, { fetchImpl: async url => {
      assert.ok(url.endsWith('.css'), 'unsupported font requirements must reject before font requests'); return new Response(css, { headers: { 'content-type': 'text/css' } });
    } }), value => { error = value; return value.code === 'FONT_NATIVE_UNSUPPORTED'; });
    assert.equal(error.sourcePreserved, true);
    assert.equal((await json(error.receipt)).source.preservation.preserved, true);
  }
});
