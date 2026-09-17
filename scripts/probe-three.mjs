import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { PNG } from 'pngjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/rust-three');
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
function run(command, args, timeout = 120000) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    timeout, stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

await mkdir(output, { recursive: true });
const inputs = ['examples/runtime/three-offscreen.mjs', 'examples/spinning-scene/scene.mjs', 'package-lock.json', 'Cargo.lock'];
const before = await Promise.all(inputs.map(async path => ({ path, sha256: await hash(resolve(root, path)) })));
const bundle = resolve(output, 'three-offscreen.mjs');
await build({ absWorkingDir: root, entryPoints: [inputs[0]], outfile: bundle,
  bundle: true, format: 'esm', platform: 'browser', sourcemap: 'inline' });
const compiler = run('rustc', ['-vV']);
const target = compiler.match(/^host: (.+)$/m)?.[1];
assert(target);
run('cargo', ['build', '-p', 'threejs-native-player', '--release', '--locked'], 600000);
const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', target]));
const binary = resolve(metadata.target_directory, 'release', `threejs-native-player${process.platform === 'win32' ? '.exe' : ''}`);
const runtime = run(binary, ['--version']);
const result = JSON.parse(run(binary, [bundle]));
assert.equal(result.rustThree, true);
assert.equal(result.sameJavaScriptDevice, true);
assert.equal(result.adapter.isFallbackAdapter, false);
assert.deepEqual(result.errors, []);
assert(result.foregroundPixels > result.width * result.height * 0.02);
assert(result.changedPixels > result.width * result.height * 0.01);
for (const [index, frame] of result.frames.entries()) {
  assert.equal(frame.length, result.width * result.height * 4);
  await writeFile(resolve(output, `frame-${index}.png`), PNG.sync.write({
    width: result.width, height: result.height, data: Buffer.from(frame),
  }));
}
delete result.frames;
for (const input of before) assert.equal(await hash(resolve(root, input.path)), input.sha256, `${input.path} changed`);
const versions = Object.fromEntries(metadata.packages.filter(p => ['deno_core','deno_web','deno_webidl','deno_webgpu','v8'].includes(p.name)).map(p => [p.name, p.version]));
const report = { recordedAt: new Date().toISOString(), kind: 'rust-three-offscreen-correctness',
  runtime, compiler: compiler.split('\n')[0], target, versions, inputs: before,
  binary: { bytes: (await stat(binary)).size, sha256: await hash(binary) },
  bundle: { sha256: await hash(bundle) }, result,
  limitations: ['Readback verifies rendering only; it is not frame transport.',
    'No native window, WebGL, DOM, unchanged-project compatibility or speed claim.'] };
await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`PASS: Rust-hosted Three.js r${result.three}; ${result.foregroundPixels} foreground and ${result.changedPixels} changed pixels. Report: ${output}/report.json`);
