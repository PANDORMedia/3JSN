import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
function run(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
  } catch (error) {
    throw new Error(`${command} failed (${error.code ?? error.status ?? error.signal}); see the command diagnostics above.`);
  }
}

const compiler = run('rustc', ['-vV']);
const target = compiler.match(/^host: (.+)$/m)?.[1];
assert(target, 'rustc must report its compilation target');
run('cargo', ['build', '-p', 'threejs-native-player', '--release', '--locked']);
const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', target]));
const binary = resolve(metadata.target_directory, 'release', `threejs-native-player${process.platform === 'win32' ? '.exe' : ''}`);
const runtime = run(binary, ['--version']);
const rendering = JSON.parse(run(binary, ['examples/runtime/offscreen.mjs']));
assert.equal(rendering.result, 'pass');
assert.equal(rendering.adapter.isFallbackAdapter, false);
assert.deepEqual(rendering.validationErrors, []);

const selected = new Set(['deno_core', 'deno_v8', 'v8', 'deno_web', 'deno_webidl', 'deno_webgpu']);
const versions = Object.fromEntries(metadata.packages.filter(p => selected.has(p.name)).map(p => [p.name, p.version]));
const gpuPackage = metadata.packages.find(p => p.name === 'deno_webgpu');
const gpuDependencies = metadata.resolve.nodes.find(node => node.id === gpuPackage.id).dependencies;
const report = {
  recordedAt: new Date().toISOString(), target, runtime,
  compiler: compiler.split('\n')[0], versions,
  gpuBinding: metadata.packages.filter(p => gpuDependencies.includes(p.id) && ['wgpu-core', 'wgpu-types'].includes(p.name)).map(p => ({ name: p.name, version: p.version })),
  binary: { bytes: (await stat(binary)).size, sha256: createHash('sha256').update(await readFile(binary)).digest('hex') },
  rendering,
  limitations: ['Offscreen Rust-hosted JavaScript/WebGPU only.', 'No native window, WebGL, DOM, CtF compatibility or comparative performance claim.'],
};
const output = resolve(root, 'artifacts/rust-runtime/report.json');
await mkdir(resolve(root, 'artifacts/rust-runtime'), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`PASS: ${runtime}; ${rendering.greenPixels} triangle pixels; report: ${output}`);
