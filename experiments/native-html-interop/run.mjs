import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const [font, outputArgument = 'artifacts/native-html-interop/output'] = process.argv.slice(2);
assert(font, 'Usage: node experiments/native-html-interop/run.mjs <font> [output-directory]');
assert.equal(process.platform, 'darwin', 'This experiment requires Metal on macOS.');
const output = resolve(root, outputArgument);
await mkdir(output, { recursive: true });
const manifest = 'experiments/native-html-interop/Cargo.toml';
const metadata = spawnSync('cargo', ['metadata', '--locked', '--offline', '--format-version', '1', '--manifest-path', manifest],
  { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
assert.equal(metadata.status, 0, metadata.stderr || metadata.error?.message);
const graph = JSON.parse(metadata.stdout);
const compiler = spawnSync('rustc', ['-vV'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
assert.equal(compiler.status, 0, compiler.stderr || compiler.error?.message);
const binary = resolve(graph.target_directory, 'debug/threejs-native-html-interop-probe');
const startedAt = new Date().toISOString();
const result = spawnSync(binary, [resolve(root, font), resolve(root, 'artifacts/native-html-interop/app.mjs'), output], {
  cwd: root, env: { ...process.env, MTL_DEBUG_LAYER: '1' }, encoding: 'utf8', timeout: 120_000,
  maxBuffer: 8 * 1024 * 1024,
});
await writeFile(resolve(output, 'stdout.log'), result.stdout ?? '');
await writeFile(resolve(output, 'stderr.log'), result.stderr ?? '');
assert.equal(result.status, 0, result.stderr || result.error?.message);
assert.match(result.stderr, /Metal API Validation Enabled/, 'Metal validation diagnostic absent');
const report = JSON.parse(await readFile(resolve(output, 'report.json'), 'utf8'));
assert.equal(report.status, 'pass');
const failureOutput = resolve(output, 'injected-failure');
await mkdir(failureOutput, { recursive: true });
const failure = spawnSync(binary, [resolve(root, font), resolve(root, 'artifacts/native-html-interop/app.mjs'), failureOutput], {
  cwd: root, env: { ...process.env, MTL_DEBUG_LAYER: '1', THREEJS_NATIVE_INTEROP_INJECT_FAILURE: '1' },
  encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
});
await writeFile(resolve(failureOutput, 'stderr.log'), failure.stderr ?? '');
assert.equal(failure.status, 1, failure.stderr || failure.error?.message);
assert.match(failure.stderr, /EXPECTED_FAILURE_AFTER_SUBMIT; shared GPU cleanup completed/);
assert.match(failure.stderr, /Metal API Validation Enabled/);
const names = new Set(['deno_core', 'deno_web', 'deno_webidl', 'deno_webgpu', 'v8', 'wgpu', 'wgpu-core', 'wgpu-types', 'wgpu-hal', 'vello', 'anyrender_vello', 'blitz-dom', 'blitz-paint']);
const versions = graph.packages.filter(item => names.has(item.name)).map(item => ({ name: item.name, version: item.version, source: item.source }));
for (const name of ['wgpu-core', 'wgpu-types']) assert.equal(versions.filter(item => item.name === name).length, 1, `duplicate ${name}`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = {};
for (const name of ['Cargo.toml', 'Cargo.lock', 'app.mjs', 'events.js', 'fixture.html', 'bundle.mjs', 'run.mjs',
  'src/main.rs', 'src/host.rs', 'src/painter.rs', 'src/metal.rs', 'src/evidence.rs', 'src/dom_bridge.rs', 'src/bindings.js']) {
  sources[name] = hash(await readFile(resolve(import.meta.dirname, name)));
}
const sharedSources = {};
for (const name of ['crates/runtime/src/web-globals.js', 'experiments/html-v8/src/main.rs',
  'docs/investigations/html-dom/fixture.js', 'examples/spinning-scene/scene.mjs', 'package-lock.json']) {
  sharedSources[name] = hash(await readFile(resolve(root, name)));
}
const verification = { ...report, execution: { startedAt, finishedAt: new Date().toISOString(), exitCode: result.status,
  timeoutSeconds: 120, metalValidationObserved: true, platform: process.platform, architecture: process.arch },
  failureInjection: { afterSubmittedFrames: 2, exitCode: failure.status, sharedGpuCleanupCompleted: true, metalValidationObserved: true },
  actualResolvedVersions: versions, compiler: compiler.stdout.trim(), sourceSha256: sources,
  sharedSourceSha256: sharedSources, bundleSha256: hash(await readFile(resolve(root, 'artifacts/native-html-interop/app.mjs'))),
  executableSha256: hash(await readFile(binary)) };
await writeFile(resolve(output, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`);
console.log(`PASS: ${report.frames} shared-queue frames, ${report.generations.length} texture generations. Evidence: ${output}/verification.json`);
