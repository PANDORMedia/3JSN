import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { localizeWebFonts } from './web-fonts.mjs';
import { openWebFontCache, WEB_FONT_LIMITS, WEB_FONT_USER_AGENT } from './web-font-cache.mjs';
import { validateWebFontRequirements, validateWebFontRuntime } from './web-font-policy.mjs';
import { snapshotTree } from '../../scripts/compatibility/snapshot.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const page = styles => Buffer.from(`<!doctype html><html><head>${styles}</head><body><canvas id="scene"></canvas><script type="module" src="./app.mjs"></script></body></html>`);
// These coherent headers test packaging; native decode/render uses separate real-font integration evidence.
function font(format = 'woff2') {
  const bytes = Buffer.alloc(format === 'woff2' ? 49 : format === 'woff' ? 64 : 28);
  if (format === 'woff2' || format === 'woff') {
    bytes.write(format === 'woff2' ? 'wOF2' : 'wOFF'); bytes.writeUInt32BE(bytes.length, 8); bytes.writeUInt16BE(1, 12); bytes.writeUInt32BE(128, 16);
    if (format === 'woff2') bytes.writeUInt32BE(1, 20);
  } else { if (format === 'otf') bytes.write('OTTO'); else bytes.writeUInt32BE(0x00010000); bytes.writeUInt16BE(1, 4); bytes.writeUInt32BE(28, 20); }
  return bytes;
}
const face = url => `@font-face{font-family:"Original Face";font-weight:400;src:url("${url}") format("woff2");font-display:swap}`;
async function fixture(t, styles = '<link rel="stylesheet" href="https://fonts.test/start.css">') {
  const base = await mkdtemp(join(tmpdir(), '3jsn-web-fonts-')); t.after(() => rm(base, { recursive: true, force: true }));
  const projectRoot = join(base, 'project'); await mkdir(projectRoot); await writeFile(join(projectRoot, 'index.html'), page(styles)); await writeFile(join(projectRoot, 'app.mjs'), 'export const original=true;');
  const options = { projectRoot, outputDir: join(base, 'output'), stateDir: join(base, 'state'), htmlEntry: 'index.html', htmlBytes: page(styles) };
  return { base, projectRoot, options, run: (changes = {}, fetchImpl) => localizeWebFonts({ ...options, ...changes }, { fetchImpl }) };
}
function network(routes) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options }); const route = routes[url];
    if (!route) throw new Error(`Unexpected request ${url}`);
    return new Response(route.body ?? null, { status: route.status ?? 200, headers: route.headers ?? { 'content-type': url.endsWith('.css') ? 'text/css' : 'font/woff2' } });
  };
  return { calls, fetchImpl };
}
const forbidNetwork = () => assert.fail('Offline build must not call fetch');

test('redirected nested CSS resolves from each final URL, preserves imports and content-hashes font assets', async t => {
  const f = await fixture(t), bytes = font();
  const net = network({
    'https://fonts.test/start.css': { status: 302, headers: { location: 'https://cdn.test/css/base.css' } },
    'https://cdn.test/css/base.css': { body: '@import "child.css" screen; body{color:#123}', headers: { 'content-type': 'text/css; charset=utf-8' } },
    'https://cdn.test/css/child.css': { status: 307, headers: { location: '../v2/fonts.css' } },
    'https://cdn.test/v2/fonts.css': { body: face('../payload?id=unchanged'), headers: { 'content-type': 'text/css' } },
    'https://cdn.test/payload?id=unchanged': { body: bytes, headers: { 'content-type': 'application/octet-stream' } },
  });
  const before = await snapshotTree(f.projectRoot);
  const result = await f.run({}, net.fetchImpl);
  assert.deepEqual(await snapshotTree(f.projectRoot), before);
  assert.equal(result.files.length, 3);
  const fontFile = result.files.find(file => file.kind === 'font');
  assert.equal(fontFile.path, `app/fonts/${hash(bytes)}.woff2`); assert.deepEqual(fontFile.payload, bytes); assert.equal(fontFile.bytes, bytes.length);
  const css = result.files.filter(file => file.kind === 'stylesheet').map(file => file.payload.toString());
  assert.ok(css.some(text => /@import url\("\.\/.*\.css"\) screen; body/.test(text)));
  assert.ok(css.some(text => text.includes(`../fonts/${hash(bytes)}.woff2`)));
  assert.match(result.bytes.toString(), /<link rel="stylesheet" href="\.\/styles\/[a-f0-9]{64}\.css">/);
  assert.equal(result.requirements[0].stylesheet, 'https://cdn.test/v2/fonts.css');
  assert.deepEqual(result.requirements[0].conditions, [{ name: 'import', prelude: 'screen' }]);
  assert.equal(result.lock.entries[0].requestHeaders['user-agent'], WEB_FONT_USER_AGENT);
  assert.match(WEB_FONT_USER_AGENT, /Chrome\/140\.0\.0\.0/);
  assert.ok(result.lock.entries.some(pin => pin.finalUrl === 'https://cdn.test/v2/fonts.css' && pin.redirects.length === 1));
  const repeated = await f.run({ offline: true }, forbidNetwork);
  assert.deepEqual(repeated.files, result.files); assert.deepEqual(repeated.bytes, result.bytes); assert.deepEqual(repeated.lock, result.lock);
});

