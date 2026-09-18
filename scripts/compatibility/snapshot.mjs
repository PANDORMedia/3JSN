import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export class SnapshotError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'SnapshotError';
    this.code = code;
  }
}

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const within = (root, path) => path === root || (!relative(root, path).startsWith(`..${sep}`) && relative(root, path) !== '..' && !isAbsolute(relative(root, path)));

function validatePath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /^[a-z]:/i.test(path) || path.includes('\\') || path.includes('\0') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new SnapshotError('INVALID_PATH', `Expected a portable, root-relative path: ${JSON.stringify(path)}`);
  }
}

function normalizeExclusions(exclude) {
  if (!Array.isArray(exclude)) throw new SnapshotError('INVALID_EXCLUSIONS', 'Exclusions must be an array of exact root-relative paths.');
  for (const path of exclude) validatePath(path);
  return [...new Set(['.git', ...exclude])].sort(compare);
}

const isExcluded = (path, excluded, basenames = []) => path.split('/').some(part => basenames.includes(part)) || excluded.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

function normalizeBasenames(values) {
  if (!Array.isArray(values)) throw new SnapshotError('INVALID_EXCLUSIONS', 'Basename exclusions must be an array.');
  for (const value of values) {
    validatePath(value);
    if (value.includes('/')) throw new SnapshotError('INVALID_EXCLUSIONS', 'Basename exclusions cannot contain a path.');
  }
  return [...new Set(values)].sort(compare);
}

function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

async function fileEntry(path, name, initial) {
  // Refuse a link substituted between lstat and open; metadata checks catch ordinary concurrent writes.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || identity(initial) !== identity(before)) throw new SnapshotError('INPUT_CHANGED', `Input changed while reading ${name}`);
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (identity(before) !== identity(after) || identity(after) !== identity(pathAfter) || !pathAfter.isFile()) {
      throw new SnapshotError('INPUT_CHANGED', `Input changed while reading ${name}`);
    }
    return { path: name, kind: 'file', bytes: Number(after.size), sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

/** Hash a quiescent tree. Exact-path and optional all-depth basename exclusions are recorded in the digest. */
export async function snapshotTree(inputRoot, { exclude = [], excludeBasenames = [] } = {}) {
  const root = resolve(inputRoot);
  const excluded = normalizeExclusions(exclude);
  const basenames = normalizeBasenames(excludeBasenames);
  if (!(await lstat(root)).isDirectory()) throw new SnapshotError('INVALID_ROOT', 'The snapshot root must be a real directory, not a symbolic link.');
  const canonicalRoot = await realpath(root);
  const entries = [];
  const links = [];

  async function walk(directory, prefix = '') {
    const before = await lstat(directory, { bigint: true });
    for (const name of (await readdir(directory)).sort(compare)) {
      const path = prefix ? `${prefix}/${name}` : name;
      validatePath(path);
      if (isExcluded(path, excluded, basenames)) continue;
      const absolute = join(directory, name);
      const stat = await lstat(absolute, { bigint: true });
      if (stat.isSymbolicLink()) {
        const target = await readlink(absolute);
        const lexicalTarget = resolve(canonicalRoot, dirname(path), target);
        if (!within(canonicalRoot, lexicalTarget)) throw new SnapshotError('EXTERNAL_LINK', `Symbolic link leaves the snapshot root: ${path}`);
        if (isExcluded(relative(canonicalRoot, lexicalTarget).split(sep).join('/'), excluded, basenames)) throw new SnapshotError('EXCLUDED_LINK', `Symbolic link refers to excluded input: ${path}`);
        let resolved;
        try { resolved = await realpath(absolute); } catch (cause) {
          throw new SnapshotError('INVALID_LINK', `Dangling or cyclic symbolic link: ${path}`, { cause });
        }
        if (!within(canonicalRoot, resolved)) throw new SnapshotError('EXTERNAL_LINK', `Symbolic link leaves the snapshot root: ${path}`);
        const targetPath = relative(canonicalRoot, resolved).split(sep).join('/');
        if (isExcluded(targetPath, excluded, basenames)) throw new SnapshotError('EXCLUDED_LINK', `Symbolic link refers to excluded input: ${path}`);
        const entry = { path, kind: 'symlink', target };
        entries.push(entry);
        links.push({ entry, targetPath, absolute, identity: identity(stat) });
      } else if (stat.isDirectory()) {
        entries.push({ path, kind: 'directory' });
        await walk(absolute, path);
      } else if (stat.isFile()) {
        entries.push(await fileEntry(absolute, path, stat));
      } else {
        throw new SnapshotError('UNSUPPORTED_INPUT', `Only files, directories and contained symbolic links are supported: ${path}`);
      }
    }
    const after = await lstat(directory, { bigint: true });
    if (identity(before) !== identity(after) || !after.isDirectory()) throw new SnapshotError('INPUT_CHANGED', `Directory changed while reading ${prefix || '.'}`);
  }

  await walk(root);
  const paths = new Set(entries.map((entry) => entry.path));
  for (const { entry, targetPath, absolute, identity: initialIdentity } of links) {
    if (targetPath && !paths.has(targetPath)) throw new SnapshotError('EXCLUDED_LINK', `Symbolic link target was not captured: ${entry.path}`);
    if (await readlink(absolute) !== entry.target || identity(await lstat(absolute, { bigint: true })) !== initialIdentity) throw new SnapshotError('INPUT_CHANGED', `Symbolic link changed while reading ${entry.path}`);
  }
  entries.sort((a, b) => compare(a.path, b.path));
  const content = { schemaVersion: 1, algorithm: 'sha256', exclusions: excluded, ...(basenames.length ? { excludeBasenames: basenames } : {}), entries };
  return { ...content, digest: digest(JSON.stringify(content)) };
}

function validateSnapshotContents(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.algorithm !== 'sha256' || !Array.isArray(manifest.entries)) {
    throw new SnapshotError('INVALID_MANIFEST', 'Expected a version 1 SHA-256 snapshot.');
  }
  const exclusions = normalizeExclusions(manifest.exclusions);
  if (JSON.stringify(exclusions) !== JSON.stringify(manifest.exclusions)) throw new SnapshotError('INVALID_MANIFEST', 'Exclusions must be sorted and unique.');
  const basenames = normalizeBasenames(manifest.excludeBasenames ?? []);
  if (manifest.excludeBasenames !== undefined && (!basenames.length || JSON.stringify(basenames) !== JSON.stringify(manifest.excludeBasenames))) throw new SnapshotError('INVALID_MANIFEST', 'Basename exclusions must be nonempty, sorted and unique.');
  let previous = '';
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new SnapshotError('INVALID_MANIFEST', 'Snapshot entries must be objects.');
    validatePath(entry.path);
    if (previous && compare(previous, entry.path) >= 0) throw new SnapshotError('INVALID_MANIFEST', 'Entries must be sorted and unique.');
    if (isExcluded(entry.path, exclusions, basenames)) throw new SnapshotError('INVALID_MANIFEST', `Excluded entry is present: ${entry.path}`);
    previous = entry.path;
    if (entry.kind === 'file') {
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new SnapshotError('INVALID_MANIFEST', `Invalid file entry: ${entry.path}`);
    } else if (entry.kind === 'symlink') {
      if (typeof entry.target !== 'string' || !entry.target || entry.target.includes('\0')) throw new SnapshotError('INVALID_MANIFEST', `Invalid symbolic link: ${entry.path}`);
    } else if (entry.kind !== 'directory') {
      throw new SnapshotError('INVALID_MANIFEST', `Unknown entry kind: ${entry.kind}`);
    }
  }
  const { schemaVersion, algorithm, entries } = manifest;
  if (manifest.digest !== digest(JSON.stringify({ schemaVersion, algorithm, exclusions, ...(basenames.length ? { excludeBasenames: basenames } : {}), entries }))) throw new SnapshotError('INVALID_MANIFEST', 'Snapshot digest does not match its contents.');
  return manifest;
}

