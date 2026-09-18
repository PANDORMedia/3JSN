import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildProject } from './build.mjs';
import { DOM_PROFILE, hostTarget } from './contract.mjs';
import { snapshotTree } from '../../scripts/compatibility/snapshot.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const domHost = { skip: process.platform !== 'darwin' ? 'DOM profile is macOS-only' : false };
const description = () => ({ schemaVersion: 1, playerVersion: '0.0.0', packageVersions: [1], profiles: [DOM_PROFILE], target: hostTarget(), backend: 'metal', v8: 'test' });
const html = '<!doctype html>\r\n<html><head><meta charset="utf-8"><style>body{color:#123}</style></head><body><!-- 😀 original --><canvas id="scene"></canvas><script type="module" src="../code/main.ts"></script></body></html>';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), '3jsn-html-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project'), runtime = join(base, 'runtime'), font = join(base, 'original.woff2'), out = join(base, 'packed');
  await mkdir(join(project, 'ui'), { recursive: true });
  await mkdir(join(project, 'code'));
  const config = { schemaVersion: 1, profile: DOM_PROFILE, name: 'html-game', entry: 'ui/index.html' };
  await writeFile(join(project, '3jsn.json'), JSON.stringify(config));
  await writeFile(join(project, config.entry), html);
  await writeFile(join(project, 'code/main.ts'), 'import { answer } from "./answer.ts"; console.log(answer);');
  await writeFile(join(project, 'code/answer.ts'), 'export const answer:number=42;');
  await writeFile(runtime, 'supplied DOM player bytes');
  // Header-only fixture proves packaging identities, not native font decoding.
  const fontBytes = Buffer.alloc(48); fontBytes.write('wOF2'); fontBytes.writeUInt32BE(fontBytes.length, 8);
  await writeFile(font, fontBytes);
  const options = { project, runtime, font, out, experimental: true };
  return { base, project, runtime, font, out, config, options,
    build: (overrides = {}, describe = async () => description()) => buildProject({ ...options, ...overrides }, { describeRuntime: describe }) };
}

async function fails(f, code, run = () => f.build()) {
  let error;
  await assert.rejects(run, value => { error = value; return value.code === code; });
  assert.equal((await readdir(f.base)).some(name => name.startsWith('.3jsn-build-')), false);
  await assert.rejects(lstat(f.out), { code: 'ENOENT' });
  assert.equal(error.sourcePreserved, true);
  return error;
}

test('HTML package contains measured generated HTML, module/map and unchanged explicit font', domHost, async t => {
  const f = await fixture(t);
  const before = await snapshotTree(f.project, { exclude: ['node_modules'] });
  const result = await f.build();
  assert.equal(result.profile, DOM_PROFILE);
  assert.deepEqual(await snapshotTree(f.project, { exclude: ['node_modules'] }), before);
  const manifest = await json(result.manifest), metadata = await json(result.metadata);
  assert.equal(manifest.html, 'app/index.html'); assert.equal(manifest.font, 'app/font.woff2'); assert.equal(manifest.entry, 'app/main.mjs');
  assert.deepEqual(manifest.files.map(file => file.path), ['app/font.woff2', 'app/index.html', 'app/main.mjs', 'app/main.mjs.map']);
  for (const file of manifest.files) {
    const bytes = await readFile(join(f.out, file.path));
    assert.equal(file.sha256, hash(bytes)); assert.equal(file.bytes, bytes.length);
  }
  assert.equal(await readFile(join(f.out, manifest.html), 'utf8'), html.replace('src="../code/main.ts"', 'src="./main.mjs"'));
  assert.deepEqual(await readFile(join(f.out, manifest.font)), await readFile(f.font));
  assert.equal(metadata.html.source.sha256, hash(Buffer.from(html)));
  assert.equal(metadata.html.generated.sha256, hash(await readFile(join(f.out, manifest.html))));
  assert.equal(metadata.html.moduleEntry, 'code/main.ts');
  assert.equal(metadata.assets.font.preserved, true);
  assert.deepEqual(metadata.assets.font.before, metadata.assets.font.copied);
  assert.deepEqual(metadata.assets.font.before, metadata.assets.font.after);
  assert.equal(metadata.compatibility.certified, false);
  assert.ok(metadata.compatibility.limitations.some(line => line.startsWith('Interim interpreted-HTML')));
  assert.equal((await readdir(f.base)).some(name => name.startsWith('.3jsn-')), false);
});

