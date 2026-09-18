import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { snapshotTree } from './compatibility/snapshot.mjs';

const execute = promisify(execFile), root = resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: { ...Object.fromEntries(['preserved', 'restricted', 'font', 'out', 'web-fonts-state'].map(name => [name, { type: 'string' }])),
  'cpu-only': { type: 'boolean', default: false } }, strict: true });
assert(process.platform === 'darwin' && process.arch === 'arm64' && ['preserved', 'restricted', 'font', 'out'].every(key => values[key]),
  'Usage: node scripts/probe-compiled-package.mjs --preserved EXE --restricted EXE --font FONT --out NEWDIR [--cpu-only] [--web-fonts-state EXISTINGDIR] (macOS arm64)');
const output = resolve(values.out), source = join(output, 'input'), fixture = join(root, 'fixtures/web-fonts');
const state = values['web-fonts-state'] ? resolve(values['web-fonts-state']) : join(output, 'font-state');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
await mkdir(output);
const report = { status: 'running', nativeVerified: false, cpuOnly: values['cpu-only'], steps: [], modes: {},
  limits: ['Experimental compiled-dom-window-v1 package integration; no browser, pixel, cross-platform or performance claim.',
    'Restricted parser omission requires separate dependency/link evidence for the exact executable.',
    'CPU verification loads packaged fonts and compares shared DOM width metrics; it does not request a GPU device.'] };
const save = () => writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
const options = { cwd: root, timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 12 * 1024 * 1024 };

async function recorded(label, command, args, opts = options, expectedFailure) {
  let stdout = '', stderr = '', failure;
  try { ({ stdout, stderr } = await execute(command, args, opts)); }
  catch (error) { stdout = error.stdout ?? ''; stderr = error.stderr ?? String(error); failure = error; }
  await writeFile(join(output, `${label}-stdout.txt`), stdout);
  await writeFile(join(output, `${label}-stderr.txt`), stderr);
  report.steps.push({ label, expectedFailure: Boolean(expectedFailure), exitCode: failure?.code ?? 0, signal: failure?.signal ?? null,
    stdout: `${label}-stdout.txt`, stderr: `${label}-stderr.txt` });
  await save();
  if (expectedFailure) {
    assert(failure && failure.code === 1 && !failure.killed && !failure.signal, `${label}: expected diagnostic exit 1, not success/timeout/signal`);
    assert.match(stderr, expectedFailure);
  } else if (failure) throw failure;
  return stdout.split('\n').filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line));
}
function one(records, key) {
  const selected = records.filter(record => Object.hasOwn(record, key));
  assert.equal(selected.length, 1, `Expected exactly one ${key} record`);
  return selected[0];
}
function fontLoading(records, expectedFaces) {
  const record = one(records, 'webFonts');
  assert.equal(record.webFonts.requested, expectedFaces);
  assert.equal(record.webFonts.registered, expectedFaces);
  assert.equal(record.webFonts.pending, 0);
  assert.equal(record.packagedResources.fontRegistrationVerified, true);
  return record;
}

