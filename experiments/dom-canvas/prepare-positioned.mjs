import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const directory = '.cache/positioned-candidate';
const target = resolve(root, directory);
const revision = 'c032f63418097bb82c26077a85c24896c0a96e9d';
const baseRevision = '9d92719b37c801b8b41c81b799a2a474db8b3936';
const taffyRevision = 'dc2fe8bd1ad93e93f0494bdeca2561a420c8f28c';
const baseTaffyRevision = 'c17b313cd1be5a4def91522cf3ea5995e664ebf7';
const changedFile = 'packages/blitz-dom/src/layout/damage.rs';
const patchedSha256 = '47ba61504d6e2dce8a45510dfb1b2339c7b6b21cc9984b41b1cdbc4b9872ff85';
const patchSha256 = '90f0af5cc30fe1fdaba7bd6245b6170fdf42b6c3537a2e8845a8c7bde27c5b5f';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const [sourceArgument, option, ...extra] = process.argv.slice(2);
assert(sourceArgument && !sourceArgument.startsWith('--') && extra.length === 0
  && (option === undefined || option === '--check'),
'Usage: node experiments/dom-canvas/prepare-positioned.mjs <local-blitz-git-repository> [--check]');
const source = resolve(sourceArgument);
assert(source !== target && !source.startsWith(`${target}/`), 'Source repository must be outside the generated candidate directory.');

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
const patch = resolve(import.meta.dirname, 'patches/blitz-stacking-demotion.patch');
assert.equal(hash(await readFile(patch)), patchSha256, 'Stacking patch changed; review its candidate result before updating this pin.');

// Reuse the normal read-only verification for the shared prepared Deno dependency.
const normal = JSON.parse(command(process.execPath, [resolve(import.meta.dirname, 'prepare.mjs'), '--check'], {
  cwd: root, encoding: 'utf8',
}));
const manifestInput = await readFile(resolve(import.meta.dirname, 'Cargo.toml'), 'utf8');
const lockInput = await readFile(resolve(import.meta.dirname, 'Cargo.lock'), 'utf8');
let manifest = replaceExactly(manifestInput, `rev = "${baseRevision}"`, `rev = "${revision}"`, 4);
manifest = manifest.replace(/^name = "threejs-([^"]+)"$/gm, 'name = "threejs-positioned-$1"');
manifest = manifest.replace(/path = "src\/([^"]+)"/g, (_, name) => `path = ${JSON.stringify(resolve(import.meta.dirname, 'src', name))}`);
manifest = manifest.replace(/path = "\.\.\/\.\.\/\.cache\/dom-canvas\/([^\"]+)"/g, (_, path) => {
  const absolute = path.startsWith('blitz/')
    ? resolve(target, path)
    : resolve(root, '.cache/dom-canvas', path);
  return `path = ${JSON.stringify(absolute)}`;
});
assert(!manifest.includes('path = "src/') && !manifest.includes('path = "../../'), 'Unexpected relative path remains in candidate manifest.');
let lock = replaceExactly(lockInput,
  `git+https://github.com/DioxusLabs/taffy?rev=${baseTaffyRevision}#${baseTaffyRevision}`, taffySource, 1);
lock = replaceExactly(lock, 'name = "threejs-dom-canvas-probe"', 'name = "threejs-positioned-dom-canvas-probe"', 1);

const files = git(['ls-tree', '-rz', revision]).split('\0').filter(Boolean).map(entry => {
  const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
  assert(match, `Unsupported pinned tree entry: ${entry}`);
  return { path: match[3], blob: match[2] };
});
if (option !== '--check') {
  // Archive immutable objects; local changes in the supplied repository are never copied.
  const archive = command('git', ['-C', source, 'archive', revision]);
  await rm(resolve(target, 'blitz'), { recursive: true, force: true });
  await mkdir(resolve(target, 'blitz'), { recursive: true });
  command('tar', ['-x', '-C', resolve(target, 'blitz')], { input: archive });
  for (const checking of [true, false]) {
    command('git', ['apply', ...(checking ? ['--check'] : []), '--whitespace=error',
      `--directory=${directory}/blitz`, patch], { cwd: root });
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
assert.deepEqual((await fileNames(resolve(target, 'blitz'))).sort(), files.map(file => file.path).sort(),
  'Candidate must contain exactly the pinned tracked files.');
for (const file of files) {
  const bytes = await readFile(resolve(target, 'blitz', file.path));
  if (file.path === changedFile) assert.equal(hash(bytes), patchedSha256, `Unexpected patched file: ${file.path}`);
  else assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    file.blob, `Unexpected candidate source contents: ${file.path}`);
}
assert.equal(await readFile(resolve(target, 'probe/Cargo.toml'), 'utf8'), manifest);
assert.equal(await readFile(resolve(target, 'probe/Cargo.lock'), 'utf8'), lock);
console.log(JSON.stringify({
  status: 'prepared-research-candidate', adopted: false, directory, revision, taffyRevision,
  changedFile, patchSha256, patchedSha256, verifiedTrackedFiles: files.length,
  manifestInputSha256: hash(manifestInput), lockInputSha256: hash(lockInput),
  generatedManifestSha256: hash(manifest), generatedLockSha256: hash(lock), deno: normal.deno,
}, null, 2));
