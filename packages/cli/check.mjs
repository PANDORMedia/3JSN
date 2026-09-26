import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { snapshotTree, compareSnapshots } from '../../scripts/compatibility/snapshot.mjs';
import { validateProfile, featureStatus } from '../../scripts/compatibility/profile.mjs';
import { hostTarget } from './contract.mjs';
import { analyzeJavaScript } from './check-javascript.mjs';
import { analyzeProjectFiles } from './check-discovery.mjs';

const profilePath = new URL('../../docs/profiles/experimental-desktop-v1.json', import.meta.url);
const javascript = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i;
const sourceExtension = /\.(?:[cm]?js|jsx|[cm]?ts|tsx|html?|css)$/i;
const npmLockfiles = new Set(['package-lock.json', 'npm-shrinkwrap.json']);
const limits = { files: 4096, fileBytes: 2 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, findings: 10000, analysisMilliseconds: 10000 };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const cancelled = signal => { if (signal?.aborted) throw Object.assign(new Error(), { code: 'CANCELLED' }); };
const location = path => ({ path, line: 1, column: 1 });

// Only this repository's parsers run in the worker; project text is inert input.
// Termination keeps signals and parser deadlines independent of synchronous AST work.
function isolatedAnalysis(operation, args, signal, milliseconds) {
  cancelled(signal);
  return new Promise((resolveResult, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { checkAnalysis: true, operation, args }, execArgv: [] });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.terminate().then(() => error ? reject(error) : resolveResult(value), reject);
    };
    const abort = () => finish(Object.assign(new Error(), { code: 'CANCELLED' }));
    const timer = setTimeout(() => finish(Object.assign(new Error(), { code: 'ANALYSIS_TIMEOUT' })), milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', value => finish(null, value));
    worker.once('error', () => finish(Object.assign(new Error(), { code: 'ANALYSIS_FAILED' })));
    worker.once('exit', () => { if (!settled) finish(Object.assign(new Error(), { code: 'ANALYSIS_FAILED' })); });
    if (signal?.aborted) abort();
  });
}

if (!isMainThread && workerData?.checkAnalysis === true) {
  const fn = workerData.operation === 'discover' ? analyzeProjectFiles : analyzeJavaScript;
  parentPort.postMessage(fn(...workerData.args));
}

function diagnostic(code, message, extra = {}) {
  return { code, severity: 'error', feature: 'analysis', status: 'unknown', message, target: null, ...extra };
}

