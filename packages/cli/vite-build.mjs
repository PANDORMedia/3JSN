import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { parse as parseHtml } from 'parse5';
import { compareSnapshots, snapshotTree } from '../../scripts/compatibility/snapshot.mjs';
import { BuildError, portablePath } from './contract.mjs';

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const within = (root, path) => {
  const rel = relative(root, path);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
const cancelled = signal => {
  if (signal?.aborted) throw new BuildError('CANCELLED', 'Vite build cancelled before publication.');
};

async function viteCli(root) {
  const require = createRequire(join(root, 'package.json'));
  let entry;
  try { entry = require.resolve('vite'); } catch (cause) {
    throw new BuildError('VITE_NOT_INSTALLED', 'Install Vite in this project or its workspace before using the Vite adapter.', { cause });
  }
  let directory = dirname(entry);
  while (within(root, directory) || directory !== dirname(directory)) {
    let manifest;
    try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); } catch { manifest = null; }
    if (manifest?.name === 'vite' && typeof manifest.bin?.vite === 'string') {
      const cli = resolve(directory, manifest.bin.vite);
      if (!within(directory, cli) || !(await lstat(cli)).isFile()) throw new BuildError('INVALID_VITE_INSTALL', 'The resolved Vite CLI is not a regular file inside its package.');
      return { cli, version: manifest.version };
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new BuildError('INVALID_VITE_INSTALL', 'The resolved Vite entry has no containing package manifest and CLI.');
}

async function sourceRoot(projectRoot) {
  let current = projectRoot;
  let workspace = projectRoot;
  while (true) {
    let declaresWorkspace = false;
    try {
      const manifest = JSON.parse(await readFile(join(current, 'package.json'), 'utf8'));
      const entries = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
      declaresWorkspace = Array.isArray(entries) && entries.some(value => typeof value === 'string');
    } catch {}
    if (!declaresWorkspace) {
      try { await lstat(join(current, 'pnpm-workspace.yaml')); declaresWorkspace = true; } catch {}
    }
    if (declaresWorkspace) workspace = current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return workspace;
}

async function sourceSnapshot(root, excluded) {
  if (!excluded) {
    excluded = ['node_modules'];
    async function findNested(current, prefix = '') {
      for (const name of await readdir(current)) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (name === 'node_modules') { excluded.push(path); continue; }
        const absolute = join(current, name);
        const stat = await lstat(absolute);
        if (stat.isDirectory()) await findNested(absolute, path);
      }
    }
    await findNested(root);
  }
  return snapshotTree(root, { exclude: excluded });
}

async function runVite(cli, root, outDir, signal) {
  cancelled(signal);
  const child = spawn(process.execPath, [cli, 'build', '--outDir', outDir, '--emptyOutDir', '--manifest', '.vite/manifest.json', '--sourcemap'], {
    cwd: root, windowsHide: true, stdio: 'inherit',
  });
  let abort;
  let killTimer;
  const onAbort = () => {
    abort = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await new Promise((resolveResult, reject) => {
      child.once('error', reject);
      child.once('close', (code, signalName) => resolveResult({ code, signal: signalName }));
    });
    if (abort || signal?.aborted) throw new BuildError('CANCELLED', 'Vite build was cancelled; no artifact report was published.');
    if (result.code !== 0) throw new BuildError('VITE_FAILED', `Vite exited with ${result.code === null ? result.signal : `status ${result.code}`}.`);
  } finally {
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function fileIdentity(path, root, relativePath) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile()) throw new BuildError('INVALID_VITE_OUTPUT', `Vite output must contain regular files only: ${relativePath}`);
  if (before.size > 128n * 1024n * 1024n) throw new BuildError('VITE_OUTPUT_LIMIT', `Vite output file exceeds 128 MiB: ${relativePath}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await lstat(path, { bigint: true });
  if (!after.isFile() || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) {
    throw new BuildError('VITE_OUTPUT_CHANGED', `Vite output changed while it was being inventoried: ${relativePath}`);
  }
  if (!within(root, resolve(path))) throw new BuildError('INVALID_VITE_OUTPUT', `Vite output escaped its staging directory: ${relativePath}`);
  return { path: relativePath, bytes: Number(after.size), sha256: hash.digest('hex') };
}

async function inventory(directory) {
  const files = [];
  async function walk(current, prefix = '') {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!portablePath(name)) throw new BuildError('INVALID_VITE_OUTPUT', `Vite emitted a non-portable path: ${name}`);
      const path = join(current, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new BuildError('INVALID_VITE_OUTPUT', `Vite emitted a symbolic link: ${name}`);
      if (stat.isDirectory()) await walk(path, name);
      else files.push(await fileIdentity(path, directory, name));
      if (files.length > 10_000) throw new BuildError('VITE_OUTPUT_LIMIT', 'Vite emitted more than 10,000 files.');
    }
  }
  await walk(directory);
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > 2 * 1024 * 1024 * 1024) throw new BuildError('VITE_OUTPUT_LIMIT', 'Vite output exceeds 2 GiB.');
  return files;
}

function graphFromManifest(manifest, filePaths) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new BuildError('INVALID_VITE_MANIFEST', 'Vite manifest must be a JSON object.');
  const records = Object.entries(manifest).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const keys = new Set(records.map(([key]) => key));
  const graph = records.map(([key, record]) => {
    if (!portablePath(key) || !record || typeof record !== 'object' || Array.isArray(record) || !portablePath(record.file)) {
      throw new BuildError('INVALID_VITE_MANIFEST', `Vite emitted an invalid manifest record: ${key}`);
    }
    const edge = (name, required = false) => {
      const value = record[name] ?? [];
      if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && portablePath(item))) {
        throw new BuildError('INVALID_VITE_MANIFEST', `Vite emitted invalid ${name} references for ${key}.`);
      }
      if (required) for (const path of value) if (!filePaths.has(path)) throw new BuildError('INVALID_VITE_MANIFEST', `Vite manifest references a missing output: ${path}`);
      return value;
    };
    if (!filePaths.has(record.file)) throw new BuildError('INVALID_VITE_MANIFEST', `Vite manifest references a missing output: ${record.file}`);
    const imports = edge('imports');
    const dynamicImports = edge('dynamicImports');
    for (const dependency of [...imports, ...dynamicImports]) {
      if (!keys.has(dependency)) throw new BuildError('INVALID_VITE_MANIFEST', `Vite manifest references an unknown module key: ${dependency}`);
    }
    return { key, file: record.file, isEntry: record.isEntry === true, isDynamicEntry: record.isDynamicEntry === true,
      imports, dynamicImports, css: edge('css', true), assets: edge('assets', true) };
  });
  return graph;
}

async function sourceMaps(root, files) {
  const maps = [];
  for (const file of files) {
    if (!file.path.endsWith('.map')) continue;
    let map;
    try { map = JSON.parse(await readFile(join(root, ...file.path.split('/')), 'utf8')); } catch (cause) {
      throw new BuildError('INVALID_SOURCE_MAP', `Vite emitted an invalid source map: ${file.path}`, { cause });
    }
    if (!map || map.version !== 3 || !Array.isArray(map.sources) || !map.sources.every(source => typeof source === 'string')) {
      throw new BuildError('INVALID_SOURCE_MAP', `Vite emitted an unsupported source map: ${file.path}`);
    }
    maps.push({ path: file.path, file: typeof map.file === 'string' ? map.file : null,
      sourceRoot: typeof map.sourceRoot === 'string' ? map.sourceRoot : null, sources: map.sources });
  }
  return maps;
}

async function documentReferences(root, files) {
  const documents = [];
  for (const file of files) {
    if (!file.path.endsWith('.html')) continue;
    const tree = parseHtml(await readFile(join(root, ...file.path.split('/')), 'utf8'));
    const references = [];
    const visit = node => {
      const attrs = new Map((node.attrs ?? []).map(({ name, value }) => [name, value]));
      for (const attribute of ['src', 'href', 'poster']) {
        const url = attrs.get(attribute);
        if (typeof url === 'string' && url) references.push({ element: node.tagName ?? '#document', attribute, url });
      }
      for (const child of node.childNodes ?? []) visit(child);
    };
    visit(tree);
    documents.push({ path: file.path, references });
  }
  return documents;
}

/** Run the selected project's Vite build and capture its generated client artifact graph without rewriting sources. */
export async function buildViteProject(options) {
  if (typeof options?.project !== 'string' || !options.project || typeof options?.out !== 'string' || !options.out) {
    throw new BuildError('USAGE', 'Vite project root and a new output directory are required.');
  }
  const projectPath = resolve(options.project);
  if (!(await lstat(projectPath)).isDirectory()) throw new BuildError('INVALID_PROJECT', 'The project must be a real directory, not a symbolic link.');
  const root = await realpath(projectPath);
  const measuredRoot = await sourceRoot(root);
  const outPath = resolve(options.out);
  const parent = await realpath(dirname(outPath));
  const out = join(parent, basename(outPath));
  if (!within(parent, out) || within(measuredRoot, out)) throw new BuildError('INVALID_OUTPUT', 'The output must be outside the project/workspace, and its parent must exist.');
  try { await lstat(out); throw new BuildError('OUTPUT_EXISTS', 'The output path already exists; no files were replaced.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!(await lstat(parent)).isDirectory()) throw new BuildError('INVALID_OUTPUT', 'The output parent must already exist.');

  let before;
  let exclusions;
  let staging;
  let reserved = false;
  try {
    before = await sourceSnapshot(measuredRoot);
    exclusions = before.exclusions.filter(path => path !== '.git');
    cancelled(options.signal);
    const vite = await viteCli(root);
    staging = await mkdtemp(join(parent, '.3jsn-vite-'));
    const emitted = join(staging, 'web');
    await runVite(vite.cli, root, emitted, options.signal);
    cancelled(options.signal);
    const files = await inventory(emitted);
    const filePaths = new Set(files.map(file => file.path));
    const manifestPath = '.vite/manifest.json';
    if (!filePaths.has(manifestPath)) throw new BuildError('INVALID_VITE_MANIFEST', 'Vite did not emit the requested .vite/manifest.json.');
    const manifest = JSON.parse(await readFile(join(emitted, ...manifestPath.split('/')), 'utf8'));
    const graph = graphFromManifest(manifest, filePaths);
    const maps = await sourceMaps(emitted, files);
    const html = await documentReferences(emitted, files);
    const after = await sourceSnapshot(measuredRoot, exclusions);
    const preservation = compareSnapshots(before, after);
    if (!preservation.preserved) throw new BuildError('SOURCE_CHANGED', 'The Vite build changed project/workspace files; its output was not published.');
    cancelled(options.signal);
    const report = { schemaVersion: 1, status: 'experimental', adapter: 'vite-client-artifact-graph-v1',
      project: { rootName: projectPath.split(sep).filter(Boolean).at(-1) ?? '.', sourceRootName: measuredRoot.split(sep).filter(Boolean).at(-1) ?? '.',
        relativeToSourceRoot: relative(measuredRoot, root).split(sep).join('/'), viteVersion: vite.version },
      executionBoundary: { status: 'unclassified', note: 'Vite configuration and plugins are trusted project code; this report does not identify or certify client/server boundaries.' },
      build: { command: ['vite', 'build', '--outDir', '<staging>/web', '--emptyOutDir', '--manifest', manifestPath, '--sourcemap'], configExecuted: true },
      source: { before, after, preservation }, manifest: { path: manifestPath, entries: graph }, files, documents: html, sourceMaps: maps };
    await writeFile(join(staging, 'build-report.json'), json(report), { flag: 'wx' });
    cancelled(options.signal);
    try { await mkdir(out); reserved = true; } catch (cause) {
      if (cause.code === 'EEXIST') throw new BuildError('OUTPUT_EXISTS', 'The output path appeared during the build; it was not replaced.', { cause });
      throw cause;
    }
    cancelled(options.signal);
    await rename(emitted, join(out, 'web'));
    cancelled(options.signal);
    await rename(join(staging, 'build-report.json'), join(out, 'build-report.json'));
    await rm(staging, { recursive: true, force: true });
    staging = undefined;
    return { status: 'experimental', output: out, web: join(out, 'web'), report: join(out, 'build-report.json'), sourcePreserved: true };
  } catch (cause) {
    if (reserved) await rm(out, { recursive: true, force: true }).catch(() => {});
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    let after = null;
    let preservation = null;
    if (before) {
      try {
        after = await sourceSnapshot(measuredRoot, exclusions);
        preservation = compareSnapshots(before, after);
      } catch {}
    }
    const error = cause instanceof BuildError ? cause : new BuildError('VITE_FAILED', cause.message, { cause });
    error.sourcePreserved = preservation?.preserved ?? null;
    if (before) error.source = { before, after, preservation };
    throw error;
  }
}
