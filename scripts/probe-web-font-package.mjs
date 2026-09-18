import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { withBrowserSession } from './compatibility/browser-session.mjs';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const [playerArg, fontArg, outputArg, browserArg, ...extra] = process.argv.slice(2);
assert(process.platform === 'darwin' && playerArg && fontArg && outputArg && browserArg && !extra.length,
  'Usage: node scripts/probe-web-font-package.mjs <dom-player> <fallback.woff2> <new-evidence-dir> <Chrome> (macOS)');
const output = resolve(outputArg);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const player = resolve(playerArg), font = resolve(fontArg), browser = resolve(browserArg);
const cli = join(root, 'packages/cli/cli.mjs');
const source = join(output, 'input'), state = join(output, 'font-state');
await mkdir(output);
await cp(join(root, 'fixtures/web-fonts'), source, { recursive: true });
const metricsSource = await readFile(join(source, 'metrics.mjs'), 'utf8');
const options = { cwd: root, timeout: 90_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 };
async function recorded(label, command, args, opts = options) {
  try {
    const result = await execute(command, args, opts);
    await writeFile(join(output, `${label}-stdout.txt`), result.stdout);
    await writeFile(join(output, `${label}-stderr.txt`), result.stderr);
    return result;
  } catch (error) {
    await writeFile(join(output, `${label}-stdout.txt`), error.stdout ?? '');
    await writeFile(join(output, `${label}-stderr.txt`), error.stderr ?? String(error));
    throw error;
  }
}
const argumentsFor = out => [cli, 'build', source, '--runtime', player, '--font', font, '--out', out,
  '--bundle-web-fonts', '--web-fonts-state', state, '--experimental'];
const online = join(output, 'online');
await recorded('build-online', process.execPath, argumentsFor(online));
const offline = join(output, 'offline');
await recorded('build-offline', '/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)',
  process.execPath, ...argumentsFor(offline), '--offline']);
const manifestBytes = await readFile(join(online, 'app.json'));
assert.deepEqual(await readFile(join(offline, 'app.json')), manifestBytes,
  'Offline build must produce the same application manifest and payload identities.');
const manifest = JSON.parse(manifestBytes);
const metadata = JSON.parse(await readFile(join(online, 'metadata/build.json')));
for (const file of manifest.files) {
  const bytes = await readFile(join(offline, file.path));
  assert.equal(bytes.length, file.bytes);
  assert.equal(hash(bytes), file.sha256);
  assert.deepEqual(bytes, await readFile(join(online, file.path)));
}
assert.deepEqual(manifest.requires, ['dom-package-fonts-v1']);
const fontFiles = manifest.resources.filter(resource => resource.kind === 'font');
assert(fontFiles.length > 2, 'The fixture must include independent families and Unicode subsets.');
assert.equal(hash(await readFile(join(offline, manifest.name))), hash(await readFile(join(online, manifest.name))));

const notices = [];
for (const name of ['Roboto-OFL.txt', 'Noto-Serif-OFL.txt']) {
  const bytes = await readFile(join(source, 'notices', name));
  const path = join('metadata', 'font-notices', name);
  await mkdir(dirname(join(online, path)), { recursive: true });
  await writeFile(join(online, path), bytes);
  notices.push({ path, bytes: bytes.length, sha256: hash(bytes) });
}
// Notices are explicit fixture inputs; this probe does not infer redistribution rights from URLs.
await writeFile(join(online, 'metadata/font-notices.json'), JSON.stringify(notices, null, 2));
const relocated = join(output, 'Native fonts é #');
await rename(online, relocated);
await rm(source, { recursive: true });
const cwd = join(output, 'unrelated-directory');
await mkdir(cwd);
const sandbox = join(output, 'native-offline.sb');
const denied = ['.cache', 'node_modules', 'crates', 'experiments', 'examples', 'fixtures'].map(path => join(root, path));
await writeFile(sandbox, `(version 1)\n(allow default)\n(deny network*)\n(deny file-read*\n${denied.map(path => ` (subpath ${JSON.stringify(path)})`).join('\n')}\n (subpath ${JSON.stringify(state)})\n)\n`);
const executable = join(relocated, manifest.name);
const nativeOptions = { ...options, cwd, env: { ...process.env, PATH: '/usr/bin:/bin', MTL_DEBUG_LAYER: '1' } };
const runNative = (label, args) => recorded(label, '/usr/bin/sandbox-exec', ['-f', sandbox, executable, ...args], nativeOptions);
const readControls = ['.cache/dom-canvas/blitz/packages/blitz-dom/Cargo.toml', 'node_modules/three/package.json',
  'crates/package/src/lib.rs', 'experiments/dom-canvas/src/window_probe.rs', 'examples/3jsn.json', 'fixtures/web-fonts/index.html']
  .map(path => join(root, path)).concat(join(state, 'lock.json'));
