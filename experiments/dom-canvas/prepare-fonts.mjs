import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packages = [
  {
    "name": "fontique",
    "version": "0.11.1",
    "sourceTreeSha256": "17aa95f8bf0c87bcae2bbdaa6a262bef0a52de09ea2cf34ffa683f417b1d6980",
    "patchedTreeSha256": "f78d745579028df3c921920bbd94afb0c1bcf55588a6c6afa99798e78d17b9f5",
    "patchSha256": "62c469df1fc656ef2504a9485863026e6a377c6bac817229294584b35b36a432",
    "sourceFiles": 29,
    "patchedFiles": 30
  },
  {
    "name": "parley",
    "version": "0.11.1",
    "sourceTreeSha256": "7b18ef4914e3ca0f1de68a03db9de248132927ba66b361316570c937c20cf525",
    "patchedTreeSha256": "f416a7f467d0e88202bbcc99d861e89d1eefec65b5d60421affbfe4f8b3b06fb",
    "patchSha256": "4526b8ee5bd31162ed009812d842386a5df49a1e4cdc0e8492a4d25859c52cb3",
    "sourceFiles": 48,
    "patchedFiles": 48
  }
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function sourceTree(directory, prefix = '') {
  assert((await lstat(directory)).isDirectory(), `Not a source directory: ${directory}`);
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    const path = resolve(directory, entry.name);
    assert(entry.isDirectory() || entry.isFile(), `Non-file source entry: ${path}`);
    if (entry.isDirectory()) files.push(...await sourceTree(path, `${name}/`));
    // Cargo's installation receipts are not packaged Rust source.
    else if (!['.cargo-ok', '.cargo-checksum.json'].includes(name)) {
      files.push([name, hash(await readFile(path))]);
    }
  }
  return files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

async function verify(directory, pin, patched) {
  const files = await sourceTree(directory);
  assert.equal(files.length, patched ? pin.patchedFiles : pin.sourceFiles,
    `Unexpected ${pin.name} source file count`);
  const digest = hash(files.map(([name, sha]) => `${name}\0${sha}\n`).join(''));
  assert.equal(digest, patched ? pin.patchedTreeSha256 : pin.sourceTreeSha256,
    `Unexpected ${pin.name} source contents in ${directory}`);
  return digest;
}

/** Prepare isolated source copies; never modify the Cargo registry. No network. */
export async function prepareFonts(root, cargoHome, checkOnly = false) {
  root = resolve(root);
  const registry = resolve(cargoHome, 'registry/src');
  let registries;
  try {
    registries = await readdir(registry, { withFileTypes: true });
  } catch (cause) {
    throw new Error(`No source cache at ${registry}; set CARGO_HOME. No download attempted.`, { cause });
  }
  const reports = [];
  for (const pin of packages) {
    let source;
    for (const entry of registries.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = resolve(registry, entry.name, `${pin.name}-${pin.version}`);
      try {
        await verify(candidate, pin, false);
        source = candidate;
        break;
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ERR_ASSERTION') throw error;
      }
    }
    assert(source, `Unmodified ${pin.name} ${pin.version} source was not found. No download attempted.`);
    const patch = resolve(root, `experiments/dom-canvas/patches/${pin.name}-web-fonts.patch`);
    assert.equal(hash(await readFile(patch)), pin.patchSha256, `${pin.name} patch changed`);
    const target = resolve(root, `.cache/web-fonts/${pin.name}`);
    if (!checkOnly) {
      const relativeStage = `.cache/web-fonts/.${pin.name}-stage-${process.pid}`;
      const stage = resolve(root, relativeStage);
      await rm(stage, { recursive: true, force: true });
      await mkdir(dirname(stage), { recursive: true });
      try {
        await cp(source, stage, { recursive: true, errorOnExist: true, force: false });
        for (const dryRun of [true, false]) {
          const result = spawnSync('git', ['apply', ...(dryRun ? ['--check'] : []),
            '--whitespace=error', `--directory=${relativeStage}`, patch],
          { cwd: root, encoding: 'utf8', timeout: 30_000 });
          assert.equal(result.status, 0, result.stderr || result.error?.message || 'Font patch failed');
        }
        await verify(stage, pin, true);
        await rm(target, { recursive: true, force: true });
        await rename(stage, target);
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    }
    await verify(target, pin, true);
    reports.push({ ...pin, directory: `.cache/web-fonts/${pin.name}` });
  }
  return reports;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 1 && args[0] === '--check'),
    'Usage: node experiments/dom-canvas/prepare-fonts.mjs [--check]');
  const root = resolve(import.meta.dirname, '../..');
  const cargoHome = resolve(process.env.CARGO_HOME || resolve(homedir(), '.cargo'));
  console.log(JSON.stringify(await prepareFonts(root, cargoHome, args[0] === '--check'), null, 2));
}
