import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as esbuild from 'esbuild';
import { compareSnapshots, snapshotTree } from '../../scripts/compatibility/snapshot.mjs';
import { BuildError, DOM_PROFILE, hostTarget, limitationsFor, portablePath, readConfig, validateDescription, validateProfileTarget, validateTargets } from './contract.mjs';
import { analyzeHtml, prepareHtml, renderHtml, validatePackagedStylesheet } from './html.mjs';
import { localizeWebFonts } from './web-fonts.mjs';
import { validateWebFontRequirements, validateWebFontRuntime, WEB_FONT_CAPABILITY } from './web-font-policy.mjs';
import { captureViteArtifacts, normalizeViteHtml, sourceRoot as viteSourceRoot,
  sourceSnapshot as viteSourceSnapshot, validateViteDomGraph, validateViteFontJavaScriptReferences } from './vite-build.mjs';

const execute = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const PACKAGE_ASSETS_CAPABILITY = 'package-assets-v1';
const DOM_STYLESHEET_CAPABILITY = 'dom-package-stylesheets-v1';
const DOM_STYLESHEET_LIMITS = Object.freeze({ count: 64, bytes: 1024 * 1024, totalBytes: 64 * 1024 * 1024 });
const IMAGE_RESOURCE_LIMITS = Object.freeze({ count: 64, bytes: 32 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 });
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp']);
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

async function inspectFont(value) {
  if (typeof value !== 'string' || !value) throw new BuildError('FONT_REQUIRED', 'dom-window-v1 requires an explicit --font <font.woff2>.');
  const path = resolve(value);
  if (extname(path).toLowerCase() !== '.woff2') throw new BuildError('INVALID_FONT', 'The explicit font must be a regular .woff2 file.');
  const before = await fileIdentity(path);
  const bytes = await readFile(path);
  if (bytes.length < 48 || bytes.toString('ascii', 0, 4) !== 'wOF2' || bytes.readUInt32BE(8) !== bytes.length) {
    throw new BuildError('INVALID_FONT', 'The font must have a WOFF2 header whose declared length matches the file.');
  }
  if (bytes.length !== before.bytes || digest(bytes) !== before.sha256) throw new BuildError('FONT_CHANGED', 'The font changed during inspection.');
  return { path, before };
}

async function verifyFont(font) {
  font.after = undefined;
  font.preserved = null;
  const after = await fileIdentity(font.path);
  font.after = after;
  font.preserved = after.bytes === font.before.bytes && after.sha256 === font.before.sha256;
  if (!font.preserved) throw new BuildError('FONT_CHANGED', 'The explicit font changed during the build.');
}

const fontMetadata = font => ({ sourceName: basename(font.path), packagedPath: 'app/font.woff2',
  before: font.before, copied: font.copied ?? null, after: font.after ?? null, preserved: font.preserved ?? null });

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

function inputLabel(root, path, identity, generatedRoot) {
  if (within(root, path)) return `project/${forward(relative(root, path))}`;
  if (generatedRoot && within(generatedRoot, path)) return `vite-output/${forward(relative(generatedRoot, path))}`;
  const parts = path.split(sep);
  return `dependencies/${identity.sha256.slice(0, 16)}/${parts.slice(parts.lastIndexOf('node_modules') + 1).join('/')}`;
}

async function viteSourceMapInputs(outputRoot, maps, sourceRoot, projectRoot) {
  const inputs = new Map();
  const dependencyRoots = [];
  for (let current = projectRoot; ; current = dirname(current)) {
    try { dependencyRoots.push(await realpath(join(current, 'node_modules'))); } catch {}
    if (current === dirname(current)) break;
  }
  for (const record of maps) {
    const mapPath = join(outputRoot, ...record.path.split('/'));
    let map;
    try { map = JSON.parse(await readFile(mapPath, 'utf8')); } catch (cause) {
      throw new BuildError('INVALID_SOURCE_MAP', `Cannot read Vite source map ${record.path}.`, { cause });
    }
    for (const [index, source] of map.sources.entries()) {
      let candidate;
      try {
        candidate = source.startsWith('file:') ? fileURLToPath(source)
          : resolve(dirname(mapPath), map.sourceRoot ?? '', source);
      } catch (cause) { throw new BuildError('UNSUPPORTED_SOURCE_MAP', `Vite source map contains an unsupported source: ${source}.`, { cause }); }
      let path;
      try { path = await realpath(candidate); } catch (cause) {
        throw new BuildError('UNSUPPORTED_SOURCE_MAP', `Vite source map refers to a missing source: ${source}.`, { cause });
      }
      if (!within(sourceRoot, path) && !dependencyRoots.some(dependencyRoot => within(dependencyRoot, path))) {
        throw new BuildError('UNSUPPORTED_SOURCE_MAP', 'Vite source maps may reference only measured project/workspace files and installed dependencies.');
      }
      const identity = await fileIdentity(path);
      const content = map.sourcesContent?.[index];
      if (typeof content === 'string' && digest(Buffer.from(content)) !== identity.sha256) {
        throw new BuildError('VITE_SOURCE_CHANGED', `Vite source-map content differs from the measured source: ${source}.`);
      }
      inputs.set(path, { path, ...identity });
    }
  }
  return [...inputs.values()];
}

