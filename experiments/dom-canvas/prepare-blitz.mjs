import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const revision = '9d92719b37c801b8b41c81b799a2a474db8b3936';
const changedFile = 'packages/blitz-dom/src/layout/damage.rs';
const patchedSha256 = '64bb8e1a479160c80c0999311830595c9ef921785d906eb7e70e7e17b55f59ab';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message);
  return result.stdout;
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
  const patch = resolve(import.meta.dirname, 'patches/blitz-stacking-demotion.patch');
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
    for (const checking of [true, false]) {
      command('git', ['apply', ...(checking ? ['--check'] : []), '--whitespace=error', `--directory=${directory}`, patch], { cwd: root });
    }
  }
  for (const file of files) {
    const bytes = await readFile(resolve(target, file.path));
    if (file.path === changedFile) assert.equal(hash(bytes), patchedSha256, `Unexpected patch result: ${file.path}`);
    else {
      const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      assert.equal(blob, file.blob, `Unexpected pinned source contents: ${file.path}`);
    }
  }
  return { package: 'blitz', revision, directory, changedFile, patchedSha256,
    patchSha256: hash(await readFile(patch)), verifiedTrackedFiles: files.length };
}
