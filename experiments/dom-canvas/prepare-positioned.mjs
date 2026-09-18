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
  'packages/blitz-paint/src/checked_scene.rs': '398ec60b1ebc491711ba53ea7711198ba58650009c59ed492d95b3ab20926925',
  'packages/blitz-paint/src/layers.rs': '65bc4da97aef8c456be403eb10330ae85b42b5f2484e93f79de9f258642b4ec2',
  'packages/blitz-paint/src/lib.rs': '7650e6b40569585ef308da42ac51192a072815fe7130a51909410b53ce5c0859',
  'packages/blitz-paint/src/render.rs': '266c97a17e3af65db6e7a9334eda3dc30b3fe5aea9d0a04abac5520b5a1317c1',
} : {
  'packages/blitz-dom/src/node/node.rs': 'b8cbc392c663aa4f431013a29d0d2d7e92d853cbc86ee3be800dc45d737f1d24',
  'packages/blitz-dom/src/resolve.rs': '6dacf0348fa880294de9c9e36a4af1e04af504f4d76e6d84d2302282c18f8556',
  'packages/blitz-dom/src/layout/damage.rs': '6548ac0c8f49634e9fbc4771fbd2d05787a79715be7ec77a78d87312527c6603',
  'packages/blitz-paint/src/render.rs': 'e18f773798fd56632c2f4a6b5b838fefa83825523662ac73dc96d1cc5518b967',
  'packages/blitz-dom/src/layout/mod.rs': '2924febe36c4a91002cf36f09f41edbf083021a2cb4da4f713bc40f33eeef6a1',
  'packages/blitz-dom/src/layout/initial_containing_block.rs': '3296c5ad5d474bf4d5ed1d8f301aa7f2d79abdbf644e9328b110ef685fcd4099',
  'packages/blitz-dom/src/layout/paint_order.rs': '0ebba71e5608324b9ba622a4f936d35c3fbf8c0bd6c3132e4910b81d750ef0a7',
  'packages/blitz-dom/src/paint_ownership.rs': 'cedd4ff218a19b1c10d4f4e2e5fe544fe6f884bd4834a4aeae61775f2a34a179',
  'packages/blitz-dom/src/geometry/css_box.rs': '2ea64bc8a742bbdb61306a6d2109dd579f4ae8bb332abcfed227d3594cbad82b',
  'packages/blitz-dom/src/geometry/mod.rs': '7f8c3e3912f7c0ae5be4706b9312c82d1238af7f6edf07b1d9db1a5d3bddf9cb',
  'packages/blitz-dom/src/geometry/non_uniform_radii.rs': '26c389367e1bb2717e796760098d241e54c00f842537ecd75260f3fea60ea73a',
  'packages/blitz-dom/src/lib.rs': 'f8d1acc43dc86d94090e0e091b6f1d934d20ca8168ff1033b7f8dd3234626f8a',
  'packages/blitz-paint/src/lib.rs': '9d0f391a00c4539c59e14508bc356ca7e8e6923b194947442a66141e862c8760',
  'packages/blitz-paint/src/render/border.rs': '420e6bd5c30186a76aca4a0a33e83b344480371c4ca409a6376f6e43b96cf07d',
  'packages/blitz-paint/src/checked_scene.rs': '398ec60b1ebc491711ba53ea7711198ba58650009c59ed492d95b3ab20926925',
  'packages/blitz-paint/src/layers.rs': '65bc4da97aef8c456be403eb10330ae85b42b5f2484e93f79de9f258642b4ec2',
  'packages/blitz-paint/src/render/ownership.rs': 'e907f4fb6646db0cfa2a06cf47b864d72f2186c38ceeac5b588d78126b7d8e6d',
  'packages/blitz-paint/src/render/clip_path.rs': '659d27be9a16c433140cddd887c9dbb2838089df5298767b14486d1639dff8c4',
  'packages/blitz-paint/src/render/ownership_clips.rs': 'c7b70522dc70fccd784e6128b4dcf43062a8fa8c8a84c8a8973f0f0986eb652d',
};
const addedFiles = baseline ? ['packages/blitz-paint/src/checked_scene.rs'] : [
  'packages/blitz-paint/src/checked_scene.rs',
  'packages/blitz-dom/src/paint_ownership.rs',
  'packages/blitz-dom/src/layout/initial_containing_block.rs',
  'packages/blitz-dom/src/layout/paint_order.rs',
  'packages/blitz-dom/src/geometry/css_box.rs',
  'packages/blitz-dom/src/geometry/mod.rs',
  'packages/blitz-dom/src/geometry/non_uniform_radii.rs',
  'packages/blitz-paint/src/render/ownership.rs',
  'packages/blitz-paint/src/render/ownership_clips.rs',
];
const removedFiles = baseline ? [] : [
  'packages/blitz-paint/src/kurbo_css/css_box.rs',
  'packages/blitz-paint/src/kurbo_css/mod.rs',
  'packages/blitz-paint/src/kurbo_css/non_uniform_radii.rs',
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
  },
  {
    'name': 'blitz-transform-context.patch',
    'sha256': '48c0837e2a24e2c0a7254cc56944fe700837909e2775e730793f153b619a80ab'
  },
  {
    'name': 'blitz-stacking-bounds.patch',
    'sha256': '570a97b110f5bf90c66464dbff7afcb24364bf3718395e98b4f33962010360d7'
  },
  {
    'name': 'blitz-shared-clip-geometry.patch',
    'sha256': '88c4920ce332a2535028cb1a7288d4ceab53a4294077f88d185eed54946f67ce'
  },
  {
    'name': 'blitz-paint-ownership.patch',
    'sha256': 'a4b2a64704ba3d7f96054d9c3c76809bff28da69bbf890805141abdef8729749'
  },
  {
    'name': 'blitz-layer-budget.patch',
    'sha256': 'ad167742d4464c70b16c817b68995a808e108dce7ba507f7868d162be2041f7a'
  },
  {
    'name': 'blitz-ownership-renderer.patch',
    'sha256': '91c6656f16b321320da1a39d5912b373a74fb5ce83fce50d6345811f7d4db5d5'
  }
];
const selectedPatches = baseline
  ? patchInputs.filter(patch => ['blitz-stacking-demotion.patch', 'blitz-layer-budget.patch'].includes(patch.name))
  : patchInputs;
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
manifest = manifest.replace(/path = "(src|tests)\/([^"]+)"/g, (_, directory, name) => `path = ${JSON.stringify(resolve(import.meta.dirname, directory, name))}`);
manifest = manifest.replace(/path = "\.\.\/\.\.\/\.cache\/dom-canvas\/([^\"]+)"/g, (_, path) => {
  const absolute = path.startsWith('blitz/')
    ? resolve(target, path)
    : resolve(root, '.cache/dom-canvas', path);
  return `path = ${JSON.stringify(absolute)}`;
});
assert(!manifest.includes('path = "src/') && !manifest.includes('path = "tests/') && !manifest.includes('path = "../../'), 'Unexpected relative path remains in candidate manifest.');
if (!baseline) manifest += `\n[[test]]\nname = "positioned-layout"\npath = ${JSON.stringify(resolve(import.meta.dirname, 'src/positioned_tests.rs'))}\n`;
if (!baseline) manifest += `\n[[bin]]\nname = "threejs-positioned-paint-owner-probe"\npath = ${JSON.stringify(resolve(import.meta.dirname, 'src/paint_owner_probe.rs'))}\n`;
if (!baseline) manifest += `\n[[bin]]\nname = "threejs-positioned-ownership-paint-probe"\npath = ${JSON.stringify(resolve(import.meta.dirname, 'src/ownership_clip_probe.rs'))}\n`;
if (!baseline) manifest += `\n[[test]]\nname = "ownership-render"\npath = ${JSON.stringify(resolve(import.meta.dirname, 'src/ownership_render_tests.rs'))}\n`;
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
assert.deepEqual((await fileNames(resolve(target, 'blitz'))).sort(), [...files.map(file => file.path).filter(path => !removedFiles.includes(path)), ...addedFiles].sort(),
  'Candidate must contain exactly the pinned tracked and added files.');
for (const path of removedFiles) assert(files.some(file => file.path === path), `Removed path is not pinned upstream: ${path}`);
for (const file of files) {
  if (removedFiles.includes(file.path)) continue;
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
  profile: baseline ? 'upstream-baseline' : 'initial-owner', changedFiles, addedFiles, removedFiles,
  patches: selectedPatches, verifiedTrackedFiles: files.length - removedFiles.length, verifiedAddedFiles: addedFiles.length, verifiedRemovedFiles: removedFiles.length,
  manifestInputSha256: hash(manifestInput), lockInputSha256: hash(lockInput),
  generatedManifestSha256: hash(manifest), generatedLockSha256: hash(lock), deno: normal.deno,
}, null, 2));
