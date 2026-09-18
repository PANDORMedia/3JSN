import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import * as esbuild from 'esbuild';
import { compareSnapshots, snapshotTree } from '../../scripts/compatibility/snapshot.mjs';
import { BuildError, hostTarget, LIMITATIONS, portablePath, PROFILE, readConfig, validateDescription, validateTargets } from './contract.mjs';

const execute = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const forward = path => path.split(sep).join('/');
const within = (root, path) => {
  const rel = relative(root, path);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
const exists = async path => {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const failure = error => ({ code: error.code ?? 'BUILD_FAILED', message: error.message });
const jsonBytes = value => `${JSON.stringify(value, null, 2)}\n`;
const checkCancellation = signal => {
  if (signal?.aborted) throw new BuildError('CANCELLED', 'Build cancelled; publication was not completed.');
};

async function fileIdentity(path) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile()) throw new BuildError('INVALID_FILE', `Expected a regular file: ${path}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await lstat(path, { bigint: true });
  if (!after.isFile() || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) {
    throw new BuildError('INPUT_CHANGED', `File changed while hashing: ${path}`);
  }
  if (after.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new BuildError('INVALID_FILE', 'File size exceeds supported safe integer range.');
  return { bytes: Number(after.size), sha256: hash.digest('hex') };
}

async function regularContainedEntry(root, path) {
  let current = root;
  const parts = path.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new BuildError('INVALID_ENTRY', 'The configured entry must be a regular contained file with no symbolic-link components.');
    }
  }
  if (!within(root, await realpath(current))) throw new BuildError('INVALID_ENTRY', 'Entry escapes the project root.');
  return current;
}

export async function describeRuntime(runtime, { signal } = {}) {
  let stdout;
  try {
    ({ stdout } = await execute(runtime, ['--describe'], { signal, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true }));
  } catch (cause) {
    checkCancellation(signal);
    throw new BuildError('RUNTIME_DESCRIBE_FAILED', 'The supplied player could not complete --describe within the output/time limit.', { cause });
  }
  try { return JSON.parse(stdout); } catch (cause) {
    throw new BuildError('INVALID_RUNTIME_DESCRIPTION', 'The supplied player --describe output is not JSON.', { cause });
  }
}

function inputLabel(root, path, identity) {
  if (within(root, path)) return `project/${forward(relative(root, path))}`;
  const parts = path.split(sep);
  return `dependencies/${identity.sha256.slice(0, 16)}/${parts.slice(parts.lastIndexOf('node_modules') + 1).join('/')}`;
}

async function bundle(root, entry, staging) {
  const loaded = new Map();
  let loadError;
  let result;
  const outfile = join(staging, 'app', 'main.mjs');
  try {
    result = await esbuild.build({
      absWorkingDir: root, entryPoints: [entry], outfile, bundle: true, platform: 'browser', format: 'esm',
      target: 'esnext', sourcemap: 'linked', sourcesContent: true, metafile: true, write: false,
      logLevel: 'silent', tsconfigRaw: {},
      plugins: [{ name: 'measured-inputs', setup(build) {
        build.onLoad({ filter: /.*/, namespace: 'file' }, async args => {
          try {
            const path = await realpath(args.path);
            if (!within(root, path) && !path.split(sep).includes('node_modules')) {
              throw new BuildError('EXTERNAL_SOURCE', 'A bundled source import escapes the project outside node_modules.');
            }
            const loader = { '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.tsx': 'tsx', '.json': 'json' }[extname(path)];
            if (!loader) throw new BuildError('UNSUPPORTED_INPUT', `Only bundled JavaScript, TypeScript and JSON inputs are supported: ${basename(path)}`);
            const contents = await readFile(path);
            const identity = { bytes: contents.length, sha256: digest(contents) };
            loaded.set(path, { path: inputLabel(root, path, identity), ...identity });
            return { contents, loader, resolveDir: dirname(path) };
          } catch (error) { loadError ??= error; throw error; }
        });
      } }],
    });
  } catch (cause) {
    const details = cause.errors?.slice(0, 5).map(item => `${item.location ? `${item.location.file}:${item.location.line}: ` : ''}${item.text}`).join('; ');
    throw loadError ?? new BuildError('BUNDLE_FAILED', `esbuild could not bundle the entry.${details ? ` ${details}` : ''}`, { cause });
  }
  if (result.warnings.length) throw new BuildError('BUNDLE_WARNING', `esbuild emitted warnings: ${result.warnings.map(item => item.text).join('; ')}`);
  if (Object.values(result.metafile.outputs).some(output => output.imports.some(item => item.external))) {
    throw new BuildError('EXTERNAL_IMPORT', 'The bundle retains an external import that the packaged player cannot resolve.');
  }
  for (const [path, before] of loaded) {
    const after = await fileIdentity(path);
    if (after.sha256 !== before.sha256 || after.bytes !== before.bytes) throw new BuildError('INPUT_CHANGED', 'A bundled input changed during bundling.');
  }
  const expected = new Set([outfile, `${outfile}.map`]);
  if (result.outputFiles.length !== 2 || result.outputFiles.some(item => !expected.has(item.path))) {
    throw new BuildError('UNSUPPORTED_OUTPUT', 'This profile permits only app/main.mjs and its source map.');
  }
  const files = [];
  const outputIdentities = [];
  await mkdir(join(staging, 'app'));
  for (const output of result.outputFiles) {
    let bytes = output.contents;
    if (output.path.endsWith('.map')) {
      const map = JSON.parse(output.text);
      map.sources = await Promise.all(map.sources.map(async source => {
        let path;
        try { path = await realpath(resolve(dirname(outfile), source)); } catch (cause) {
          throw new BuildError('UNSUPPORTED_SOURCE_MAP', 'An input source-map chain refers to an original source outside measured bundler inputs.', { cause });
        }
        const identity = loaded.get(path);
        if (!identity) throw new BuildError('UNSUPPORTED_SOURCE_MAP', 'An input source-map chain refers to an original source outside measured bundler inputs.');
        return `3jsn-source:///${identity.path.split('/').map(encodeURIComponent).join('/')}`;
      }));
      delete map.sourceRoot;
      bytes = Buffer.from(JSON.stringify(map));
    }
    const path = forward(relative(staging, output.path));
    if (!portablePath(path) || !path.startsWith('app/')) throw new BuildError('INVALID_OUTPUT', 'Bundler output escapes app/.');
    const identity = { path, bytes: bytes.length, sha256: digest(bytes) };
    await writeFile(output.path, bytes, { flag: 'wx' });
    files.push(identity);
    outputIdentities.push({ ...identity, esbuildSha256: digest(output.contents) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(files.map(item => item.path.toLowerCase())).size !== files.length) throw new BuildError('OUTPUT_COLLISION', 'Output paths collide when case folded.');
  return { files, loaded, metadata: { version: esbuild.version, options: { platform: 'browser', format: 'esm', target: 'esnext', sourcemap: 'linked', tsconfigRaw: {} },
    inputs: [...loaded.values()].sort((a, b) => a.path.localeCompare(b.path)), outputs: outputIdentities,
    metafile: result.metafile, metafileScope: 'Original esbuild provenance includes build-location paths and pre-source-label-rewrite output sizes; it is not a complete or hermetic resolution inventory.' } };
}

