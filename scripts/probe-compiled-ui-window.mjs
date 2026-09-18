import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { compileHtml } from '../experiments/compiled-ui/compiler.mjs';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const [playerArg, fontArg, outputArg, ...extra] = process.argv.slice(2);
assert(process.platform === 'darwin' && process.arch === 'arm64' && playerArg && fontArg && outputArg && !extra.length,
  'Usage: node scripts/probe-compiled-ui-window.mjs <dom-player> <font.woff2> <new-output> (macOS arm64)');
const output = resolve(outputArg);
await mkdir(output);
const runDirectory = join(output, 'Native UI é #');
await mkdir(runDirectory);
const font = join(runDirectory, 'font.woff2'), player = join(runDirectory, 'player');
await copyFile(resolve(fontArg), font);
await copyFile(resolve(playerArg), player);
await chmod(player, 0o755);
const description = JSON.parse((await execute(player, ['--describe'], { timeout: 60_000, killSignal: 'SIGKILL' })).stdout);
assert.equal(description.target, 'macos-arm64');
const sourcePath = join(root, 'fixtures/compiled-ui/dashboard.html');
const source = await readFile(sourcePath, 'utf8');
const html = join(runDirectory, 'original.html'), ui = join(runDirectory, 'ui.json');
await writeFile(html, source);
const compiled = JSON.stringify(compileHtml(source, { sourceName: 'fixtures/compiled-ui/dashboard.html' }));
await writeFile(ui, compiled);
const module = join(runDirectory, 'app.mjs');
const bundle = await build({ entryPoints: [join(root, 'fixtures/compiled-ui/scene.mjs')],
  outfile: module, bundle: true, platform: 'browser', format: 'esm', logLevel: 'silent', metafile: true });
assert.equal(bundle.warnings.length, 0);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const baseRules = ['.cache', 'node_modules', 'crates', 'experiments', 'examples', 'fixtures']
  .map(path => ` (subpath ${JSON.stringify(join(root, path))})`).join('\n');
const policy = denyHtml => `(version 1)\n(allow default)\n(deny network*)\n(deny file-read*\n${baseRules}\n${denyHtml ? ` (literal ${JSON.stringify(html)})\n` : ''})\n`;
const originalPolicy = join(output, 'interpreted.sb'), compiledPolicy = join(output, 'compiled.sb');
await writeFile(originalPolicy, policy(false)); await writeFile(compiledPolicy, policy(true));
const options = { cwd: runDirectory, env: { ...process.env, PATH: '/usr/bin:/bin', MTL_DEBUG_LAYER: '1' },
  timeout: 90_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 };
async function run(label, sandbox, args) {
  try {
    const result = await execute('/usr/bin/sandbox-exec', ['-f', sandbox, player, ...args], options);
    await writeFile(join(output, `${label}-stdout.txt`), result.stdout);
    await writeFile(join(output, `${label}-stderr.txt`), result.stderr);
    return result.stdout.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  } catch (error) {
    await writeFile(join(output, `${label}-stdout.txt`), error.stdout ?? '');
    await writeFile(join(output, `${label}-stderr.txt`), error.stderr ?? String(error));
    throw error;
  }
}
await assert.rejects(execute('/usr/bin/sandbox-exec', ['-f', compiledPolicy, '/bin/cat', html], options), error => {
  assert.match(error.stderr, /Operation not permitted/); return true;
});
const interpreted = await run('interpreted', originalPolicy, [font, html, module, '120']);
const compiledRun = await run('compiled', compiledPolicy, ['--compiled-ui', ui, font, module, '--frames', '120']);
for (const records of [interpreted, compiledRun]) {
  const completed = records.find(record => record.nativeDomWindow);
  assert.equal(completed?.presentedFrames, 120); assert.equal(completed?.cpuImageTransport, false);
  assert.equal(completed?.nativeDeviceIdentityChecked, true); assert.equal(completed?.nativeQueueIdentityChecked, true);
}
const loading = compiledRun.find(record => record.compiledUi)?.compiledUi;
assert.equal(loading?.initialDocumentHtmlParserUsed, false);
assert.equal(loading?.dynamicHtmlParserProvider, 'blitz-html');
const observations = records => Object.fromEntries(records.filter(record => record.uiPhase).map(record => [record.uiPhase, record.result]));
const initial = observations(interpreted), after = observations(compiledRun);
assert.deepEqual(Object.keys(initial).sort(), ['initial', 'mutated']);
assert.deepEqual(after, initial, 'Compiled and interpreted native windows must retain the same tested DOM behavior.');
const invalid = JSON.parse(compiled); invalid.version = 999;
await writeFile(ui, JSON.stringify(invalid));
try {
  await assert.rejects(run('invalid-version', compiledPolicy, ['--compiled-ui', ui, font, module, '--frames', '1']), error => {
    assert.equal(error.code, 1); assert.match(error.stderr, /unsupported compiled UI capability: format or version/); return true;
  });
} finally { await writeFile(ui, compiled); }
await writeFile(ui, JSON.stringify(compileHtml(source.replace('</head>',
  '<link rel="stylesheet" href="./missing.css"></head>'), { sourceName: 'undeclared-resource-control.html' })));
try {
  await assert.rejects(run('undeclared-resource', compiledPolicy, ['--compiled-ui', ui, font, module, '--frames', '1']), error => {
    assert.equal(error.code, 1); assert.match(error.stderr, /resource is not in the verified package allowlist/); return true;
  });
} finally { await writeFile(ui, compiled); }
assert.equal(await readFile(sourcePath, 'utf8'), source);
const report = { status: 'passed', target: 'macos-arm64', backend: 'Metal', loading,
  initialDocumentHtmlReadsDenied: true, nativeNetworkingDenyConfigured: true, sourcePreserved: true,
  interpretedCompletion: interpreted.find(record => record.nativeDomWindow),
  compiledCompletion: compiledRun.find(record => record.nativeDomWindow), observations: after,
  invalidVersionRejected: true, undeclaredResourceRejected: true, inputs: { htmlSha256: hash(source), irSha256: hash(compiled),
    playerSha256: hash(await readFile(player)), moduleSha256: hash(await readFile(module)), fontSha256: hash(await readFile(font)) },
  limits: ['Networking denial is configured by sandbox policy; this harness does not measure an attempted network connection.',
    'This is an experimental direct player invocation, not a new supported package profile.',
    'CSS and dynamic HTML parsing remain linked; the fixture deliberately exercises innerHTML after startup.',
    'Presentation and DOM observations do not certify GPU pixel equivalence or performance improvements.'] };
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, report: join(output, 'report.json') }));
