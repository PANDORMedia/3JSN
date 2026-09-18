import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const revision = 'c032f63418097bb82c26077a85c24896c0a96e9d';
const baseRevision = '9d92719b37c801b8b41c81b799a2a474db8b3936';
const taffyRevision = 'dc2fe8bd1ad93e93f0494bdeca2561a420c8f28c';
const baseTaffyRevision = 'c17b313cd1be5a4def91522cf3ea5995e664ebf7';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const [sourceArgument, ...options] = process.argv.slice(2);
assert(sourceArgument && !sourceArgument.startsWith('--')
  && new Set(options).size === options.length
  && options.every(option => ['--check', '--baseline'].includes(option)),
'Usage: node experiments/dom-canvas/prepare-positioned.mjs <local-blitz-git-repository> [--baseline] [--check]');
const baseline = options.includes('--baseline');
const checkOnly = options.includes('--check');
const directory = `.cache/positioned-candidate${baseline ? '-baseline' : ''}`;
const target = resolve(root, directory);
const namePrefix = baseline ? 'threejs-positioned-baseline-' : 'threejs-positioned-';
const changedFiles = baseline ? {
  'packages/blitz-dom/src/layout/damage.rs': '47ba61504d6e2dce8a45510dfb1b2339c7b6b21cc9984b41b1cdbc4b9872ff85',
} : {
  'packages/blitz-dom/src/node/node.rs': 'b4373fb4266c3d503ba63bb360258c86bd6c8daa66ea94c0ddc1d848176be56f',
  'packages/blitz-dom/src/resolve.rs': 'd7c19ad6b3914c71d356b58d7cd0f12f1a6b8e68a7dbe6a0bd7f3fa1f7dcaf13',
  'packages/blitz-dom/src/layout/damage.rs': '6548ac0c8f49634e9fbc4771fbd2d05787a79715be7ec77a78d87312527c6603',
  'packages/blitz-paint/src/render.rs': 'f0c5ae546a9c79c7045f30ee8c34fd6afd6cd3000d8692b9842caf2054e66c26',
  'packages/blitz-dom/src/layout/mod.rs': '2924febe36c4a91002cf36f09f41edbf083021a2cb4da4f713bc40f33eeef6a1',
  'packages/blitz-dom/src/layout/initial_containing_block.rs': '3296c5ad5d474bf4d5ed1d8f301aa7f2d79abdbf644e9328b110ef685fcd4099',
  'packages/blitz-dom/src/layout/paint_order.rs': 'cadd83c4b39c4be911b74c1f4a859fae4323106712e53f07d48fe3de5db642c1'
};
const addedFiles = baseline ? [] : [
  'packages/blitz-dom/src/layout/initial_containing_block.rs',
  'packages/blitz-dom/src/layout/paint_order.rs',
];
const patchInputs = [
  {
    'name': 'blitz-stacking-demotion.patch',
    'sha256': '90f0af5cc30fe1fdaba7bd6245b6170fdf42b6c3537a2e8845a8c7bde27c5b5f'
  },
  {
    'name': 'blitz-positioned-grid-state.patch',
    'sha256': '83140eaab44b000cd5213279087486e37329c1f3ce121a4ec1d65ef512e6bc79'
  },
  {
    'name': 'blitz-initial-containing-block-layout.patch',
    'sha256': 'aa34a7f82fc02c97d5fc72cf09f6da58e326cc8e5dec5b7196aa801851c188f1'
  },
  {
    'name': 'blitz-initial-containing-block-paint.patch',
    'sha256': 'e799909a4c00764944356cbddfa2ae7e1cb58786e79b0baca6acb2ade2acbec3'
  },
  {
    'name': 'blitz-positioned-paint-order.patch',
    'sha256': '29e0a1c4b14a1655391c74d0e353255bfd128a9f1e667bf15ecb02affcba43de'
  }
];
const selectedPatches = baseline ? patchInputs.slice(0, 1) : patchInputs;
const source = await realpath(resolve(sourceArgument));
let canonicalTarget;
try {
  canonicalTarget = await realpath(target);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  canonicalTarget = resolve(await realpath(resolve(root, '.cache')), directory.split('/').at(-1));
}
assert(source !== canonicalTarget && !source.startsWith(`${canonicalTarget}/`),
  'Source repository must be outside the generated candidate directory.');

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message || `${program} failed`);
  return result.stdout;
}

function replaceExactly(text, before, after, count) {
  assert.equal(text.split(before).length - 1, count, `Expected ${count} occurrences of ${before}; review the candidate generation inputs.`);
  return text.replaceAll(before, after);
}

