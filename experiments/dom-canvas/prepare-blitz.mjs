import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const revision = '9d92719b37c801b8b41c81b799a2a474db8b3936';
const changedFiles = {
  'packages/blitz-dom/src/layout/damage.rs': '64bb8e1a479160c80c0999311830595c9ef921785d906eb7e70e7e17b55f59ab',
  'packages/blitz-dom/src/document.rs': '03946edd9a9b81b988193096804c50759888c7aacfa1f1b5fe89f219c5fcd8fe',
  'packages/blitz-dom/src/node/node.rs': 'f0e7abc1931206569ea0871e9a994bead997f6486e2cc675978cd97858bfd1f4',
  'packages/blitz-paint/src/checked_scene.rs': '398ec60b1ebc491711ba53ea7711198ba58650009c59ed492d95b3ab20926925',
  'packages/blitz-paint/src/layers.rs': '65bc4da97aef8c456be403eb10330ae85b42b5f2484e93f79de9f258642b4ec2',
  'packages/blitz-paint/src/lib.rs': '7650e6b40569585ef308da42ac51192a072815fe7130a51909410b53ce5c0859',
  'packages/blitz-paint/src/render.rs': '454a9d61ba9213d888e6699714fe07bc387e48d049979cc650f61e6af6dfa0fa',
};
const patchNames = ['blitz-stacking-demotion.patch', 'blitz-boxless-geometry.patch', 'blitz-layer-budget.patch'];
const addedFiles = ['packages/blitz-paint/src/checked_scene.rs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message);
  return result.stdout;
}

async function fileNames(path, prefix = '') {
  const names = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) names.push(...await fileNames(resolve(path, entry.name), `${name}/`));
    else {
      assert(entry.isFile(), `Unexpected non-file in prepared Blitz: ${name}`);
      names.push(name);
    }
  }
  return names;
}

export async function prepareBlitz(root, cargoHome, checkOnly) {
  const checkouts = resolve(cargoHome, 'git/checkouts');
  let source;
  for (const repository of await readdir(checkouts, { withFileTypes: true })) {
    if (!repository.isDirectory() || !repository.name.startsWith('blitz-')) continue;
    for (const checkout of await readdir(resolve(checkouts, repository.name), { withFileTypes: true })) {
      if (!checkout.isDirectory()) continue;
      const candidate = resolve(checkouts, repository.name, checkout.name);
      const head = spawnSync('git', ['-C', candidate, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 });
      if (head.status === 0 && head.stdout.trim() === revision) source = candidate;
    }
  }
  assert(source, `Pinned Blitz ${revision} is absent from the Cargo checkout cache; no download was attempted.`);
  const directory = '.cache/dom-canvas/blitz';
  const target = resolve(root, directory);
  const patches = patchNames.map(name => resolve(import.meta.dirname, 'patches', name));
  const tree = command('git', ['-C', source, 'ls-tree', '-rz', revision], { encoding: 'utf8' });
  const files = tree.split('\0').filter(Boolean).map(entry => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    assert(match, `Unsupported pinned tree entry: ${entry}`);
    return { path: match[3], blob: match[2] };
  });
  if (!checkOnly) {
    // Archive the immutable commit, never a potentially edited registry checkout.
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    const archive = command('git', ['-C', source, 'archive', revision]);
    command('tar', ['-x', '-C', target], { input: archive });
    for (const patch of patches) {
      for (const checking of [true, false]) {
        command('git', ['apply', ...(checking ? ['--check'] : []), '--whitespace=error', `--directory=${directory}`, patch], { cwd: root });
      }
    }
  }
  assert.deepEqual((await fileNames(target)).sort(), [...files.map(file => file.path), ...addedFiles].sort(),
    'Prepared Blitz must contain exactly the pinned tracked and added files.');
  for (const file of files) {
    const bytes = await readFile(resolve(target, file.path));
    if (Object.hasOwn(changedFiles, file.path)) assert.equal(hash(bytes), changedFiles[file.path], `Unexpected patch result: ${file.path}`);
    else {
      const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      assert.equal(blob, file.blob, `Unexpected pinned source contents: ${file.path}`);
    }
  }
  for (const path of addedFiles) {
    assert.equal(hash(await readFile(resolve(target, path))), changedFiles[path], `Unexpected added file: ${path}`);
  }
  return { package: 'blitz', revision, directory, changedFiles, addedFiles,
    patches: await Promise.all(patches.map(async (patch, i) => ({ name: patchNames[i], sha256: hash(await readFile(patch)) }))),
    verifiedTrackedFiles: files.length, verifiedAddedFiles: addedFiles.length };
}