try {
  if (values['web-fonts-state']) assert((await stat(state)).isDirectory(), 'Supplied font state must already exist.');
  const originalSnapshot = await snapshotTree(fixture);
  await cp(fixture, source, { recursive: true });
  const config = await json(join(source, '3jsn.json'));
  config.profile = 'compiled-dom-window-v1';
  await writeFile(join(source, '3jsn.json'), `${JSON.stringify(config, null, 2)}\n`);
  const copiedSnapshot = await snapshotTree(source);
  const metricsSource = await readFile(join(source, 'metrics.mjs'), 'utf8');
  const behavior = join(output, 'package-behavior.js');
  await writeFile(behavior, `${metricsSource.replaceAll('export function ', 'function ')}\nconsole.log(JSON.stringify({compiledPackageBehaviorStarted:true}));\nglobalThis.uiProbe={snapshot:measure,verify(){localize();return {localized:measure()};}};\n`);
  const cli = join(root, 'packages/cli/cli.mjs'), packages = {};
  for (const mode of ['preserved', 'restricted']) {
    const built = join(output, `built-${mode}`), repeat = join(output, `rebuilt-${mode}`);
    const args = destination => [cli, 'build', source, '--runtime', resolve(values[mode]), '--font', resolve(values.font), '--out', destination,
      '--bundle-web-fonts', '--web-fonts-state', state, '--html-parser', mode, '--experimental'];
    const offlineFirst = mode === 'restricted' || Boolean(values['web-fonts-state']);
    if (offlineFirst) await recorded(`build-${mode}`, '/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', process.execPath, ...args(built), '--offline']);
    else await recorded(`build-${mode}`, process.execPath, args(built));
    await recorded(`rebuild-${mode}`, '/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', process.execPath, ...args(repeat), '--offline']);
    const manifestBytes = await readFile(join(built, 'app.json')), manifest = JSON.parse(manifestBytes);
    const metadata = await json(join(built, 'metadata/build.json'));
    assert.deepEqual(await readFile(join(repeat, 'app.json')), manifestBytes);
    assert.equal(manifest.profile, 'compiled-dom-window-v1');
    assert.equal(manifest.compiledUi.htmlParser, mode);
    assert.equal(Object.hasOwn(manifest, 'html'), false);
    assert(!manifest.files.some(file => /\.html?$/i.test(file.path)), 'No HTML payload may be packaged.');
    assert.deepEqual(manifest.requires, ['dom-package-fonts-v1']);
    assert.equal(metadata.webFonts.requirements.length, 28, 'Pinned fixture face count changed.');
    const fonts = manifest.resources.filter(resource => resource.kind === 'font');
    assert.equal(fonts.length, 25, 'Pinned fixture font-file count changed.');
    for (const file of manifest.files) {
      const bytes = await readFile(join(built, file.path));
      assert.equal(hash(bytes), file.sha256); assert.equal(bytes.length, file.bytes);
      assert.deepEqual(await readFile(join(repeat, file.path)), bytes);
    }
    assert.deepEqual(await readFile(join(built, manifest.name)), await readFile(join(repeat, manifest.name)));
    const notices = [];
    for (const name of ['Roboto-OFL.txt', 'Noto-Serif-OFL.txt']) {
      const bytes = await readFile(join(source, 'notices', name)), path = `metadata/font-notices/${name}`;
      await mkdir(dirname(join(built, path)), { recursive: true });
      await writeFile(join(built, path), bytes);
      notices.push({ path, bytes: bytes.length, sha256: hash(bytes) });
    }
    await writeFile(join(built, 'metadata/font-notices.json'), JSON.stringify(notices, null, 2));
    const relocated = join(output, `Native compiled ${mode} é #`);
    await rename(built, relocated);
    packages[mode] = { relocated, manifest, manifestBytes, metadata, fonts };
    report.modes[mode] = { offlineRebuildIdentical: true, firstBuildOffline: offlineFirst, faces: 28, fonts: 25,
      notices, manifestSha256: hash(manifestBytes), executableSha256: hash(await readFile(join(relocated, manifest.name))) };
  }
  assert.deepEqual(await snapshotTree(source), copiedSnapshot, 'Copied source changed during packaging.');
  await rm(source, { recursive: true });
  const cwd = join(output, 'unrelated directory'); await mkdir(cwd);
  const policy = join(output, 'native-offline.sb');
  const denied = ['.cache', 'node_modules', 'crates', 'experiments', 'examples', 'fixtures'].map(path => join(root, path)).concat(source, state);
  await writeFile(policy, `(version 1)\n(allow default)\n(deny network*)\n(deny file-read*\n${denied.map(path => ` (subpath ${JSON.stringify(path)})`).join('\n')}\n)\n`);
  const nativeOptions = { ...options, cwd, env: { ...process.env, PATH: '/usr/bin:/bin', MTL_DEBUG_LAYER: '1' } };
  for (const [index, path] of [join(fixture, 'index.html'), join(root, 'node_modules/three/package.json'), join(state, 'lock.json')].entries()) {
    await recorded(`denied-read-${index}`, '/usr/bin/sandbox-exec', ['-f', policy, '/bin/cat', path], nativeOptions, /Operation not permitted/);
  }
  for (const mode of ['preserved', 'restricted']) {
    const { relocated, manifest, manifestBytes, metadata, fonts } = packages[mode];
    const executable = join(relocated, manifest.name), manifestPath = join(relocated, 'app.json');
    const run = (label, args, failure) => recorded(`${mode}-${label}`, '/usr/bin/sandbox-exec', ['-f', policy, executable, ...args], nativeOptions, failure);
    await run('verify', ['--verify-app', manifestPath]);
    const measured = await run('measure', ['--measure-app', manifestPath, behavior, '--verify']);
    const measurement = one(measured, 'layoutMeasurement');
    assert.equal(measurement.layoutMeasurement, true);
    assert.equal(measurement.gpuDeviceRequested, false);
    assert.equal(measurement.dynamicHtml, mode === 'preserved');
    assert(measurement.initial && measurement.verification?.localized);
    assert.equal(Object.keys(measurement.initial).length, 11);
    assert.equal(Object.keys(measurement.verification.localized).length, 11);
    assert.equal(measurement.verification.localized.localized.text, 'Καλημέρα · Привет');
    for (const phase of [measurement.initial, measurement.verification.localized]) {
      for (const sample of Object.values(phase)) assert(Number.isFinite(sample.width) && sample.width > 0);
    }
    const initial = measurement.initial;
    const selectionChecks = {
      familiesDiffer: Math.abs(initial.middle.width - initial.serif.width) > 1,
      weightsDiffer: Math.abs(initial.thin.width - initial.heavy.width) > 1,
      unicodeRestriction: Math.abs(initial.restricted.width - initial['roboto-a'].width - initial['serif-b'].width) <= 0.25,
      laterFaceWins: Math.abs(initial.ordered.width - initial['serif-ab'].width) <= 0.25,
    };
    assert(Object.values(selectionChecks).every(Boolean), `Fixture face-selection controls failed: ${JSON.stringify(selectionChecks)}`);
    report.modes[mode].cpu = { initial: measurement.initial, localized: measurement.verification.localized,
      selectionChecks, fontLoading: fontLoading(measured, metadata.webFonts.requirements.length) };
    if (!values['cpu-only']) {
      const native = await run('native', ['--frames', '120']);
      const completed = one(native, 'nativeDomWindow');
      assert.equal(completed.nativeDomWindow, true); assert.equal(completed.backend, 'Metal');
      assert.equal(completed.presentedFrames, 120); assert.equal(completed.cpuImageTransport, false);
      assert.equal(completed.nativeDeviceIdentityChecked, true); assert.equal(completed.nativeQueueIdentityChecked, true);
      assert(completed.canvasSnapshots > 0);
      const phases = native.filter(record => Object.hasOwn(record, 'fontMetrics'));
      assert.deepEqual(phases.map(record => record.fontMetrics), ['initial', 'localized']);
      report.modes[mode].native = { completion: completed, metrics: Object.fromEntries(phases.map(record => [record.fontMetrics, record.samples])),
        fontLoading: fontLoading(native, metadata.webFonts.requirements.length) };
      assert.deepEqual(report.modes[mode].native.metrics.initial, measurement.initial);
      assert.deepEqual(report.modes[mode].native.metrics.localized, measurement.verification.localized);
    }
    const failures = [];
    async function mutate(label, path, bytes, repairHash, diagnostic, startup = false, transformManifest = value => value) {
      const original = path ? await readFile(join(relocated, path)) : null;
      const changed = transformManifest(structuredClone(manifest));
      if (repairHash) {
        const file = changed.files.find(item => item.path === path);
        assert(file, 'Mutation must target a manifest-owned payload'); file.bytes = bytes.length; file.sha256 = hash(bytes);
      }
      try {
        if (path) await writeFile(join(relocated, path), bytes);
        await writeFile(manifestPath, JSON.stringify(changed));
        const records = await run(label, startup ? ['--measure-app', manifestPath, behavior, '--verify'] : ['--verify-app', manifestPath], diagnostic);
        assert(!records.some(record => record.compiledPackageBehaviorStarted || record.layoutMeasurement), 'Invalid package reached behavior execution.');
        failures.push({ label, rejected: true, payloadHashUpdated: repairHash });
      } finally {
        if (path) await writeFile(join(relocated, path), original);
        await writeFile(manifestPath, manifestBytes);
      }
    }
    const css = manifest.resources.find(resource => resource.kind === 'stylesheet'); assert(css);
    for (const [kind, path] of [['ui', manifest.compiledUi.path], ['font', fonts[0].path], ['css', css.path]]) {
      await mutate(`tampered-${kind}`, path, Buffer.concat([await readFile(join(relocated, path)), Buffer.from('damaged')]), false, /integrity verification/);
    }
    const ir = await json(join(relocated, manifest.compiledUi.path));
    await mutate('invalid-ir-version', manifest.compiledUi.path, Buffer.from(JSON.stringify({ ...ir, version: 999 })), true, /unsupported compiled UI capability: format or version/);
    const invalid = structuredClone(ir); invalid.nodes[0].children = [999999];
    await mutate('invalid-ir-reference', manifest.compiledUi.path, Buffer.from(JSON.stringify(invalid)), true, /invalid compiled UI tree|node reference|document child/);
    await mutate('parser-descriptor-mismatch', null, null, false, /package requires HTML parser mode/, false, value => {
      value.compiledUi.htmlParser = mode === 'preserved' ? 'restricted' : 'preserved'; return value;
    });
    const undeclared = structuredClone(ir);
    const link = undeclared.nodes.find(node => node.kind === 'element' && node.name === 'link'); assert(link);
    link.attributes.find(attribute => attribute.name === 'href').value = './styles/not-in-package.css';
    await mutate('undeclared-stylesheet', manifest.compiledUi.path, Buffer.from(JSON.stringify(undeclared)), true,
      /resource is not in the verified package allowlist/, true);
    const malformed = Buffer.alloc(48); malformed.write('wOF2'); malformed.writeUInt32BE(48, 8);
    await mutate('malformed-font', fonts[0].path, malformed, true, /web font load failed/, true);
    for (const phase of ['script', 'snapshot', 'verify']) {
      for (const [kind, mutation, diagnostic] of [
        ['stylesheet', "const link=document.createElement('link');link.setAttribute('rel','stylesheet');link.setAttribute('href','./missing.css');document.querySelector('head').appendChild(link);",
          /resource is not in the verified package allowlist/],
        ['font-rule', "const style=document.createElement('style');style.textContent='@font-face{font-family:Late;src:url(late.woff2)}';document.querySelector('head').appendChild(style);",
          /dynamic font-rule set\/order mutation is unsupported/],
      ]) {
        const label = `dynamic-${kind}-${phase}`, script = join(output, `${mode}-${label}.js`);
        await writeFile(script, `function mutate(){${mutation}}\n${phase === 'script' ? 'mutate();' : ''}\nglobalThis.uiProbe={snapshot(){${phase === 'snapshot' ? 'mutate();' : ''}return {};},verify(){${phase === 'verify' ? 'mutate();' : ''}return {};}};\n`);
        const records = await run(label, ['--measure-app', manifestPath, script, '--verify'], diagnostic);
        assert(!records.some(record => record.layoutMeasurement), 'Resource mutation reached a successful measurement.');
        failures.push({ label, rejected: true, payloadHashUpdated: false });
      }
    }
    await run('verify-restored', ['--verify-app', manifestPath]);
    assert.deepEqual(await readFile(manifestPath), manifestBytes);
    for (const file of manifest.files) assert.equal(hash(await readFile(join(relocated, file.path))), file.sha256);
    report.modes[mode].negativeControls = failures;
    await save();
  }
  assert.deepEqual(report.modes.preserved.cpu.initial, report.modes.restricted.cpu.initial);
  assert.deepEqual(report.modes.preserved.cpu.localized, report.modes.restricted.cpu.localized);
  if (!values['cpu-only']) {
    assert.deepEqual(report.modes.preserved.native.metrics, report.modes.restricted.native.metrics);
    report.nativeVerified = true;
  }
  assert.deepEqual(await snapshotTree(fixture), originalSnapshot, 'Original fixture changed.');
  report.sourcePreserved = true; report.copiedSourceRemoved = true;
  report.nativeNetworkAndDevelopmentReadsDenied = true;
  report.measurementScriptSha256 = hash(await readFile(behavior));
  report.status = 'passed'; await save();
  console.log(JSON.stringify({ status: report.status, nativeVerified: report.nativeVerified, report: join(output, 'report.json') }));
} catch (error) {
  report.status = 'failed'; report.failure = { message: error.message, stack: error.stack }; await save(); throw error;
}