const git = args => command('git', ['-C', source, ...args], { encoding: 'utf8' });
assert.equal(git(['rev-parse', `${revision}^{commit}`]).trim(), revision);
const upstreamManifest = git(['show', `${revision}:Cargo.toml`]);
assert.match(upstreamManifest, /taffy = \{ git = "https:\/\/github\.com\/DioxusLabs\/taffy", rev = "dc2fe8bd",/);
const taffySource = `git+https://github.com/DioxusLabs/taffy?rev=dc2fe8bd#${taffyRevision}`;
assert(git(['show', `${revision}:Cargo.lock`]).includes(`source = "${taffySource}"`));
const patches = selectedPatches.map(patch => ({
  ...patch, path: resolve(import.meta.dirname, 'patches', patch.name),
}));
for (const patch of patches) {
  assert.equal(hash(await readFile(patch.path)), patch.sha256,
    `Patch changed; review its candidate result before updating this pin: ${patch.name}`);
}

// Reuse the normal read-only verification for the shared prepared Deno dependency.
const normal = JSON.parse(command(process.execPath, [resolve(import.meta.dirname, 'prepare.mjs'), '--check'], {
  cwd: root, encoding: 'utf8',
}));
const manifestInput = await readFile(resolve(import.meta.dirname, 'Cargo.toml'), 'utf8');
const lockInput = await readFile(resolve(import.meta.dirname, 'Cargo.lock'), 'utf8');
let manifest = replaceExactly(manifestInput, `rev = "${baseRevision}"`, `rev = "${revision}"`, 4);
manifest = manifest.replace(/^name = "threejs-([^"]+)"$/gm, (_, name) => `name = "${namePrefix}${name}"`);
manifest = manifest.replace(/path = "src\/([^"]+)"/g, (_, name) => `path = ${JSON.stringify(resolve(import.meta.dirname, 'src', name))}`);
manifest = manifest.replace(/path = "\.\.\/\.\.\/\.cache\/dom-canvas\/([^\"]+)"/g, (_, path) => {
  const absolute = path.startsWith('blitz/')
    ? resolve(target, path)
    : resolve(root, '.cache/dom-canvas', path);
  return `path = ${JSON.stringify(absolute)}`;
});
assert(!manifest.includes('path = "src/') && !manifest.includes('path = "../../'), 'Unexpected relative path remains in candidate manifest.');
if (!baseline) manifest += `\n[[test]]\nname = "positioned-layout"\npath = ${JSON.stringify(resolve(import.meta.dirname, 'src/positioned_tests.rs'))}\n`;
let lock = replaceExactly(lockInput,
  `git+https://github.com/DioxusLabs/taffy?rev=${baseTaffyRevision}#${baseTaffyRevision}`, taffySource, 1);
lock = replaceExactly(lock, 'name = "threejs-dom-canvas-probe"', `name = "${namePrefix}dom-canvas-probe"`, 1);

const files = git(['ls-tree', '-rz', revision]).split('\0').filter(Boolean).map(entry => {
  const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
  assert(match, `Unsupported pinned tree entry: ${entry}`);
  return { path: match[3], blob: match[2] };
});
if (!checkOnly) {
  // Archive immutable objects; local changes in the supplied repository are never copied.
  const archive = command('git', ['-C', source, 'archive', revision]);
  await rm(resolve(target, 'blitz'), { recursive: true, force: true });
  await mkdir(resolve(target, 'blitz'), { recursive: true });
  command('tar', ['-x', '-C', resolve(target, 'blitz')], { input: archive });
  for (const patch of patches) {
    for (const checking of [true, false]) {
      command('git', ['apply', ...(checking ? ['--check'] : []), '--whitespace=error',
        `--directory=${directory}/blitz`, patch.path], { cwd: root });
    }
  }
  await mkdir(resolve(target, 'probe'), { recursive: true });
  await writeFile(resolve(target, 'probe/Cargo.toml'), manifest);
  await writeFile(resolve(target, 'probe/Cargo.lock'), lock);
}

async function fileNames(path, prefix = '') {
  const names = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) names.push(...await fileNames(resolve(path, entry.name), `${name}/`));
    else {
      assert(entry.isFile(), `Unexpected non-file in candidate: ${name}`);
      names.push(name);
    }
  }
  return names;
}
assert.deepEqual((await fileNames(resolve(target, 'blitz'))).sort(), [...files.map(file => file.path), ...addedFiles].sort(),
  'Candidate must contain exactly the pinned tracked and added files.');
for (const file of files) {
  const bytes = await readFile(resolve(target, 'blitz', file.path));
  if (Object.hasOwn(changedFiles, file.path)) assert.equal(hash(bytes), changedFiles[file.path], `Unexpected patched file: ${file.path}`);
  else assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    file.blob, `Unexpected candidate source contents: ${file.path}`);
}
for (const path of addedFiles) {
  assert.equal(hash(await readFile(resolve(target, 'blitz', path))), changedFiles[path], `Unexpected added file: ${path}`);
}
assert.equal(await readFile(resolve(target, 'probe/Cargo.toml'), 'utf8'), manifest);
assert.equal(await readFile(resolve(target, 'probe/Cargo.lock'), 'utf8'), lock);
console.log(JSON.stringify({
  status: 'prepared-research-candidate', adopted: false, directory, revision, taffyRevision,
  profile: baseline ? 'upstream-baseline' : 'initial-owner', changedFiles, addedFiles,
  patches: selectedPatches, verifiedTrackedFiles: files.length, verifiedAddedFiles: addedFiles.length,
  manifestInputSha256: hash(manifestInput), lockInputSha256: hash(lockInput),
  generatedManifestSha256: hash(manifest), generatedLockSha256: hash(lock), deno: normal.deno,
}, null, 2));