test('inline and contained local imported CSS preserve rule order/descriptors and deduplicate identical font bytes', async t => {
  const f = await fixture(t, '<style>@import "a.css"; p{color:red}</style><style>p{color:blue}</style>');
  await writeFile(join(f.projectRoot, 'a.css'), '@font-face{font-family:Subset;src:url(a.bin);font-weight:100 900;unicode-range:U+0-FF}\n@font-face{font-family:Subset;src:url(b.bin);unicode-range:U+100-1FF}');
  await writeFile(join(f.projectRoot, 'a.bin'), font('ttf')); await writeFile(join(f.projectRoot, 'b.bin'), font('ttf'));
  const result = await f.run({ offline: true }, forbidNetwork);
  assert.equal(result.files.filter(file => file.kind === 'font').length, 1);
  assert.deepEqual(result.requirements.map(item => item.descriptors.find(desc => desc.name === 'unicode-range').value), ['U+0-FF', 'U+100-1FF']);
  assert.match(result.files.find(file => file.kind === 'stylesheet').payload.toString(), /font-weight:100 900;unicode-range:U\+0-FF/);
  assert.match(result.bytes.toString(), /p\{color:red\}<\/style><style>p\{color:blue\}/);
  assert.deepEqual(result.sourceInputs.map(input => input.path), ['a.bin', 'a.css', 'b.bin']);
  await writeFile(join(f.projectRoot, 'a.css'), face('a.bin').replace('format("woff2")', 'format("truetype")'));
  const changed = await f.run({ offline: true }, forbidNetwork);
  assert.equal(changed.requirements.length, 1, 'local source is always reread rather than pinned to stale cache bytes');
});

test('ordinary TTF, OTF, WOFF and WOFF2 are recognized independently of URL extension', async t => {
  for (const format of ['ttf', 'otf', 'woff', 'woff2']) {
    const f = await fixture(t, `<style>@font-face{font-family:X;src:url("https://fonts.test/font?id=${format}")}</style>`);
    const net = network({ [`https://fonts.test/font?id=${format}`]: { body: font(format) } });
    const result = await f.run({}, net.fetchImpl);
    assert.ok(result.files[0].path.endsWith(`.${format}`));
  }
});

test('generic localization preserves local(), multiple sources and conditions while native policy can reject them', async t => {
  const f = await fixture(t, '<style>@media (min-width:100px){@font-face{font-family:X;src:local("X"),url("https://fonts.test/a")}}</style>');
  const net = network({ 'https://fonts.test/a': { body: font() } });
  const result = await f.run({}, net.fetchImpl);
  assert.match(result.bytes.toString(), /src:local\("X"\),url/);
  assert.equal(result.requirements[0].sources[0].type, 'local');
  assert.equal(result.requirements[0].conditions[0].name, 'media');
  assert.throws(() => validateWebFontRequirements(result.requirements[0]), { code: 'FONT_NATIVE_UNSUPPORTED' });
  assert.throws(() => validateWebFontRuntime({ capabilities: [] }), { code: 'INCOMPATIBLE_RUNTIME' });
  validateWebFontRuntime({ capabilities: ['dom-package-fonts-v1'] });
});

