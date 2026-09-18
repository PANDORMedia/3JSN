import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { prepareBlitz } from './prepare-blitz.mjs';

const root = resolve(import.meta.dirname, '../..');
const cargoHome = resolve(process.env.CARGO_HOME || resolve(homedir(), '.cargo'));
const registry = resolve(cargoHome, 'registry/src');
const cacheDirectory = '.cache/dom-canvas/deno_webgpu';
const target = resolve(root, cacheDirectory);
const patchPath = resolve(import.meta.dirname, 'patches/deno-webgpu-canvas.patch');
const sourceSha256 = 'f72afc419f0e701569f4305116e4154c34159194126fc7b2c9f90edb4ad71be2';
const patchedSha256 = 'f977f90baf198bad641b2215efc9b92832b5e3d2c0606d2a22552dad9efed7e6';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 1 && args[0] === '--check'),
  'Usage: node experiments/dom-canvas/prepare.mjs [--check]');

let entries;
try {
  entries = await readdir(registry, { withFileTypes: true });
} catch (error) {
  throw new Error(`No Cargo source cache at ${registry}; set CARGO_HOME to the existing cache. No download was attempted.`, { cause: error });
}
const candidates = [];
for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const directory = resolve(registry, entry.name, 'deno_webgpu-0.226.0');
  try {
    candidates.push({ directory, sha256: hash(await readFile(resolve(directory, 'canvas.rs'))) });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const source = candidates.find(item => item.sha256 === sourceSha256)?.directory;
assert(source, `Pinned deno_webgpu 0.226.0 canvas.rs was not found with SHA256 ${sourceSha256}. Set CARGO_HOME to an unmodified source cache; no download was attempted.`);
const manifest = await readFile(resolve(source, 'Cargo.toml'), 'utf8');
assert.match(manifest, /^name = "deno_webgpu"$/m);
assert.match(manifest, /^version = "0\.226\.0"$/m);

// Keep the complete cached source unchanged apart from the verified canvas patch.
async function sourceChecksums(directory, prefix = '') {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await sourceChecksums(path, `${name}/`));
    else {
      assert(entry.isFile(), `Unexpected non-file in Cargo source: ${name}`);
      files[name] = hash(await readFile(path));
    }
  }
  return files;
}
const checksums = await sourceChecksums(source);
assert.equal(checksums['canvas.rs'], sourceSha256);
async function verify(directory, expectedCanvasHash) {
  for (const [name, checksum] of Object.entries(checksums)) {
    assert.equal(hash(await readFile(resolve(directory, name))),
      name === 'canvas.rs' ? expectedCanvasHash : checksum,
      `Unexpected source contents: ${name}`);
  }
}
await verify(source, sourceSha256);

if (args[0] !== '--check') {
  // This dedicated ignored directory is disposable; the Cargo registry is read-only.
  await rm(target, { recursive: true, force: true });
  await mkdir(resolve(target, '..'), { recursive: true });
  await cp(source, target, { recursive: true, force: false, errorOnExist: true });
  for (const check of [true, false]) {
    const result = spawnSync('git', ['apply', ...(check ? ['--check'] : []),
      '--whitespace=error', `--directory=${cacheDirectory}`, patchPath],
    { cwd: root, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message || 'git apply failed');
  }
}
await verify(target, patchedSha256);
const deno = {
  package: 'deno_webgpu', version: '0.226.0', directory: cacheDirectory,
  sourceCanvasSha256: sourceSha256, patchedCanvasSha256: patchedSha256,
  patchSha256: hash(await readFile(patchPath)), verifiedPackagedFiles: Object.keys(checksums).length,
};
const blitz = await prepareBlitz(root, cargoHome, args[0] === '--check');
console.log(JSON.stringify({ deno, blitz }, null, 2));