async function bundle(root, entry, staging, { allowImageResources, labelRoot = root, generatedRoot, additionalInputs = [] }) {
  const loaded = new Map();
  const imageInputs = new Set();
  for (const item of additionalInputs) loaded.set(item.path, { path: inputLabel(labelRoot, item.path, item, generatedRoot), bytes: item.bytes, sha256: item.sha256 });
  let loadError;
  let result;
  const outfile = join(staging, 'app', 'main.mjs');
  try {
    result = await esbuild.build({
      absWorkingDir: root, entryPoints: [entry], outdir: dirname(outfile), entryNames: 'main',
      assetNames: 'assets/[name]-[hash]', outExtension: { '.js': '.mjs' }, bundle: true, platform: 'browser', format: 'esm',
      target: 'esnext', sourcemap: 'linked', sourcesContent: true, metafile: true, write: false,
      logLevel: 'silent', tsconfigRaw: {},
      plugins: [{ name: 'measured-inputs', setup(build) {
        build.onLoad({ filter: /.*/, namespace: 'file' }, async args => {
          try {
            const path = await realpath(args.path);
            if (!within(root, path) && !path.split(sep).includes('node_modules')) {
              throw new BuildError('EXTERNAL_SOURCE', 'A bundled source import escapes the project outside node_modules.');
            }
            const extension = extname(path).toLowerCase();
            const image = IMAGE_EXTENSIONS.has(extension);
            if (image && !allowImageResources) throw new BuildError('UNSUPPORTED_INPUT', 'Raster image imports are supported only by the native-window-v1 profile.');
            const loader = image ? 'file' : { '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.tsx': 'tsx', '.json': 'json' }[extension];
            if (!loader) throw new BuildError('UNSUPPORTED_INPUT', `Only bundled JavaScript, TypeScript and JSON inputs are supported: ${basename(path)}`);
            const contents = await readFile(path);
            const identity = { bytes: contents.length, sha256: digest(contents) };
            loaded.set(path, { path: inputLabel(labelRoot, path, identity, generatedRoot), ...identity });
            if (image) imageInputs.add(path);
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
  const imageOutputs = result.outputFiles.filter(item => IMAGE_EXTENSIONS.has(extname(item.path).toLowerCase()));
  const expected = new Set([outfile, `${outfile}.map`, ...imageOutputs.map(item => item.path)]);
  if (result.outputFiles.length !== expected.size || result.outputFiles.some(item => !expected.has(item.path))
    || imageInputs.size && !imageOutputs.length) {
    throw new BuildError('UNSUPPORTED_OUTPUT', 'The build emitted an output outside the entry, source map and supported image assets.');
  }
  let imageBytes = 0;
  if (imageOutputs.length > IMAGE_RESOURCE_LIMITS.count) throw new BuildError('RESOURCE_LIMIT', 'Image resource count exceeds the package limit.');
  for (const output of imageOutputs) {
    if (output.contents.length > IMAGE_RESOURCE_LIMITS.bytes || (imageBytes += output.contents.length) > IMAGE_RESOURCE_LIMITS.totalBytes) {
      throw new BuildError('RESOURCE_LIMIT', `Generated image resources exceed package limits: ${basename(output.path)}`);
    }
  }
  const files = [];
  const resources = [];
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
    await mkdir(dirname(output.path), { recursive: true });
    await writeFile(output.path, bytes, { flag: 'wx' });
    files.push(identity);
    if (IMAGE_EXTENSIONS.has(extname(output.path).toLowerCase())) resources.push({ path, kind: 'image' });
    outputIdentities.push({ ...identity, esbuildSha256: digest(output.contents) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  resources.sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(files.map(item => item.path.toLowerCase())).size !== files.length) throw new BuildError('OUTPUT_COLLISION', 'Output paths collide when case folded.');
  return { files, resources, loaded, metadata: { version: esbuild.version, options: { platform: 'browser', format: 'esm', target: 'esnext', sourcemap: 'linked', assetNames: 'assets/[name]-[hash]', tsconfigRaw: {} },
    inputs: [...loaded.values()].sort((a, b) => a.path.localeCompare(b.path)), outputs: outputIdentities,
    metafile: result.metafile, metafileScope: 'Original esbuild provenance includes build-location paths and pre-source-label-rewrite output sizes; it is not a complete or hermetic resolution inventory.' } };
}

/** Build a trusted, quiescent project; inspect only an explicitly supplied player executable. */
export async function buildProject(options, { describeRuntime: describe = describeRuntime, fetchImpl = globalThis.fetch,
  fontPolicy = validateWebFontRequirements } = {}) {
  const target = hostTarget();
  validateTargets(options.targets, target);
  if (options.experimental !== true) throw new BuildError('EXPERIMENTAL_REQUIRED', 'Pass --experimental to acknowledge the bounded experimental build profile.');
  if (![options.project, options.runtime, options.out].every(value => typeof value === 'string' && value)) throw new BuildError('USAGE', 'Project, runtime and output paths are required.');
  if (options.frontend !== undefined && options.frontend !== 'vite') throw new BuildError('USAGE', 'The only supported --frontend value is vite.');
  const useVite = options.frontend === 'vite';
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
  let before, after, preservation, staging, config, font, webFonts, viteArtifacts, viteOutput, viteSummary,
    snapshotRoot = root, snapshotExclusions, reserved = false;
  const published = [];
  let primary;
  try {
    if (useVite) {
      snapshotRoot = await viteSourceRoot(root);
      if (within(snapshotRoot, out)) throw new BuildError('INVALID_OUTPUT', 'Vite package output must be outside the detected project workspace.');
      before = await viteSourceSnapshot(snapshotRoot);
      snapshotExclusions = before.exclusions.filter(path => path !== '.git');
    } else before = await snapshotTree(root, { exclude: ['node_modules'] });
    checkCancellation(signal);
    config = await readConfig(join(root, '3jsn.json'));
    validateProfileTarget(config.profile, target);
    const isDom = config.profile === DOM_PROFILE;
    if (useVite && !isDom) throw new BuildError('UNSUPPORTED_FRONTEND', 'The Vite frontend adapter currently requires dom-window-v1 and an HTML entry.');
    if (Object.hasOwn(options, 'bundleWebFonts') && options.bundleWebFonts !== true) throw new BuildError('USAGE', '--bundle-web-fonts must be an explicit opt-in.');
    if (options.bundleWebFonts && !isDom) throw new BuildError('UNEXPECTED_WEB_FONTS', '--bundle-web-fonts is accepted only by dom-window-v1.');
    if (!options.bundleWebFonts && ['webFontsState', 'offline'].some(key => Object.hasOwn(options, key))) throw new BuildError('UNEXPECTED_WEB_FONTS', '--web-fonts-state and --offline require --bundle-web-fonts.');
    if (Object.hasOwn(options, 'webFontsState') && (typeof options.webFontsState !== 'string' || !options.webFontsState)) throw new BuildError('USAGE', '--web-fonts-state requires a directory path.');
    if (Object.hasOwn(options, 'offline') && typeof options.offline !== 'boolean') throw new BuildError('USAGE', '--offline must be boolean.');
    if (!isDom && Object.hasOwn(options, 'font')) throw new BuildError('UNEXPECTED_FONT', '--font is accepted only by dom-window-v1.');
    if (isDom) font = await inspectFont(options.font);
    const configuredEntry = await regularContainedEntry(root, config.entry);
    const htmlSource = isDom ? await readFile(configuredEntry) : undefined;
    let html = isDom && !useVite
      ? (options.bundleWebFonts ? analyzeHtml(htmlSource, config.entry, { webFonts: true }) : prepareHtml(htmlSource, config.entry))
      : undefined;
    let entry = html ? await regularContainedEntry(root, html.entry) : configuredEntry;
    const runtimeBefore = await fileIdentity(runtime);
    checkCancellation(signal);
    const description = validateDescription(await describe(runtime, { signal }), target, config.profile);
    if (options.bundleWebFonts) validateWebFontRuntime(description);
    checkCancellation(signal);
    const runtimeAfter = await fileIdentity(runtime);
    if (JSON.stringify(runtimeBefore) !== JSON.stringify(runtimeAfter)) throw new BuildError('RUNTIME_CHANGED', 'The supplied player changed during inspection.');
    if (options.bundleWebFonts && !useVite) {
      webFonts = await localizeWebFonts({ projectRoot: root, outputDir: out, htmlEntry: config.entry, htmlBytes: htmlSource,
        stateDir: options.webFontsState ?? join(parent, '.3jsn-web-fonts', digest(root).slice(0, 16)),
        offline: options.offline ?? false, signal, fontPolicy }, { fetchImpl });
      html = webFonts;
      checkCancellation(signal);
    }
    staging = await mkdtemp(join(parent, '.3jsn-build-'));
    checkCancellation(signal);
    let bundleRoot = root;
    let additionalInputs = [];
    let viteStylesheets = [];
    if (useVite) {
      viteOutput = join(staging, 'vite');
      await mkdir(viteOutput);
      viteArtifacts = await captureViteArtifacts({ project: root, outputDirectory: viteOutput, signal, base: './' });
      const admitted = validateViteDomGraph(viteArtifacts, config.entry, { webFonts: Boolean(options.bundleWebFonts) });
      if (options.bundleWebFonts) {
        const capturedOutputs = new Map(viteArtifacts.files.map(file => [file.path, file]));
        const javascriptSources = new Map();
        for (const path of admitted.jsFiles) {
          checkCancellation(signal);
          const bytes = await readFile(join(viteOutput, ...path.split('/')));
          const captured = capturedOutputs.get(path);
          if (!captured || bytes.length !== captured.bytes || digest(bytes) !== captured.sha256) {
            throw new BuildError('VITE_OUTPUT_CHANGED', `Vite JavaScript changed after capture: ${path}`);
          }
          javascriptSources.set(path, bytes.toString('utf8'));
        }
        validateViteFontJavaScriptReferences(admitted.fontFiles, javascriptSources);
      }
      const generatedHtml = await readFile(join(viteOutput, ...admitted.htmlFile.split('/')));
      const normalizedHtml = normalizeViteHtml(generatedHtml, { htmlPath: config.entry,
        allowedScripts: admitted.jsFiles, allowedModulePreloads: admitted.modulePreloads,
        allowedStylesheets: admitted.cssFiles, rewriteStylesheets: !options.bundleWebFonts });
      const analysis = analyzeHtml(normalizedHtml, config.entry, { externalStylesheets: true });
      if (analysis.entry !== admitted.entryScript) throw new BuildError('INVALID_VITE_GRAPH', 'Vite HTML script does not resolve to the manifest JavaScript entry.');
      const linkedStylesheets = new Set(analysis.styles.filter(style => style.kind === 'linked').map(style => options.bundleWebFonts
        ? posix.normalize(posix.join(posix.dirname(config.entry), style.href)) : style.href));
      const expectedStylesheets = new Set([...admitted.cssFiles].map(path => options.bundleWebFonts ? path : `./vite/${path}`));
      if (linkedStylesheets.size !== expectedStylesheets.size || [...linkedStylesheets].some(path => !expectedStylesheets.has(path))) {
        throw new BuildError('INVALID_VITE_GRAPH', 'Generated HTML stylesheet links do not match the selected Vite CSS graph.');
      }
      if (options.bundleWebFonts) {
        webFonts = await localizeWebFonts({ projectRoot: viteOutput, outputDir: out, htmlEntry: config.entry,
          htmlBytes: normalizedHtml, stateDir: options.webFontsState ?? join(parent, '.3jsn-web-fonts', digest(root).slice(0, 16)),
          offline: options.offline ?? false, signal, fontPolicy, protectedRoots: [snapshotRoot] }, { fetchImpl });
        if (webFonts.entry !== admitted.entryScript) throw new BuildError('INVALID_VITE_GRAPH', 'Localized Vite HTML entry differs from the admitted JavaScript entry.');
        webFonts.requirements = webFonts.requirements.map(requirement => ({ ...requirement,
          stylesheet: requirement.stylesheet.startsWith('file:')
            ? relative(viteOutput, fileURLToPath(requirement.stylesheet)).split(sep).join('/') : requirement.stylesheet }));
        const sourceInputs = new Map(webFonts.sourceInputs.map(input => [input.path, input]));
        const capturedInputs = new Map(viteArtifacts.files.map(file => [file.path, file]));
        for (const input of sourceInputs.values()) {
          const captured = capturedInputs.get(input.path);
          if (!captured || captured.bytes !== input.bytes || captured.sha256 !== input.sha256
            || (!admitted.cssFiles.has(input.path) && !admitted.fontFiles.has(input.path))) {
            throw new BuildError('VITE_OUTPUT_CHANGED', `Localized Vite input is outside the captured CSS/font graph or changed: ${input.path}`);
          }
        }
        for (const path of admitted.cssFiles) if (!sourceInputs.has(path)) {
          throw new BuildError('INVALID_VITE_GRAPH', `Vite stylesheet was not consumed by font localization: ${path}`);
        }
        for (const path of admitted.fontFiles) if (!sourceInputs.has(path)) {
          throw new BuildError('INVALID_VITE_GRAPH', `Vite font asset was not consumed by font localization: ${path}`);
        }
        entry = join(viteOutput, ...webFonts.entry.split('/'));
        html = { ...webFonts, metadata: { ...webFonts.metadata, interpretation: 'vite-generated-interim-runtime-html-css',
          generatedHtml: admitted.htmlFile, adapter: 'vite-client-artifact-graph-v1',
          stylesheetResources: { capability: WEB_FONT_CAPABILITY, localizedResources: webFonts.files.map(({ path, kind }) => ({ path, kind })) } } };
      } else {
      html = { ...analysis, bytes: renderHtml(analysis), metadata: { ...analysis.metadata,
        interpretation: 'vite-generated-interim-runtime-html-css', generatedHtml: admitted.htmlFile,
        adapter: 'vite-client-artifact-graph-v1',
        rewrite: 'The generated module is bundled; linked CSS hrefs are remapped to package-relative resources.',
        stylesheetResources: { capability: DOM_STYLESHEET_CAPABILITY, rejectedEdges: ['url()', '@import'] } } };
      }
      let stylesheetBytes = 0;
      if (!options.bundleWebFonts && admitted.cssFiles.size > DOM_STYLESHEET_LIMITS.count) throw new BuildError('VITE_CSS_LIMIT', 'Vite emitted more than 64 CSS resources.');
      for (const path of options.bundleWebFonts ? [] : [...admitted.cssFiles].sort()) {
        const payload = await readFile(join(viteOutput, ...path.split('/')));
        const captured = viteArtifacts.files.find(file => file.path === path);
        if (!captured || captured.bytes !== payload.length || captured.sha256 !== digest(payload)) {
          throw new BuildError('VITE_OUTPUT_CHANGED', `Vite stylesheet changed after artifact capture: ${path}`);
        }
        if (payload.length > DOM_STYLESHEET_LIMITS.bytes) throw new BuildError('VITE_CSS_LIMIT', `Vite stylesheet exceeds 1 MiB: ${path}`);
        validatePackagedStylesheet(payload, path);
        stylesheetBytes += payload.length;
        if (stylesheetBytes > DOM_STYLESHEET_LIMITS.totalBytes) throw new BuildError('VITE_CSS_LIMIT', 'Vite stylesheets exceed 64 MiB in total.');
        viteStylesheets.push({ path: `app/vite/${path}`, sourcePath: path, payload, bytes: payload.length, sha256: digest(payload), kind: 'stylesheet' });
      }
      if (!options.bundleWebFonts) entry = join(viteOutput, ...analysis.entry.split('/'));
      bundleRoot = viteOutput;
      additionalInputs = await viteSourceMapInputs(viteOutput, viteArtifacts.sourceMaps, snapshotRoot, root);
      viteSummary = { version: viteArtifacts.viteVersion, manifest: viteArtifacts.manifestPath,
        htmlEntry: admitted.htmlFile, javascriptEntry: admitted.entryScript,
        staticModules: [...admitted.jsFiles].sort(), capturedFiles: viteArtifacts.files };
    }
    const built = await bundle(bundleRoot, entry, staging, {
      allowImageResources: !isDom, labelRoot: snapshotRoot, generatedRoot: useVite ? viteOutput : undefined, additionalInputs,
    });
    if (built.resources.length && (!Array.isArray(description.capabilities)
      || !description.capabilities.includes(PACKAGE_ASSETS_CAPABILITY))) {
      throw new BuildError('INCOMPATIBLE_RUNTIME', `The supplied player does not advertise ${PACKAGE_ASSETS_CAPABILITY}.`);
    }
    if (viteStylesheets.length && (!Array.isArray(description.capabilities)
      || !description.capabilities.includes(DOM_STYLESHEET_CAPABILITY))) {
      throw new BuildError('INCOMPATIBLE_RUNTIME', `The supplied DOM player must advertise ${DOM_STYLESHEET_CAPABILITY}.`);
    }
    checkCancellation(signal);
    if (html) {
      await writeFile(join(staging, 'app/index.html'), html.bytes, { flag: 'wx' });
      built.files.push({ path: 'app/index.html', bytes: html.bytes.length, sha256: digest(html.bytes) });
      await copyFile(font.path, join(staging, 'app/font.woff2'), constants.COPYFILE_EXCL);
      font.copied = await fileIdentity(join(staging, 'app/font.woff2'));
      if (font.copied.sha256 !== font.before.sha256 || font.copied.bytes !== font.before.bytes) throw new BuildError('FONT_CHANGED', 'The copied font differs from the inspected input.');
      built.files.push({ path: 'app/font.woff2', ...font.copied });
      for (const resource of webFonts?.files ?? []) {
        await mkdir(dirname(join(staging, resource.path)), { recursive: true });
        await writeFile(join(staging, resource.path), resource.payload, { flag: 'wx' });
        built.files.push({ path: resource.path, bytes: resource.bytes, sha256: resource.sha256 });
      }
      for (const resource of viteStylesheets) {
        const destination = join(staging, ...resource.path.split('/'));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, resource.payload, { flag: 'wx' });
        built.files.push({ path: resource.path, bytes: resource.bytes, sha256: resource.sha256 });
      }
      built.files.sort((a, b) => a.path.localeCompare(b.path));
      checkCancellation(signal);
    }
    const executable = `${config.name}${process.platform === 'win32' ? '.exe' : ''}`;
    await copyFile(runtime, join(staging, executable), constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') await chmod(join(staging, executable), 0o755);
    const copiedRuntime = await fileIdentity(join(staging, executable));
    checkCancellation(signal);
    if (JSON.stringify(copiedRuntime) !== JSON.stringify(runtimeBefore)) throw new BuildError('RUNTIME_CHANGED', 'The copied player differs from the inspected binary.');
    const manifest = { schemaVersion: 1, profile: config.profile, name: config.name, target, entry: 'app/main.mjs',
      ...(html ? { html: 'app/index.html', font: 'app/font.woff2' } : {}),
      ...(webFonts ? { requires: [WEB_FONT_CAPABILITY], resources: webFonts.files.map(({ path, kind }) => ({ path, kind })) }
        : viteStylesheets.length ? { requires: [DOM_STYLESHEET_CAPABILITY], resources: viteStylesheets.map(({ path, kind }) => ({ path, kind })) }
        : built.resources.length ? { requires: [PACKAGE_ASSETS_CAPABILITY], resources: built.resources } : {}), files: built.files };
    const manifestBytes = jsonBytes(manifest);
    if (Buffer.byteLength(manifestBytes) > 1024 * 1024 || manifest.files.length > 4096) throw new BuildError('MANIFEST_LIMIT', 'Package manifest exceeds version 1 limits.');
    after = useVite ? await viteSourceSnapshot(snapshotRoot, snapshotExclusions)
      : await snapshotTree(root, { exclude: ['node_modules'] });
    preservation = compareSnapshots(before, after);
    checkCancellation(signal);
    if (!preservation.preserved) throw new BuildError('SOURCE_CHANGED', 'Project source changed during the build; the output was not published.');
    for (const [path, initial] of built.loaded) {
      const final = await fileIdentity(path);
      checkCancellation(signal);
      if (final.sha256 !== initial.sha256 || final.bytes !== initial.bytes) throw new BuildError('INPUT_CHANGED', 'A bundled dependency changed before publication.');
    }
    if (viteOutput && webFonts) {
      const capturedInputs = new Map(viteArtifacts.files.map(file => [file.path, file]));
      for (const initial of webFonts.sourceInputs) {
        const captured = capturedInputs.get(initial.path);
        if (!captured || captured.bytes !== initial.bytes || captured.sha256 !== initial.sha256) {
          throw new BuildError('FONT_SOURCE_CHANGED', 'A localized Vite stylesheet/font input changed before publication.');
        }
        const final = await fileIdentity(join(viteOutput, ...initial.path.split('/')));
        if (final.bytes !== initial.bytes || final.sha256 !== initial.sha256) throw new BuildError('FONT_SOURCE_CHANGED', 'A localized Vite stylesheet/font input changed before publication.');
        checkCancellation(signal);
      }
    }
    if (viteOutput) {
      await rm(viteOutput, { recursive: true, force: true });
      viteOutput = undefined;
    }
    for (const initial of webFonts?.sourceInputs ?? []) if (!useVite) {
      const final = await fileIdentity(join(root, initial.path));
      if (final.bytes !== initial.bytes || final.sha256 !== initial.sha256) throw new BuildError('FONT_SOURCE_CHANGED', 'A localized stylesheet/font input changed before publication.');
      checkCancellation(signal);
    }
    if (font) await verifyFont(font);
    checkCancellation(signal);
    const metadata = { schemaVersion: 1, status: 'experimental', profile: config.profile, target,
      compatibility: { certified: false, unresolvedDynamicBehavior: true, limitations: limitationsFor(config.profile, { webFonts: Boolean(webFonts), vite: useVite }) },
      config, runtime: { executable, ...copiedRuntime, description },
      source: { before, after, preservation }, esbuild: built.metadata,
      ...(viteSummary ? { vite: { ...viteSummary, packagedStylesheets: viteStylesheets.map(({ path, sourcePath, bytes, sha256 }) => ({ path, sourcePath, bytes, sha256 })) } } : {}),
      ...(html ? { html: { ...html.metadata, source: { path: config.entry, bytes: htmlSource.length, sha256: digest(htmlSource) },
        generated: { path: 'app/index.html', bytes: html.bytes.length, sha256: digest(html.bytes) } }, assets: { font: fontMetadata(font) } } : {}),
      ...(webFonts ? { webFonts: { capability: WEB_FONT_CAPABILITY,
        stateDir: useVite ? relative(parent, webFonts.stateDir).split(sep).join('/') : webFonts.stateDir, offline: options.offline ?? false,
        sourceInputs: webFonts.sourceInputs, provenance: webFonts.provenance, requirements: webFonts.requirements, lock: webFonts.lock } } : {}),
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
    return { status: 'experimental', target, profile: config.profile, output: out, executable: join(out, executable), manifest: join(out, 'app.json'), metadata: join(out, 'metadata', 'build.json'), sourcePreserved: true,
      ...(webFonts ? { webFontsState: webFonts.stateDir } : {}) };
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
    try {
      after = useVite ? await viteSourceSnapshot(snapshotRoot, snapshotExclusions)
        : await snapshotTree(root, { exclude: ['node_modules'] });
      preservation = compareSnapshots(before, after);
    } catch (error) { snapshotError = failure(error); }
  }
  const error = primary instanceof BuildError ? primary : new BuildError(primary.code ?? 'BUILD_FAILED', primary.message, { cause: primary });
  let fontError;
  if (font) {
    try { await verifyFont(font); } catch (error) { fontError = failure(error); }
  }
  if (before) {
    const receipt = { schemaVersion: 1, status: 'failed', target, profile: config?.profile ?? null, error: failure(error),
      source: { before, after: after ?? null, preservation: preservation ?? null, snapshotError: snapshotError ?? null },
      ...(font ? { assets: { font: { ...fontMetadata(font), verificationError: fontError ?? null } } } : {}), cleanupErrors };
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