test('escaped CSS identifiers/URLs cannot hide non-font resources or alter preserved selectors', async t => {
  const f = await fixture(t, '<style>@f\\6fnt-face{font-family:X;src:u\\72l("https://fonts.test/a")}</style>');
  const result = await f.run({}, network({ 'https://fonts.test/a': { body: font() } }).fetchImpl);
  assert.match(result.bytes.toString(), /@f\\6fnt-face/);
  for (const css of ['p{background:u\\72l("https://fonts.test/image")}', 'p{--x:url("x");background:var(--x)}', 'p{background:image-set("x" 1x)}']) {
    await assert.rejects(f.run({ htmlBytes: page(`<style>${css}</style>`) }, forbidNetwork), error => ['NON_FONT_RESOURCE', 'FONT_CSS_UNSUPPORTED'].includes(error.code));
  }
});

test('external CSS remains external even when strings contain HTML closing tags or character references', async t => {
  const f = await fixture(t);
  const css = 'p::before{content:"</style><script>bad</script>&amp;"}' + face('https://fonts.test/a');
  const result = await f.run({}, network({ 'https://fonts.test/start.css': { body: css }, 'https://fonts.test/a': { body: font() } }).fetchImpl);
  assert.equal(result.bytes.toString().includes('<script>bad'), false);
  assert.ok(result.files.some(file => file.kind === 'stylesheet' && file.payload.toString().includes('content:"</style>')));
});

test('missing and corrupt pinned bytes never silently refetch or replace pins', async t => {
  const f = await fixture(t, '<style>' + face('https://fonts.test/a') + '</style>');
  const result = await f.run({}, network({ 'https://fonts.test/a': { body: font() } }).fetchImpl);
  const blob = join(f.options.stateDir, 'blobs', result.lock.entries[0].response.sha256);
  await writeFile(blob, 'corrupted');
  await assert.rejects(f.run({}, forbidNetwork), { code: 'FONT_CACHE_CORRUPT' });
  await rm(blob);
  await assert.rejects(f.run({ offline: true }, forbidNetwork), { code: 'FONT_CACHE_MISSING' });
  await assert.rejects(f.run({ stateDir: join(f.base, 'empty'), offline: true }, forbidNetwork), { code: 'FONT_OFFLINE_MISS' });
});

test('leases prevent concurrent lock replacement and release after graph errors', async t => {
  const f = await fixture(t);
  const first = await openWebFontCache(f.options);
  await assert.rejects(openWebFontCache(f.options), { code: 'FONT_CACHE_BUSY' });
  await first.close();
  await assert.rejects(f.run({}, network({ 'https://fonts.test/start.css': { body: '@import "start.css";' } }).fetchImpl), { code: 'FONT_IMPORT_CYCLE' });
  assert.equal((await readdir(f.options.stateDir)).includes('.lease'), false);
  assert.equal((await readdir(f.options.stateDir)).includes('lock.json'), false);
});

test('local path traversal, symlinks and state aliases into source are rejected', async t => {
  const f = await fixture(t, '<style>@import "../outside.css";</style>');
  await writeFile(join(f.base, 'outside.css'), 'p{color:red}');
  await assert.rejects(f.run({}, forbidNetwork), { code: 'FONT_SOURCE_ESCAPE' });
  try { await symlink('../outside.css', join(f.projectRoot, 'linked.css'), 'file'); } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Symlink privileges unavailable.');
    throw error;
  }
  await assert.rejects(f.run({ htmlBytes: page('<style>@import "linked.css";</style>') }, forbidNetwork), { code: 'FONT_SOURCE_ESCAPE' });
  try { await symlink(f.projectRoot, join(f.base, 'alias'), 'junction'); } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Symlink privileges unavailable.');
    throw error;
  }
  await assert.rejects(f.run({ stateDir: join(f.base, 'alias/cache') }, forbidNetwork), { code: 'FONT_STATE_INVALID' });
  await assert.rejects(f.run({ stateDir: f.options.outputDir }, forbidNetwork), { code: 'FONT_STATE_INVALID' });
  const protectedState = join(f.base, 'workspace-font-state');
  await assert.rejects(f.run({ stateDir: protectedState, protectedRoots: [f.base] }, forbidNetwork), { code: 'FONT_STATE_INVALID' });
  await assert.rejects(readdir(protectedState), { code: 'ENOENT' });
});

