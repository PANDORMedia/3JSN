import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createFixtureServer } from './fixture-server.mjs';

const root = resolve(import.meta.dirname, '../..');
const availableFixtures = ['webgl-dom', 'workers-wasm', 'audio-worklet', 'network'];
const [browserExecutable, selection = 'webgl-dom'] = process.argv.slice(2);
if (!browserExecutable || process.argv.length > 4 || (selection !== 'all' && !availableFixtures.includes(selection))) {
  console.error('Usage: node scripts/compatibility/browser-reference.mjs <chrome-or-chromium-executable> [webgl-dom|workers-wasm|audio-worklet|network|all]');
  process.exit(2);
}
const fixtures = selection === 'all' ? availableFixtures : [selection];
const fixtureServer = createFixtureServer(root);
const { server } = fixtureServer;

let browser;
let socket;
let directory;
let stderr = '';
let browserClosed;
let cleanupPromise;
let terminationSignal;
const cancellation = new AbortController();
const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map((name) => [name, () => {
  terminationSignal ??= name;
  cancellation.abort(new Error(`Reference capture interrupted by ${name}.`));
}]));
for (const [name, handler] of signalHandlers) process.on(name, handler);

function waitForBrowserClose(timeout) {
  let timer;
  return Promise.race([
    browserClosed.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeout); }),
  ]).finally(() => clearTimeout(timer));
}

function cleanup() {
  cleanupPromise ??= (async () => {
    socket?.close();
    try {
      if (browser?.pid) {
        if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGTERM');
        if (!await waitForBrowserClose(2000)) {
          browser.kill('SIGKILL');
          if (!await waitForBrowserClose(2000)) {
            browser.stderr.destroy();
            browser.unref();
            throw new Error('Browser did not close after SIGKILL.');
          }
        }
      }
    } finally {
      try { await fixtureServer.close(); }
      finally {
        if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
      }
    }
  })();
  return cleanupPromise;
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cancellation.signal.throwIfAborted();
  directory = await mkdtemp(join(tmpdir(), '3jsn-browser-reference-'));
  cancellation.signal.throwIfAborted();
  browser = spawn(browserExecutable, ['--headless', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${directory}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  browserClosed = new Promise((resolve) => browser.once('close', resolve));
  let launchError;
  browser.once('error', (error) => { launchError = error; });
  browser.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-20000); });
  let port;
  const deadline = Date.now() + 30000;
  while (!port && Date.now() < deadline) {
    cancellation.signal.throwIfAborted();
    if (launchError) throw launchError;
    if (browser.exitCode !== null || browser.signalCode !== null) throw new Error(`Browser exited before debugging connection: ${browser.signalCode ?? browser.exitCode}`);
    try { port = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!port) await delay(100, undefined, { signal: cancellation.signal });
  }
  if (!port) throw new Error('Browser debugging connection timed out.');
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(5000)]) }).then((response) => response.json());
  const page = pages.find((item) => item.type === 'page');
  if (!page) throw new Error('Browser did not create a page.');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      socket.removeEventListener('open', opened);
      socket.removeEventListener('error', failed);
      cancellation.signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const opened = () => finish();
    const failed = (error) => finish(error);
    const aborted = () => finish(cancellation.signal.reason);
    const timer = setTimeout(() => finish(new Error('Browser WebSocket connection timed out.')), 10000);
    socket.addEventListener('open', opened, { once: true });
    socket.addEventListener('error', failed, { once: true });
    cancellation.signal.addEventListener('abort', aborted, { once: true });
    if (cancellation.signal.aborted) aborted();
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  });
  function command(method, params = {}) {
    cancellation.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const finish = (callback, value) => {
        pending.delete(id);
        clearTimeout(timer);
        cancellation.signal.removeEventListener('abort', aborted);
        callback(value);
      };
      const aborted = () => finish(reject, cancellation.signal.reason);
      const timer = setTimeout(() => finish(reject, new Error(`Browser command timed out: ${method}`)), 10000);
      pending.set(id, { resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error) });
      cancellation.signal.addEventListener('abort', aborted, { once: true });
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { finish(reject, error); }
    });
  }
  const version = await command('Browser.getVersion');
  const reports = [];
  for (const fixture of fixtures) {
    await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/fixtures/${fixture}/index.html` });
    let result;
    const fixtureDeadline = Date.now() + 20000;
    while (!result && Date.now() < fixtureDeadline) {
      const evaluation = await command('Runtime.evaluate', { expression: 'globalThis.__3jsnFixtureResult ?? null', returnByValue: true });
      if (evaluation.exceptionDetails) throw new Error('Browser could not read the fixture result.');
      if (evaluation.result.value?.fixture === fixture) result = evaluation.result.value;
      if (!result) await delay(100, undefined, { signal: cancellation.signal });
    }
    if (!result) throw new Error(`Fixture did not finish within 20 seconds: ${fixture}`);
    const fixtureInputs = [];
    const sources = (await readdir(join(root, 'fixtures', fixture))).filter((file) => /\.(html|css|mjs)$/.test(file)).map((file) => `fixtures/${fixture}/${file}`);
    sources.push('fixtures/harness.mjs', 'scripts/compatibility/fixture-server.mjs', 'package-lock.json');
    for (const path of sources.sort()) {
      fixtureInputs.push({ path, sha256: createHash('sha256').update(await readFile(join(root, path), { signal: cancellation.signal })).digest('hex') });
    }
    reports.push({ schemaVersion: 1, kind: 'browser-reference', capturedAt: new Date().toISOString(), host: { platform: process.platform, architecture: process.arch }, browser: version, fixtureInputs, result });
    if (result.status !== 'passed') process.exitCode = 1;
  }
  console.log(JSON.stringify(selection === 'all' ? { schemaVersion: 1, kind: 'browser-reference-suite', reports } : reports[0], null, 2));
} catch (error) {
  if (terminationSignal) process.exitCode = terminationSignal === 'SIGINT' ? 130 : 143;
  else {
    console.error(JSON.stringify({ error: error.message, browserLogTail: stderr }));
    process.exitCode = 3;
  }
} finally {
  try { await cleanup(); }
  catch (error) {
    console.error(JSON.stringify({ error: `Cleanup failed: ${error.message}` }));
    process.exitCode = 3;
  } finally {
    if (terminationSignal && process.exitCode !== 3) process.exitCode = terminationSignal === 'SIGINT' ? 130 : 143;
    for (const [name, handler] of signalHandlers) process.off(name, handler);
  }
}