test('DOM profile rejects missing/null fonts, invalid headers, directories and font symlinks', domHost, async t => {
  const f = await fixture(t);
  for (const font of [undefined, null, '']) await fails(f, 'FONT_REQUIRED', () => f.build({ font }));
  await writeFile(f.font, 'not WOFF2'); await fails(f, 'INVALID_FONT');
  await rm(f.font); await mkdir(f.font); await fails(f, 'INVALID_FILE'); await rm(f.font, { recursive: true });
  await symlink(f.runtime, f.font); await fails(f, 'INVALID_FILE');
});

test('wrong runtime, invalid HTML, external module and linked entry fail without publication or source edits', domHost, async t => {
  const f = await fixture(t);
  await fails(f, 'INCOMPATIBLE_RUNTIME', () => f.build({}, async () => ({ ...description(), profiles: ['native-window-v1'] })));
  await writeFile(join(f.project, f.config.entry), html.replace('../code/main.ts', '../../outside.mjs'));
  await fails(f, 'UNSUPPORTED_HTML');
  await writeFile(join(f.project, f.config.entry), html);
  await rm(join(f.project, 'code/main.ts'));
  await symlink('answer.ts', join(f.project, 'code/main.ts'));
  await fails(f, 'INVALID_ENTRY');
});

test('font mutation is independently recorded even when project source is preserved', domHost, async t => {
  const f = await fixture(t);
  const error = await fails(f, 'FONT_CHANGED', () => f.build({}, async () => {
    const bytes = await readFile(f.font); bytes[30] = 1; await writeFile(f.font, bytes); return description();
  }));
  const receipt = await json(error.receipt);
  assert.equal(receipt.assets.font.preserved, false);
  assert.notEqual(receipt.assets.font.before.sha256, receipt.assets.font.after.sha256);
  assert.equal(receipt.source.preservation.preserved, true);
});

test('DOM cancellation records both source and font preservation and removes staging', domHost, async t => {
  const f = await fixture(t), controller = new AbortController();
  const error = await fails(f, 'CANCELLED', () => f.build({ signal: controller.signal }, async () => { controller.abort(); return description(); }));
  const receipt = await json(error.receipt);
  assert.equal(receipt.assets.font.preserved, true);
  assert.equal(receipt.assets.font.copied, null);
});

test('a missing font after cancellation is recorded as unknown preservation', domHost, async t => {
  const f = await fixture(t), controller = new AbortController();
  const error = await fails(f, 'CANCELLED', () => f.build({ signal: controller.signal }, async () => {
    await rm(f.font); controller.abort(); return description();
  }));
  const receipt = await json(error.receipt);
  assert.equal(receipt.assets.font.preserved, null);
  assert.equal(receipt.assets.font.after, null);
  assert.equal(receipt.assets.font.verificationError.code, 'ENOENT');
});

test('native profile refuses every explicit font option including null', async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, '3jsn.json'), JSON.stringify({ ...f.config, profile: 'native-window-v1', entry: 'code/main.ts' }));
  for (const font of [null, undefined, f.font]) await fails(f, 'UNEXPECTED_FONT', () => f.build({ font }, () => assert.fail('must not describe')));
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.mjs'), 'build', f.project,
    '--runtime', f.runtime, '--out', f.out, '--experimental', '--font', f.font], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'UNEXPECTED_FONT');
});

test('DOM host restriction rejects before runtime inspection and preserves source', { skip: process.platform === 'darwin' }, async t => {
  const f = await fixture(t);
  await fails(f, 'UNSUPPORTED_TARGET', () => f.build({}, () => assert.fail('must not describe')));
});