/** Reject malformed or modified manifests before using their exclusions or entries. */
export function validateSnapshot(manifest) {
  try { return validateSnapshotContents(manifest); } catch (cause) {
    if (cause instanceof SnapshotError && cause.code === 'INVALID_MANIFEST') throw cause;
    throw new SnapshotError('INVALID_MANIFEST', `Malformed snapshot: ${cause.message}`, { cause });
  }
}

export async function readSnapshot(file) {
  const source = await readFile(file, 'utf8');
  let manifest;
  try { manifest = JSON.parse(source); } catch (cause) {
    throw new SnapshotError('INVALID_MANIFEST', `Cannot parse snapshot: ${file}`, { cause });
  }
  return validateSnapshot(manifest);
}

/** Compare content and tree membership, including empty directories and link destinations. */
export function compareSnapshots(before, after) {
  validateSnapshot(before);
  validateSnapshot(after);
  if (JSON.stringify(before.exclusions) !== JSON.stringify(after.exclusions) || JSON.stringify(before.excludeBasenames) !== JSON.stringify(after.excludeBasenames)) throw new SnapshotError('SCOPE_CHANGED', 'Snapshot exclusions changed; preservation cannot be established.');
  const oldEntries = new Map(before.entries.map((entry) => [entry.path, entry]));
  const newEntries = new Map(after.entries.map((entry) => [entry.path, entry]));
  const changes = [];
  for (const path of [...new Set([...oldEntries.keys(), ...newEntries.keys()])].sort(compare)) {
    const oldEntry = oldEntries.get(path);
    const newEntry = newEntries.get(path);
    if (!oldEntry) changes.push({ path, change: 'added' });
    else if (!newEntry) changes.push({ path, change: 'removed' });
    else if (JSON.stringify(oldEntry) !== JSON.stringify(newEntry)) changes.push({ path, change: 'modified' });
  }
  return { preserved: changes.length === 0, before: before.digest, after: after.digest, changes };
}