for (const path of readControls) await assert.rejects(execute('/usr/bin/sandbox-exec', ['-f', sandbox, '/bin/cat', path], nativeOptions), error => {
  assert.equal(error.code, 1); assert.match(error.stderr, /Operation not permitted/); return true;
});
await runNative('verify', ['--verify-app', join(relocated, 'app.json')]);
const native = await runNative('native', ['--frames', '120']);
const records = native.stdout.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
const completion = records.find(record => record.nativeDomWindow === true);
assert.equal(completion?.presentedFrames, 120);
assert.equal(completion?.cpuImageTransport, false);
const nativeMetrics = Object.fromEntries(records.filter(record => record.fontMetrics).map(record => [record.fontMetrics, record.samples]));
assert(nativeMetrics.initial && nativeMetrics.localized, 'Application must report both font phases.');
const loading = records.find(record => record.webFonts);
assert.equal(loading?.webFonts.requested, metadata.webFonts.requirements.length);
assert.equal(loading?.webFonts.registered, metadata.webFonts.requirements.length);
assert.equal(loading?.webFonts.pending, 0);
assert.equal(loading?.packagedResources.fontRegistrationVerified, true);

const failures = [];
for (const resource of [manifest.resources.find(item => item.kind === 'stylesheet'), fontFiles[0]]) {
  const path = join(relocated, resource.path);
  const bytes = await readFile(path);
  try {
    await writeFile(path, Buffer.concat([bytes, Buffer.from('damaged')]));
    await assert.rejects(runNative(`corrupt-${resource.kind}`, ['--verify-app', join(relocated, 'app.json')]), error => {
      assert.equal(error.code, 1); assert.match(error.stderr, /integrity verification/);
      failures.push({ kind: resource.kind, rejected: true }); return true;
    });
  } finally { await writeFile(path, bytes); }
}

async function invalidVerifiedPayload(path, bytes, label, diagnostic) {
  const original = await readFile(join(relocated, path));
  const changed = structuredClone(manifest);
  const item = changed.files.find(file => file.path === path);
  item.bytes = bytes.length; item.sha256 = hash(bytes);
  try {
    await writeFile(join(relocated, path), bytes);
    await writeFile(join(relocated, 'app.json'), JSON.stringify(changed));
    await assert.rejects(runNative(label, ['--frames', '120']), error => {
      assert.equal(error.code, 1); assert.match(error.stderr, diagnostic);
      failures.push({ kind: label, rejected: true, diagnostic: error.stderr }); return true;
    });
  } finally {
    await writeFile(join(relocated, path), original);
    await writeFile(join(relocated, 'app.json'), manifestBytes);
  }
}
const malformedFont = Buffer.alloc(48);
malformedFont.write('wOF2'); malformedFont.writeUInt32BE(48, 8);
await invalidVerifiedPayload(fontFiles[0].path, malformedFont, 'invalid-decoded-font', /web font load failed/);
const main = await readFile(join(relocated, manifest.entry), 'utf8');
const newRule = `\n@font-face{font-family:"Late Fixture";src:url("./${fontFiles[0].path.slice(4)}") format("woff2");}`;
await invalidVerifiedPayload(manifest.entry, Buffer.from(`${main}\ndocument.querySelector('style').textContent += ${JSON.stringify(newRule)};\n`),
  'dynamic-font-rule', /dynamic font-rule set\/order mutation/);
await runNative('verify-restored', ['--verify-app', join(relocated, 'app.json')]);