/** Inspect a quiescent source tree without resolving or executing its build configuration. */
export async function checkProject(options, { snapshot = snapshotTree, read = readFile,
  discover = analyzeProjectFiles, analyze = analyzeJavaScript, analysisMilliseconds = limits.analysisMilliseconds } = {}) {
  const report = { schemaVersion: 1, operation: 'check', profile: null, targets: [],
    analysisCoverage: { mode: 'syntactic-project-inventory', runtimeTracing: false, certified: false,
      sourceFiles: [], lockfiles: [], skippedFiles: [], limits,
      exclusions: ['.git', 'node_modules'], excludeBasenames: ['node_modules'],
      limitations: [
        'Findings are syntactic candidates, including potentially unused, shadowed, server and build-tool code. Reachability and client/server boundaries are unresolved.',
        'Dependencies, aliases, generated code and build plugins are not executed or resolved. Missing findings do not establish missing runtime requirements.',
        'Only npm lockfile Three.js version records are inventoried. Installed files, import resolution, runtime use, other package managers and source maps remain unresolved; declared dependency ranges are not installed-version evidence.',
        'No runtime, browser, network request or project command is launched; this is not a native compatibility certificate.',
      ] },
    project: { entryPages: [], packages: [], buildSystems: [], resources: [], imports: [], requirements: [], dependencyResolutions: [] },
    diagnostics: [], preservation: { status: 'unknown', preserved: null }, artifacts: [], exitCode: 1 };
  let before, root, failureCode;
  try {
    if (!options || typeof options.project !== 'string' || !options.project
      || (options.targets !== undefined && typeof options.targets !== 'string')) throw Object.assign(new Error(), { code: 'USAGE' });
    if (!Number.isSafeInteger(analysisMilliseconds) || analysisMilliseconds < 1) throw Object.assign(new Error(), { code: 'USAGE' });
    root = resolve(options.project);
    const profileBytes = await read(profilePath);
    let profile;
    try { profile = validateProfile(JSON.parse(profileBytes)); }
    catch { throw Object.assign(new Error(), { code: 'INVALID_PROFILE' }); }
    report.profile = { id: profile.id, revision: profile.revision, sha256: digest(profileBytes) };
    const targets = options.targets === undefined ? [hostTarget()] : options.targets.split(',');
    if (!targets.length || targets.some(value => !profile.targets.some(target => target.id === value))
      || new Set(targets).size !== targets.length) throw Object.assign(new Error(), { code: 'INVALID_TARGETS' });
    report.targets = targets.map(id => ({ id, status: profile.targets.find(target => target.id === id).status }));
    before = await snapshot(root, { exclude: ['node_modules'], excludeBasenames: ['node_modules'] });
    cancelled(options.signal);
    const files = [];
    let totalBytes = 0, attemptedFiles = 0;
    for (const entry of before.entries) {
      if (entry.kind === 'file' && /\.(?:vue|svelte)$/i.test(entry.path)) {
        report.analysisCoverage.skippedFiles.push(entry.path);
        report.diagnostics.push(diagnostic('UNSUPPORTED_SOURCE_FORMAT', 'Component source format is not analyzed; dependencies and capabilities remain unresolved.', { location: location(entry.path) }));
        continue;
      }
      const name = basename(entry.path);
      if (entry.kind !== 'file' || (!sourceExtension.test(entry.path) && name !== 'package.json' && !npmLockfiles.has(name))) continue;
      if (entry.path.split('/').includes('node_modules') || attemptedFiles >= limits.files
        || entry.bytes > limits.fileBytes || totalBytes + entry.bytes > limits.totalBytes) {
        report.analysisCoverage.skippedFiles.push(entry.path);
        continue;
      }
      cancelled(options.signal);
      attemptedFiles++;
      totalBytes += entry.bytes;
      const bytes = await read(join(root, entry.path));
      if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw Object.assign(new Error(), { code: 'INPUT_CHANGED' });
      let source;
      try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
      catch {
        report.analysisCoverage.skippedFiles.push(entry.path);
        report.diagnostics.push(diagnostic('INVALID_TEXT_ENCODING', 'Source could not be decoded as UTF-8.', { location: location(entry.path) }));
        continue;
      }
      files.push({ path: entry.path, source });
      report.analysisCoverage.sourceFiles.push({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 });
      if (npmLockfiles.has(name)) report.analysisCoverage.lockfiles.push({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 });
    }
    const found = discover === analyzeProjectFiles
      ? await isolatedAnalysis('discover', [files], options.signal, analysisMilliseconds) : await discover(files);
    const requirements = [], uncertainties = [];
    report.project = { ...report.project, ...found, imports: [], requirements: [], resources: [] };
    delete report.project.uncertainties;
    let findingCount = 0;
    let truncated = false;
    const append = (target, rows) => {
      for (const row of rows) {
        if (findingCount >= limits.findings) { truncated = true; break; }
        target.push(row); findingCount++;
      }
    };
    append(requirements, found.requirements);
    append(uncertainties, found.uncertainties);
    append(report.project.resources, found.resources);
    const inspect = async (source, path, offset) => {
      cancelled(options.signal);
      if (findingCount >= limits.findings) { truncated = true; return; }
      const result = analyze === analyzeJavaScript
        ? await isolatedAnalysis('javascript', [source, path, offset], options.signal, analysisMilliseconds) : await analyze(source, path, offset);
      append(requirements, result.requirements);
      append(uncertainties, result.uncertainties);
      append(report.project.imports, result.imports);
      append(report.project.resources, result.assets);
    };
    for (const file of files) if (javascript.test(file.path)) await inspect(file.source, file.path);
    for (const page of found.entryPages) for (const script of page.scripts ?? []) {
      if (typeof script.source !== 'string') continue;
      await inspect(script.source, page.path, { startLine: script.line, startColumn: script.column - 1 });
      delete script.source;
    }
    if (truncated) report.diagnostics.push(diagnostic('ANALYSIS_INCOMPLETE', 'Project finding limit reached; remaining candidates were not inventoried.'));
    const unique = new Map(requirements.map(item => [JSON.stringify(item), item]));
    report.project.requirements = [...unique.values()];
    for (const feature of [...new Set(requirements.map(item => item.feature))].sort()) {
      for (const target of targets) {
        const status = featureStatus(profile, feature, target);
        report.diagnostics.push(diagnostic(status.status === 'supported' ? 'FEATURE_EVIDENCE' : 'FEATURE_UNAVAILABLE',
          `${status.reason} Review the candidate source location against the declared runtime profile.`,
          { feature, target, status: status.status, severity: status.status === 'supported' ? 'info' : 'error',
            location: requirements.find(item => item.feature === feature)?.location }));
      }
    }
    for (const item of uncertainties) report.diagnostics.push(diagnostic(item.code, item.message, { location: item.location }));
    if (report.analysisCoverage.skippedFiles.length) report.diagnostics.push(diagnostic('ANALYSIS_INCOMPLETE',
      'Some source files exceeded analysis limits, used an unsupported encoding, or used an unsupported source format; see skippedFiles.'));
    report.diagnostics.push(diagnostic('DYNAMIC_BEHAVIOR_UNRESOLVED',
      'Static inventory cannot establish runtime reachability or complete dependencies. A compatible runtime profile and execution evidence are still required.'));
    for (const target of report.targets) if (target.status !== 'verified') report.diagnostics.push(diagnostic('TARGET_UNVERIFIED',
      'The unchanged-project runtime profile has no complete acceptance evidence for this target.', { target: target.id, feature: 'runtime.target' }));
    cancelled(options.signal);
  } catch (error) {
    failureCode = error.code ?? 'CHECK_FAILED';
    if (failureCode === 'ANALYSIS_TIMEOUT') report.diagnostics.push(diagnostic('ANALYSIS_INCOMPLETE', 'Parser wall-clock budget exceeded; inventory is incomplete.'));
    report.diagnostics.push(diagnostic(failureCode, failureCode === 'CANCELLED'
      ? 'Inspection was cancelled; source verification follows.'
      : 'Inspection could not complete. Check invocation, profile, file permissions and source-tree stability; no project code was executed.'));
  } finally {
    // Inline source is only an analysis input, including when parsing or cancellation fails.
    for (const page of report.project.entryPages) for (const script of page.scripts ?? []) delete script.source;
    if (before) {
      try {
        const after = await snapshot(root, { exclude: ['node_modules'], excludeBasenames: ['node_modules'] });
        report.preservation = { status: 'verified', ...compareSnapshots(before, after), exclusions: before.exclusions };
      } catch (error) {
        if (error.code === 'INPUT_CHANGED') {
          failureCode = 'INPUT_CHANGED';
          report.diagnostics.push(diagnostic('INPUT_CHANGED', 'Source changed while final verification was reading it.'));
        }
        report.diagnostics.push(diagnostic('PRESERVATION_UNKNOWN', 'Source preservation could not be verified.'));
      }
    }
  }
  if (!failureCode && options?.signal?.aborted) {
    failureCode = 'CANCELLED';
    report.diagnostics.push(diagnostic('CANCELLED', 'Inspection was cancelled during source verification.'));
  }
  if (report.preservation.preserved === false || failureCode === 'INPUT_CHANGED') report.exitCode = 4;
  else if (['USAGE', 'INVALID_TARGETS', 'INVALID_PROFILE', 'UNSUPPORTED_HOST', 'INVALID_ROOT'].includes(failureCode)) report.exitCode = 2;
  else if (report.preservation.preserved === null || (failureCode && !['CANCELLED', 'ANALYSIS_TIMEOUT'].includes(failureCode))) report.exitCode = 3;
  else if (failureCode === 'CANCELLED') report.exitCode = 130;
  return report;
}
