import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
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

export async function sourceRoot(projectRoot) {
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

export async function sourceSnapshot(root, excluded) {
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

async function runVite(cli, root, outDir, signal, base) {
  cancelled(signal);
  const args = [cli, 'build', '--outDir', outDir, '--emptyOutDir', '--manifest', '.vite/manifest.json', '--sourcemap'];
  if (base !== undefined) args.push('--base', base);
  const child = spawn(process.execPath, args, {
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

export async function captureViteArtifacts({ project, outputDirectory, signal, base }) {
  if (typeof project !== 'string' || !project || typeof outputDirectory !== 'string' || !outputDirectory) {
    throw new BuildError('USAGE', 'Vite project root and an output directory are required.');
  }
  const projectPath = resolve(project);
  if (!(await lstat(projectPath)).isDirectory()) throw new BuildError('INVALID_PROJECT', 'The project must be a real directory, not a symbolic link.');
  const root = await realpath(projectPath);
  const output = resolve(outputDirectory);
  if (within(root, output)) throw new BuildError('INVALID_OUTPUT', 'Vite staging output must be outside the project directory.');
  if (!(await lstat(output)).isDirectory()) throw new BuildError('INVALID_OUTPUT', 'Vite staging output must be an existing directory.');
  cancelled(signal);
  const vite = await viteCli(root);
  await runVite(vite.cli, root, output, signal, base);
  cancelled(signal);
  const files = await inventory(output);
  const filePaths = new Set(files.map(file => file.path));
  const manifestPath = '.vite/manifest.json';
  if (!filePaths.has(manifestPath)) throw new BuildError('INVALID_VITE_MANIFEST', 'Vite did not emit the requested .vite/manifest.json.');
  let manifest;
  try { manifest = JSON.parse(await readFile(join(output, ...manifestPath.split('/')), 'utf8')); } catch (cause) {
    throw new BuildError('INVALID_VITE_MANIFEST', 'Vite emitted an invalid JSON manifest.', { cause });
  }
  const graph = graphFromManifest(manifest, filePaths);
  const maps = await sourceMaps(output, files);
  const html = await documentReferences(output, files);
  return { root, output, viteVersion: vite.version, manifestPath, manifest, graph, files, sourceMaps: maps, documents: html };
}

function visitHtml(node, visit) {
  visit(node);
  for (const child of node.childNodes ?? []) visitHtml(child, visit);
}

function outputReference(htmlPath, value) {
  if (typeof value !== 'string' || !value || /[%?#\\:\s\p{Cc}]/u.test(value) || value.startsWith('/')) return undefined;
  const path = posix.normalize(posix.join(posix.dirname(htmlPath), value));
  return portablePath(path) ? path : undefined;
}

export function normalizeViteHtml(bytes, { htmlPath, allowedScripts, allowedModulePreloads, allowedStylesheets = new Set(),
  rewriteStylesheets = true }) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch (cause) {
    throw new BuildError('INVALID_VITE_HTML', 'Vite emitted HTML that is not valid UTF-8.', { cause });
  }
  const errors = [];
  const tree = parseHtml(source, { sourceCodeLocationInfo: true, scriptingEnabled: true, onParseError: error => errors.push(error) });
  if (errors.length) throw new BuildError('INVALID_VITE_HTML', `Vite emitted HTML with parse error ${errors[0].code}.`);
  const edits = [];
  const linkedStylesheets = new Set();
  visitHtml(tree, node => {
    if (node.tagName === 'link') {
      const attrs = new Map((node.attrs ?? []).map(({ name, value }) => [name, value]));
      const location = node.sourceCodeLocation;
      if (!location) throw new BuildError('INVALID_VITE_HTML', 'Generated link has no source location.');
      if ((attrs.get('rel') ?? '').toLowerCase() === 'modulepreload') {
        const href = outputReference(htmlPath, attrs.get('href'));
        if (!href || !allowedModulePreloads.has(href)) {
          throw new BuildError('INVALID_VITE_GRAPH', 'Vite modulepreload link is not present in its static JavaScript graph.');
        }
        edits.push({ start: location.startOffset, end: location.endOffset, text: '' });
      } else if ((attrs.get('rel') ?? '').toLowerCase() === 'stylesheet') {
        const href = outputReference(htmlPath, attrs.get('href'));
        if (!href || !allowedStylesheets.has(href) || (attrs.get('type') && attrs.get('type').toLowerCase() !== 'text/css')) {
          throw new BuildError('INVALID_VITE_GRAPH', 'Vite stylesheet link is not present in its CSS output graph.');
        }
        if (linkedStylesheets.has(href)) throw new BuildError('INVALID_VITE_HTML', `Vite generated a duplicate stylesheet link: ${href}`);
        linkedStylesheets.add(href);
        const hrefLocation = location.attrs?.href;
        if (!hrefLocation) throw new BuildError('INVALID_VITE_HTML', 'Vite stylesheet link has no source location.');
        if (rewriteStylesheets) edits.push({ start: hrefLocation.startOffset, end: hrefLocation.endOffset, text: `href="./vite/${href}"` });
        for (const attribute of ['crossorigin', 'integrity']) {
          const attributeLocation = location.attrs?.[attribute];
          if (attributeLocation) edits.push({ start: attributeLocation.startOffset, end: attributeLocation.endOffset, text: '' });
        }
      } else {
        throw new BuildError('UNSUPPORTED_VITE_HTML', 'Only Vite modulepreload and stylesheet links are supported in generated HTML.');
      }
    }
    if (node.tagName === 'script') {
      const attrs = new Map((node.attrs ?? []).map(({ name, value }) => [name, value]));
      const src = outputReference(htmlPath, attrs.get('src'));
      if (attrs.get('type')?.toLowerCase() !== 'module' || !src || !allowedScripts.has(src)) {
        throw new BuildError('INVALID_VITE_GRAPH', 'Generated HTML must reference a JavaScript entry in the admitted Vite graph.');
      }
      for (const attribute of ['crossorigin', 'integrity']) {
        const location = node.sourceCodeLocation?.attrs?.[attribute];
        if (location) edits.push({ start: location.startOffset, end: location.endOffset, text: '' });
      }
    }
  });
  let normalized = source;
  let boundary = source.length;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (edit.end > boundary) throw new BuildError('INVALID_VITE_HTML', 'Generated HTML normalization edits overlap.');
    normalized = normalized.slice(0, edit.start) + edit.text + normalized.slice(edit.end);
    boundary = edit.start;
  }
  if (linkedStylesheets.size !== allowedStylesheets.size || [...allowedStylesheets].some(path => !linkedStylesheets.has(path))) {
    throw new BuildError('INVALID_VITE_GRAPH', 'Generated HTML does not link every stylesheet in the selected Vite CSS graph.');
  }
  return Buffer.from(normalized);
}

export function validateViteDomGraph(artifacts, htmlEntry, { webFonts = false } = {}) {
  const htmlEntries = artifacts.graph.filter(item => item.key.endsWith('.html'));
  if (htmlEntries.length !== 1 || htmlEntries[0].key !== htmlEntry || !htmlEntries[0].isEntry) {
    throw new BuildError('UNSUPPORTED_VITE_GRAPH', 'dom-window-v1 Vite packaging requires one HTML entry matching 3jsn.json entry.');
  }
  const htmlRecord = htmlEntries[0];
  if (!artifacts.files.some(file => file.path === htmlEntry) || !htmlRecord.file.endsWith('.js')) {
    throw new BuildError('UNSUPPORTED_VITE_GRAPH', 'Vite must emit the configured HTML document and one associated JavaScript entry.');
  }
  const byKey = new Map(artifacts.graph.map(item => [item.key, item]));
  const jsFiles = new Set([htmlRecord.file]);
  const assetFiles = new Set(webFonts ? htmlRecord.assets : []);
  const visited = new Map();
  const visit = item => {
    if (visited.has(item.key)) return;
    visited.set(item.key, item);
    if (item.dynamicImports.length || (item.assets.length && (item !== htmlRecord || !webFonts))) {
      throw new BuildError('UNSUPPORTED_VITE_GRAPH', `Vite entry ${item.key} includes dynamic imports or asset graph edges outside this package profile.`);
    }
    for (const key of item.imports) {
      const dependency = byKey.get(key);
      if (!dependency || !dependency.file.endsWith('.js') || dependency.isDynamicEntry) {
        throw new BuildError('UNSUPPORTED_VITE_GRAPH', `Vite static import ${key} is not a JavaScript chunk.`);
      }
      jsFiles.add(dependency.file);
      visit(dependency);
    }
  };
  visit(htmlRecord);
  const fontRecords = webFonts ? artifacts.graph.filter(item => /\.(?:ttf|otf|woff|woff2)$/i.test(item.file)) : [];
  for (const item of fontRecords) assetFiles.add(item.file);
  const graphChunks = artifacts.graph.filter(item => item !== htmlRecord && !fontRecords.includes(item));
  if (graphChunks.some(item => !jsFiles.has(item.file)) || graphChunks.length !== visited.size - 1) {
    throw new BuildError('UNSUPPORTED_VITE_GRAPH', 'Vite emitted JavaScript outside the selected HTML entry graph.');
  }
  const cssFiles = new Set();
  for (const item of visited.values()) for (const file of item.css) {
    if (!file.endsWith('.css') || !artifacts.files.some(output => output.path === file)) {
      throw new BuildError('UNSUPPORTED_VITE_GRAPH', `Vite CSS edge is not a regular emitted stylesheet: ${file}.`);
    }
    cssFiles.add(file);
  }
  const fontFiles = new Set();
  for (const path of assetFiles) {
    if (!artifacts.files.some(output => output.path === path) || !/\.(?:ttf|otf|woff|woff2)$/i.test(path)) {
      throw new BuildError('UNSUPPORTED_VITE_GRAPH', `Vite emitted a non-font resource edge outside this package profile: ${path}.`);
    }
    fontFiles.add(path);
  }
  const unexpectedFiles = artifacts.files.filter(file => ![htmlRecord.file, artifacts.manifestPath].includes(file.path)
    && file.path !== htmlEntry && !file.path.endsWith('.map') && !jsFiles.has(file.path) && !cssFiles.has(file.path)
    && !fontFiles.has(file.path));
  if (unexpectedFiles.length) throw new BuildError('UNSUPPORTED_VITE_GRAPH', `Vite emitted unsupported files: ${unexpectedFiles.slice(0, 4).map(file => file.path).join(', ')}.`);
  return { htmlFile: htmlEntry, entryScript: htmlRecord.file, jsFiles, modulePreloads: jsFiles, cssFiles, fontFiles };
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
  const published = [];
  try {
    before = await sourceSnapshot(measuredRoot);
    exclusions = before.exclusions.filter(path => path !== '.git');
    cancelled(options.signal);
    staging = await mkdtemp(join(parent, '.3jsn-vite-'));
    const emitted = join(staging, 'web');
    await mkdir(emitted);
    const artifacts = await captureViteArtifacts({ project: root, outputDirectory: emitted, signal: options.signal });
    const { viteVersion, manifestPath, graph, files, sourceMaps: maps, documents: html } = artifacts;
    const after = await sourceSnapshot(measuredRoot, exclusions);
    const preservation = compareSnapshots(before, after);
    if (!preservation.preserved) throw new BuildError('SOURCE_CHANGED', 'The Vite build changed project/workspace files; its output was not published.');
    cancelled(options.signal);
    const report = { schemaVersion: 1, status: 'experimental', adapter: 'vite-client-artifact-graph-v1',
      project: { rootName: projectPath.split(sep).filter(Boolean).at(-1) ?? '.', sourceRootName: measuredRoot.split(sep).filter(Boolean).at(-1) ?? '.',
        relativeToSourceRoot: relative(measuredRoot, root).split(sep).join('/'), viteVersion },
      executionBoundary: { status: 'unclassified', note: 'Vite configuration and plugins are trusted project code; this report does not identify or certify client/server boundaries.' },
      build: { command: ['vite', 'build', '--outDir', '<staging>/web', '--emptyOutDir', '--manifest', manifestPath, '--sourcemap'], configExecuted: true },
      source: { before, after, preservation }, manifest: { path: manifestPath, entries: graph }, files,
      documents: { urlAttributes: ['src', 'href', 'poster'], files: html }, sourceMaps: maps };
    await writeFile(join(staging, 'build-report.json'), json(report), { flag: 'wx' });
    cancelled(options.signal);
    try { await mkdir(out); reserved = true; } catch (cause) {
      if (cause.code === 'EEXIST') throw new BuildError('OUTPUT_EXISTS', 'The output path appeared during the build; it was not replaced.', { cause });
      throw cause;
    }
    cancelled(options.signal);
    await rename(emitted, join(out, 'web'));
    published.push('web');
    cancelled(options.signal);
    await rename(join(staging, 'build-report.json'), join(out, 'build-report.json'));
    published.push('build-report.json');
    await rm(staging, { recursive: true, force: true });
    staging = undefined;
    return { status: 'experimental', output: out, web: join(out, 'web'), report: join(out, 'build-report.json'), sourcePreserved: true };
  } catch (cause) {
    if (reserved) {
      for (const name of published.reverse()) await rm(join(out, name), { recursive: true, force: true }).catch(() => {});
      await rmdir(out).catch(() => {});
    }
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