const html = (await readFile(join(relocated, manifest.html), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const metricsScript = metricsSource.replaceAll('export function ', 'function ');
const allowed = new Set(manifest.files.map(file => `/${file.path}`));
const served = new Set();
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method !== 'GET') throw new Error('unsupported method');
    if (path === '/app/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); return;
    }
    if (!allowed.has(path)) throw new Error('unlisted resource');
    const bytes = await readFile(join(relocated, path.slice(1)));
    served.add(path);
    response.writeHead(200, { 'content-type': path.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream' });
    response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
let browserResult;
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browserResult = await withBrowserSession(browser, async ({ command }) => {
    await command('Page.enable');
    await command('Emulation.setDeviceMetricsOverride', { width: 960, height: 720, deviceScaleFactor: 1, mobile: false });
    const url = `http://127.0.0.1:${server.address().port}/app/index.html`;
    await command('Page.navigate', { url });
    const deadline = Date.now() + 15_000;
    let loaded = false;
    while (Date.now() < deadline) {
      try {
        const state = await command('Runtime.evaluate', { expression: `location.href===${JSON.stringify(url)} && document.readyState==='complete' && Boolean(document.getElementById('localized'))`, returnByValue: true });
        if (state.result.value === true) { loaded = true; break; }
      } catch (error) { if (!/context.*destroyed|Cannot find context/i.test(error.message)) throw error; }
      await delay(25);
    }
    assert(loaded, 'Browser fixture navigation timed out.');
    const result = await command('Runtime.evaluate', { expression: `(async()=>{
      while(document.readyState!=='complete') await new Promise(r=>setTimeout(r,20));
      await document.fonts.ready;
      ${metricsScript}
      const initial=measure(); localize();
      await document.fonts.load('25px Roboto', document.getElementById('localized').textContent);
      await document.fonts.ready;
      return {initial,localized:measure(),fontFaces:document.fonts.size};
    })()`, awaitPromise: true, returnByValue: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    const screenshot = await command('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(output, 'browser-fonts.png'), Buffer.from(screenshot.data, 'base64'));
    return { ...result.result.value, version: await command('Browser.getVersion') };
  });
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
const comparisons = [];
for (const phase of ['initial', 'localized']) for (const [id, sample] of Object.entries(browserResult[phase])) {
  const actual = nativeMetrics[phase][id];
  comparisons.push({ phase, id, expected: sample.width, actual: actual?.width,
    passed: sample.text === actual?.text && Math.abs(sample.width - actual.width) <= 0.25 });
}
const selectionChecks = {
  familiesDiffer: Math.abs(nativeMetrics.initial.middle.width - nativeMetrics.initial.serif.width) > 1,
  weightsDiffer: Math.abs(nativeMetrics.initial.thin.width - nativeMetrics.initial.heavy.width) > 1,
  unicodeRestriction: Math.abs(nativeMetrics.initial.restricted.width - nativeMetrics.initial['roboto-a'].width - nativeMetrics.initial['serif-b'].width) <= 0.25,
  laterFaceWins: Math.abs(nativeMetrics.initial.ordered.width - nativeMetrics.initial['serif-ab'].width) <= 0.25,
};
const report = { status: comparisons.every(item => item.passed) && Object.values(selectionChecks).every(Boolean) ? 'passed' : 'partial',
  target: manifest.target, fonts: fontFiles.length, offlineRebuildIdentical: true, nativeNetworkDenied: true,
  developmentSourceAndFontCacheReadsDenied: true, completion, loading, nativeMetrics, browser: browserResult,
  deniedReadControls: readControls,
  comparisons, selectionChecks, integrityFailures: failures, notices, browserServedResources: [...served],
  playerSha256: hash(await readFile(executable)), manifestSha256: hash(manifestBytes),
  measurementScriptSha256: hash(metricsSource),
  limits: ['Experimental macOS Metal profile; no cross-platform certification or performance measurement.',
    'Browser reference exercises the same generated HTML/CSS/fonts with a shared DOM measurement script; Three.js is separately exercised by the native window run.',
    'Width checks establish tested face selection and layout; they do not certify all shaping, rasterization or font APIs.'] };
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, report: join(output, 'report.json'), comparisons: comparisons.length, selectionChecks }));
assert.equal(report.status, 'passed', 'Font comparison gates failed; report saved.');