/** Build a trusted, quiescent project; inspect only an explicitly supplied player executable. */
export async function buildProject(options, { describeRuntime: describe = describeRuntime } = {}) {
  const target = hostTarget();
  validateTargets(options.targets, target);
  if (options.experimental !== true) throw new BuildError('EXPERIMENTAL_REQUIRED', 'Pass --experimental to acknowledge the bounded native-window-v1 profile.');
  if (![options.project, options.runtime, options.out].every(value => typeof value === 'string' && value)) throw new BuildError('USAGE', 'Project, runtime and output paths are required.');
  const { signal } = options;
  checkCancellation(signal);
  const projectPath = resolve(options.project);
  if (!(await lstat(projectPath)).isDirectory()) throw new BuildError('INVALID_PROJECT', 'The project must be a real directory, not a symbolic link.');
  const root = await realpath(projectPath);
  const outputPath = resolve(options.out);
  const parent = await realpath(dirname(outputPath));
  const out = join(parent, basename(outputPath));
  if (within(root, out)) throw new BuildError('INVALID_OUTPUT', 'The output directory must be outside the project, including through symbolic-link aliases.');
  if (await exists(out)) throw new BuildError('OUTPUT_EXISTS', 'The output path already exists; no files were replaced.');
  if (!(await lstat(parent)).isDirectory()) throw new BuildError('INVALID_OUTPUT', 'The output parent must already be a directory.');
  const runtime = resolve(options.runtime);
  let before, after, preservation, staging, reserved = false;
  const published = [];
  let primary;
  try {
    before = await snapshotTree(root, { exclude: ['node_modules'] });
    checkCancellation(signal);
    const config = await readConfig(join(root, '3jsn.json'));
    const entry = await regularContainedEntry(root, config.entry);
    const runtimeBefore = await fileIdentity(runtime);
    checkCancellation(signal);
    const description = validateDescription(await describe(runtime, { signal }), target);
    checkCancellation(signal);
    const runtimeAfter = await fileIdentity(runtime);
    if (JSON.stringify(runtimeBefore) !== JSON.stringify(runtimeAfter)) throw new BuildError('RUNTIME_CHANGED', 'The supplied player changed during inspection.');
    staging = await mkdtemp(join(parent, '.3jsn-build-'));
    checkCancellation(signal);
    const built = await bundle(root, entry, staging);
    checkCancellation(signal);
    const executable = `${config.name}${process.platform === 'win32' ? '.exe' : ''}`;
    await copyFile(runtime, join(staging, executable), constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') await chmod(join(staging, executable), 0o755);
    const copiedRuntime = await fileIdentity(join(staging, executable));
    checkCancellation(signal);
    if (JSON.stringify(copiedRuntime) !== JSON.stringify(runtimeBefore)) throw new BuildError('RUNTIME_CHANGED', 'The copied player differs from the inspected binary.');
    const manifest = { schemaVersion: 1, profile: PROFILE, name: config.name, target, entry: 'app/main.mjs', files: built.files };
    const manifestBytes = jsonBytes(manifest);
    if (Buffer.byteLength(manifestBytes) > 1024 * 1024 || manifest.files.length > 4096) throw new BuildError('MANIFEST_LIMIT', 'Package manifest exceeds version 1 limits.');
    after = await snapshotTree(root, { exclude: ['node_modules'] });
    preservation = compareSnapshots(before, after);
    checkCancellation(signal);
    if (!preservation.preserved) throw new BuildError('SOURCE_CHANGED', 'Project source changed during the build; the output was not published.');
    for (const [path, initial] of built.loaded) {
      const final = await fileIdentity(path);
      checkCancellation(signal);
      if (final.sha256 !== initial.sha256 || final.bytes !== initial.bytes) throw new BuildError('INPUT_CHANGED', 'A bundled dependency changed before publication.');
    }
    const metadata = { schemaVersion: 1, status: 'experimental', profile: PROFILE, target,
      compatibility: { certified: false, unresolvedDynamicBehavior: true, limitations: LIMITATIONS },
      config, runtime: { executable, ...copiedRuntime, description },
      source: { before, after, preservation }, esbuild: built.metadata,
      manifest: { bytes: Buffer.byteLength(manifestBytes), sha256: digest(manifestBytes) } };
    await mkdir(join(staging, 'metadata'));
    await writeFile(join(staging, 'metadata', 'build.json'), jsonBytes(metadata), { flag: 'wx' });
    await writeFile(join(staging, 'app.json'), manifestBytes, { flag: 'wx' });
    checkCancellation(signal);
    try { await mkdir(out); } catch (cause) {
      if (cause.code === 'EEXIST') throw new BuildError('OUTPUT_EXISTS', 'The output path appeared during the build; it was not replaced.', { cause });
      throw cause;
    }
    reserved = true;
    // The manifest is the readiness marker; never expose it before all packaged bytes exist.
    for (const name of ['app', 'metadata', executable, 'app.json']) {
      checkCancellation(signal);
      await rename(join(staging, name), join(out, name));
      published.push(name);
      checkCancellation(signal);
    }
    await rmdir(staging);
    staging = undefined;
    return { status: 'experimental', target, profile: PROFILE, output: out, executable: join(out, executable), manifest: join(out, 'app.json'), metadata: join(out, 'metadata', 'build.json'), sourcePreserved: true };
  } catch (error) {
    primary = error;
  }
  const cleanupErrors = [];
  if (reserved) {
    for (const name of published.reverse()) {
      try { await rm(join(out, name), { recursive: true, force: true }); } catch (error) { cleanupErrors.push(failure(error)); }
    }
    try { await rmdir(out); } catch (error) { cleanupErrors.push(failure(error)); }
  }
  if (staging) {
    try { await rm(staging, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(failure(error)); }
  }
  let snapshotError;
  if (before) {
    after = undefined;
    preservation = undefined;
    try { after = await snapshotTree(root, { exclude: ['node_modules'] }); preservation = compareSnapshots(before, after); } catch (error) { snapshotError = failure(error); }
  }
  const error = primary instanceof BuildError ? primary : new BuildError(primary.code ?? 'BUILD_FAILED', primary.message, { cause: primary });
  if (before) {
    const receipt = { schemaVersion: 1, status: 'failed', target, profile: PROFILE, error: failure(error),
      source: { before, after: after ?? null, preservation: preservation ?? null, snapshotError: snapshotError ?? null }, cleanupErrors };
    try {
      const directory = await mkdtemp(join(parent, '.3jsn-failure-'));
      error.receipt = join(directory, 'build.json');
      await writeFile(error.receipt, jsonBytes(receipt), { flag: 'wx', mode: 0o600 });
    } catch (cause) { error.receiptError = failure(cause); }
  }
  error.sourcePreserved = preservation?.preserved ?? null;
  if (cleanupErrors.length) error.cleanupErrors = cleanupErrors;
  throw error;
}
