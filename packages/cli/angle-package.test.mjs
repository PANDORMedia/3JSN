import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ANGLE_CAPABILITY, ANGLE_DESCRIPTOR, copyAnglePackage, inspectAnglePackage, validateAngleOptions, validateAngleRuntime, verifyAnglePackage } from './angle-package.mjs';
import { buildProject } from './build.mjs';
import { hostTarget } from './contract.mjs';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), '3jsn-angle-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const angle = join(base, 'gl'), dylib = join(angle, 'deps/darwin/dylib');
  await mkdir(dylib, { recursive: true });
  await writeFile(join(angle, 'package.json'), JSON.stringify({ name: 'gl', version: '9.0.0-rc.10' }));
  await writeFile(join(angle, 'LICENSES'), 'Synthetic notice; no real binary licensing evidence.');
  for (const name of ['libEGL.dylib', 'libGLESv2.dylib']) await writeFile(join(dylib, name), `synthetic ${name}`);
  return { base, angle, dylib };
}
test('ANGLE fixed payload copies identities and rechecks package metadata', async t => {
  const f = await fixture(t), inspected = await inspectAnglePackage(f.angle);
  const output = join(f.base, 'stage');
  const files = await copyAnglePackage(inspected, output);
  assert.deepEqual(files.map(f => f.path), ['libEGL.dylib', 'libGLESv2.dylib', 'LICENSES'].map(n => `app/native/angle/${n}`));
  await verifyAnglePackage(inspected);
  assert(inspected.inputs.every(i => i.preserved));
  await writeFile(join(f.angle, 'package.json'), '{"name":"changed"}');
  await assert.rejects(verifyAnglePackage(inspected), { code: 'ANGLE_CHANGED' });
  assert.equal(inspected.inputs[0].preserved, false);
});
test('ANGLE rejects wrong versions, symlink components, empty and oversized payloads', async t => {
  const f = await fixture(t);
  await writeFile(join(f.angle, 'package.json'), '{"name":"gl","version":"9.0.0"}');
  await assert.rejects(inspectAnglePackage(f.angle), { code: 'INVALID_ANGLE_PACKAGE' });
  await writeFile(join(f.angle, 'package.json'), '{"name":"gl","version":"9.0.0-rc.10"}');
  const path = join(f.dylib, 'libEGL.dylib');
  await truncate(path, 0);
  await assert.rejects(inspectAnglePackage(f.angle), { code: 'INVALID_ANGLE_PACKAGE' });
  await truncate(path, 64 * 1024 * 1024 + 1);
  await assert.rejects(inspectAnglePackage(f.angle), { code: 'INVALID_ANGLE_PACKAGE' });
  await rm(path); await symlink('libGLESv2.dylib', path);
  await assert.rejects(inspectAnglePackage(f.angle), { code: 'INVALID_ANGLE_PACKAGE' });
  await rm(path); await writeFile(path, 'restored');
  await rm(join(f.angle, 'deps'), { recursive: true });
  await symlink(f.base, join(f.angle, 'deps'));
  await assert.rejects(inspectAnglePackage(f.angle), { code: 'INVALID_ANGLE_PACKAGE' });
});
test('ANGLE profile, target, runtime capability and cancellation gates are explicit', async t => {
  assert.throws(() => validateAngleOptions('gl', 'dom-window-v1', 'macos-arm64'), { code: 'UNEXPECTED_ANGLE_PACKAGE' });
  assert.throws(() => validateAngleOptions('gl', 'compiled-dom-window-v1', 'linux-x64'), { code: 'UNSUPPORTED_TARGET' });
  assert.throws(() => validateAngleRuntime({ capabilities: [] }), { code: 'INCOMPATIBLE_RUNTIME' });
  validateAngleRuntime({ capabilities: [ANGLE_CAPABILITY] });
  const f = await fixture(t), signal = AbortSignal.abort();
  await assert.rejects(inspectAnglePackage(f.angle, signal), { code: 'CANCELLED' });
  const inspected = await inspectAnglePackage(f.angle);
  await writeFile(join(f.dylib, 'libGLESv2.dylib'), 'modified input');
  await assert.rejects(copyAnglePackage(inspected, join(f.base, 'stage')), { code: 'ANGLE_CHANGED' });
});
test('build adds ANGLE manifest and provenance; missing capability never publishes', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t), project = join(f.base, 'project'), runtime = join(f.base, 'runtime'), font = join(f.base, 'font.woff2');
  await mkdir(project);
  await writeFile(join(project, '3jsn.json'), JSON.stringify({ schemaVersion: 1, profile: 'compiled-dom-window-v1', name: 'angle-demo', entry: 'index.html' }));
  await writeFile(join(project, 'index.html'), '<!doctype html><html><head></head><body><canvas id="scene"></canvas><script type="module" src="./main.mjs"></script></body></html>');
  await writeFile(join(project, 'main.mjs'), 'globalThis.fixture = true;');
  await writeFile(runtime, 'synthetic runtime');
  const bytes = Buffer.alloc(49); bytes.write('wOF2'); bytes.writeUInt32BE(49, 8); await writeFile(font, bytes);
  const options = { project, runtime, font, anglePackage: f.angle, out: join(f.base, 'output'), experimental: true };
  const description = { schemaVersion: 1, playerVersion: 'test', packageVersions: [1], profiles: ['compiled-dom-window-v1'], capabilities: [ANGLE_CAPABILITY], target: hostTarget(), backend: 'metal', v8: 'test', compiledUi: { format: '3jsn-static-ui-experiment', versions: [1], htmlParser: 'preserved' } };
  await assert.rejects(buildProject(options, { describeRuntime: async () => ({ ...description, capabilities: [] }) }), { code: 'INCOMPATIBLE_RUNTIME' });
  await assert.rejects(access(options.out), { code: 'ENOENT' });
  const result = await buildProject(options, { describeRuntime: async () => description });
  const manifest = await json(result.manifest), metadata = await json(result.metadata);
  assert.deepEqual(manifest.nativeWebgl, ANGLE_DESCRIPTOR);
  assert.deepEqual(manifest.requires, [ANGLE_CAPABILITY]);
  assert.equal(manifest.files.filter(f => f.path.startsWith('app/native/angle/')).length, 3);
  assert(metadata.nativeWebgl.inputs.every(i => i.preserved));
  const combined = await buildProject({ ...options, out: join(f.base, 'combined'), bundleWebFonts: true }, {
    describeRuntime: async () => ({ ...description, capabilities: [...description.capabilities, 'dom-package-fonts-v1'] }),
    fetchImpl: () => assert.fail('No webfonts were declared'),
  });
  assert.deepEqual((await json(combined.manifest)).requires, ['dom-package-fonts-v1', ANGLE_CAPABILITY]);
  const controller = new AbortController();
  let failure;
  await assert.rejects(buildProject({ ...options, out: join(f.base, 'cancelled'), signal: controller.signal }, {
    describeRuntime: async () => { controller.abort(); return description; },
  }), error => { failure = error; return error.code === 'CANCELLED'; });
  assert.equal((await json(failure.receipt)).source.preservation.preserved, true);
  await assert.rejects(access(join(f.base, 'cancelled')), { code: 'ENOENT' });
  assert.equal((await readdir(f.base)).some(n => n.startsWith('.3jsn-build-')), false);
});
