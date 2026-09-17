import assert from 'node:assert/strict';
import { readdir, readFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const ignored = new Set(['.git', '.cache', 'node_modules', 'target', 'artifacts', 'dist', 'build']);
async function filesAt(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesAt(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

let checked = 0;
for (const file of await filesAt(root)) {
  if (file.endsWith('.mjs') || file.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    checked++;
  }
  if (file.endsWith('.json')) {
    JSON.parse(await readFile(file, 'utf8'));
    checked++;
  }
  if (file.endsWith('.md')) {
    const content = await readFile(file, 'utf8');
    // Local Markdown links only. External URLs/anchors are outside this check.
    for (const match of content.matchAll(/\]\(([^\s)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      await access(resolve(dirname(file), target));
    }
    checked++;
  }
}
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
assert.deepEqual(manifest.dependencies, lock.packages[''].dependencies);
assert.equal(manifest.private, true, 'Research package should not be accidentally published.');
console.log(`PASS: ${checked} source/config/document files checked. No GPU tests were run.`);
