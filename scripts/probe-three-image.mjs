import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { PNG } from 'pngjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/rust-three-image');
const inputs = ['examples/runtime/three-image-texture.mjs', 'fixtures/image-bitmap/quadrants.mjs', 'Cargo.lock', 'package-lock.json'];
const hash = async path => createHash('sha256').update(await readFile(resolve(root, path))).digest('hex');
function run(command, args, timeout = 120000) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    timeout, stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

await mkdir(output, { recursive: true });
const before = await Promise.all(inputs.map(async path => ({ path, sha256: await hash(path) })));
const bundle = resolve(output, 'three-image-texture.mjs');
await build({ absWorkingDir: root, entryPoints: [inputs[0]], outfile: bundle,
  bundle: true, format: 'esm', platform: 'browser', sourcemap: 'inline' });
run('cargo', ['build', '-p', 'threejs-native-player', '--locked'], 600000);
const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1']));
const binary = resolve(metadata.target_directory, 'debug', `threejs-native-player${process.platform === 'win32' ? '.exe' : ''}`);
const runtime = run(binary, ['--version']);
const result = JSON.parse(run(binary, [bundle]));
assert.equal(result.rustThreeImage, true);
assert.equal(result.sameJavaScriptDevice, true);
assert.equal(result.adapter.isFallbackAdapter, false);
assert.deepEqual(result.errors, []);
assert.equal(result.samples.length, 4);
assert.equal(result.pixels.length, result.width * result.height * 4);
await writeFile(resolve(output, 'texture.png'), PNG.sync.write({
  width: result.width, height: result.height, data: Buffer.from(result.pixels),
}));
delete result.pixels;
for (const input of before) assert.equal(await hash(input.path), input.sha256, `${input.path} changed`);
const versions = Object.fromEntries(metadata.packages
  .filter(pkg => ['deno_core', 'deno_image', 'deno_web', 'deno_webgpu', 'v8'].includes(pkg.name))
  .map(pkg => [pkg.name, pkg.version]));
const report = { recordedAt: new Date().toISOString(), kind: 'rust-three-image-bitmap-upload',
  runtime, versions, inputs: before, binary: { bytes: (await stat(binary)).size,
    sha256: createHash('sha256').update(await readFile(binary)).digest('hex') },
  bundle: { sha256: await hash('artifacts/rust-three-image/three-image-texture.mjs') }, result,
  limitations: ['Synthetic PNG loaded from a data fixture; this probe does not exercise packaged-resource fetch.',
    'Only ImageBitmap to rgba8unorm/sRGB straight-alpha copies are implemented.',
    'Decoding and image-byte staging use CPU memory; no native image decode or WebGPU external handle is claimed.',
    'No native window, WebGL, other image source types or platform certification.'] };
await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`PASS: Rust-hosted Three.js r${result.three} uploaded four PNG colors to the native GPU. Report: ${output}/report.json`);