test('cache ancestors cannot turn a project named blobs into a download directory', async t => {
  const f = await fixture(t);
  const projectRoot = join(f.base, 'parent', 'blobs'); await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, 'original.txt'), 'must remain untouched');
  const before = await snapshotTree(projectRoot);
  await assert.rejects(openWebFontCache({ ...f.options, projectRoot, outputDir: join(f.base, 'elsewhere'), stateDir: join(f.base, 'parent') }), { code: 'FONT_STATE_INVALID' });
  assert.deepEqual(await snapshotTree(projectRoot), before);
  assert.deepEqual(await readdir(join(f.base, 'parent')), ['blobs']);
});

test('URL expansion must remain within generated stylesheet and aggregate package byte limits', async t => {
  const source = '@font-face{font-family:X;src:url(a)}';
  for (const limits of [{ stylesheetBytes: 80 }, { totalBytes: 100 }]) {
    const f = await fixture(t);
    await assert.rejects(f.run({ limits: { ...WEB_FONT_LIMITS, ...limits } }, network({
      'https://fonts.test/start.css': { body: source }, 'https://fonts.test/a': { body: font() },
    }).fetchImpl), error => error.code === 'FONT_RESOURCE_LIMIT' && error.message.includes('Generated'));
  }
});

test('partial, nonfinite and enlarged limits are rejected before creating cache state', async t => {
  const f = await fixture(t);
  for (const limits of [{ fontBytes: 10 }, { ...WEB_FONT_LIMITS, totalBytes: NaN }, { ...WEB_FONT_LIMITS, redirects: 0 },
    { ...WEB_FONT_LIMITS, resources: WEB_FONT_LIMITS.resources + 1 }]) {
    await assert.rejects(f.run({ limits }, forbidNetwork), { code: 'FONT_LIMITS_INVALID' });
    await assert.rejects(readdir(f.options.stateDir), { code: 'ENOENT' });
  }
});

test('unreferenced corrupt cache collisions are rejected without replacing bytes or committing pins', async t => {
  const f = await fixture(t, '<style>' + face('https://fonts.test/a') + '</style>');
  const blobs = join(f.options.stateDir, 'blobs'); await mkdir(blobs, { recursive: true });
  const path = join(blobs, hash(font())), original = Buffer.alloc(font().length + 1, 42);
  await writeFile(path, original);
  await assert.rejects(f.run({}, network({ 'https://fonts.test/a': { body: font() } }).fetchImpl), { code: 'FONT_CACHE_CORRUPT' });
  assert.deepEqual(await readFile(path), original);
  assert.deepEqual(await readdir(f.options.stateDir), ['blobs']);
});

test('HTTP, font-format and imported stylesheet failures identify the resource and source declaration', async t => {
  for (const [fontResponse, code] of [[{ status: 404, body: 'missing' }, 'FONT_FETCH_FAILED'], [{ body: 'not a font' }, 'FONT_FORMAT_INVALID']]) {
    const f = await fixture(t);
    await assert.rejects(f.run({}, network({ 'https://fonts.test/start.css': { body: '\n' + face('lost?id=authored') }, 'https://fonts.test/lost?id=authored': fontResponse }).fetchImpl), error => {
      assert.equal(error.code, code); assert.ok(error.cause);
      assert.match(error.message, /font request https:\/\/fonts\.test\/lost\?id=authored/);
      assert.match(error.message, /src in https:\/\/fonts\.test\/start\.css:2:\d+/);
      return true;
    });
  }
  const f = await fixture(t);
  await assert.rejects(f.run({}, network({ 'https://fonts.test/start.css': { body: '\n@import "missing.css";' }, 'https://fonts.test/missing.css': { status: 404 } }).fetchImpl), error => {
    assert.equal(error.code, 'FONT_FETCH_FAILED'); assert.match(error.message, /stylesheet request https:\/\/fonts\.test\/missing\.css/);
    assert.match(error.message, /@import in https:\/\/fonts\.test\/start\.css:2:\d+/); return true;
  });
});

test('resource/body/redirect/depth limits and malformed responses fail without a committed lock', async t => {
  for (const [limits, routes, code] of [
    [{ fontBytes: 10 }, { 'https://fonts.test/start.css': { body: face('a') }, 'https://fonts.test/a': { body: font() } }, 'FONT_RESOURCE_LIMIT'],
    [{ resources: 1 }, { 'https://fonts.test/start.css': { body: face('a') }, 'https://fonts.test/a': { body: font() } }, 'FONT_RESOURCE_LIMIT'],
    [{ redirects: 1 }, { 'https://fonts.test/start.css': { status: 302, headers: { location: '/next.css' } }, 'https://fonts.test/next.css': { status: 307, headers: { location: '/last.css' } } }, 'FONT_RESOURCE_LIMIT'],
    [{ importDepth: 1 }, { 'https://fonts.test/start.css': { body: '@import "child.css";' } }, 'FONT_RESOURCE_LIMIT'],
    [{}, { 'https://fonts.test/start.css': { body: 'no', headers: { 'content-type': 'text/html' } } }, 'FONT_CSS_TYPE'],
    [{}, { 'https://fonts.test/start.css': { body: 'p{color:red}', headers: { 'content-type': 'text/css;charset=latin1' } } }, 'FONT_CSS_ENCODING'],
    [{}, { 'https://fonts.test/start.css': { status: 404, body: 'missing' } }, 'FONT_FETCH_FAILED'],
  ]) {
    const f = await fixture(t);
    await assert.rejects(f.run({ limits: { ...WEB_FONT_LIMITS, ...limits } }, network(routes).fetchImpl), { code });
    assert.equal((await readdir(f.options.stateDir)).includes('lock.json'), false);
    assert.equal((await readdir(f.options.stateDir)).includes('.lease'), false);
  }
});

test('invalid or late CSS resource declarations and mismatched font formats fail explicitly', async t => {
  for (const [css, expected] of [
    ['p{color:red}@import "late.css";', 'FONT_CSS_INVALID'],
    ['p{@import "nested.css";}', 'FONT_CSS_INVALID'],
    ['p{@font-face{font-family:X;src:url(font)}}', 'FONT_CSS_INVALID'],
    ['@font-face{font-family:X;src:url(font) url(other)}', 'FONT_CSS_INVALID'],
    ['@font-face{font-family:X;src:url(font) format("truetype")}', 'FONT_FORMAT_INVALID'],
  ]) {
    const f = await fixture(t);
    await assert.rejects(f.run({}, network({ 'https://fonts.test/start.css': { body: css }, 'https://fonts.test/font': { body: font() } }).fetchImpl), { code: expected });
  }
});

test('lock schema, fixed representation headers and cache symlinks are verified before reuse', async t => {
  const f = await fixture(t, '<style>' + face('https://fonts.test/a') + '</style>');
  const result = await f.run({}, network({ 'https://fonts.test/a': { body: font() } }).fetchImpl);
  const lockPath = join(f.options.stateDir, 'lock.json'), original = await readFile(lockPath);
  const altered = JSON.parse(original); altered.entries[0].requestHeaders['user-agent'] = 'machine-specific';
  await writeFile(lockPath, JSON.stringify(altered));
  await assert.rejects(f.run({ offline: true }, forbidNetwork), { code: 'FONT_LOCK_INVALID' });
  await writeFile(lockPath, '{broken');
  await assert.rejects(f.run({}, forbidNetwork), { code: 'FONT_LOCK_INVALID' });
  await writeFile(lockPath, original);
  const blob = join(f.options.stateDir, 'blobs', result.lock.entries[0].response.sha256), external = join(f.base, 'identical-font');
  await writeFile(external, font()); await rm(blob);
  try { await symlink(external, blob, 'file'); } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Symlink privileges unavailable.');
    throw error;
  }
  await assert.rejects(f.run({ offline: true }, forbidNetwork), { code: 'FONT_CACHE_INVALID' });
});

test('cancellation and timeouts release the lease without committing partial resources', async t => {
  for (const cancel of [false, true]) {
    const f = await fixture(t), controller = new AbortController();
    const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (cancel) controller.abort();
    });
    await assert.rejects(f.run({ signal: controller.signal, limits: { ...WEB_FONT_LIMITS, timeoutMs: 10 } }, fetchImpl), { code: cancel ? 'CANCELLED' : 'FONT_FETCH_TIMEOUT' });
    assert.equal((await readdir(f.options.stateDir)).includes('.lease'), false);
    assert.equal((await readdir(f.options.stateDir)).includes('lock.json'), false);
  }
});
