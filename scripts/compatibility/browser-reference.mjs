import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..');
const [browserExecutable] = process.argv.slice(2);
if (!browserExecutable || process.argv.length !== 3) {
  console.error('Usage: node scripts/compatibility/browser-reference.mjs <chrome-or-chromium-executable>');
  process.exit(2);
}

const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (request.method !== 'GET' || !(path.startsWith('/fixtures/') || path.startsWith('/node_modules/three/build/')) || path.includes('\\') || path.split('/').includes('..')) throw new Error('Not served');
    const absolute = await realpath(join(root, path));
    if (!(absolute.startsWith(`${root}/fixtures/`) || absolute.startsWith(`${root}/node_modules/three/build/`))) throw new Error('Not served');
    const mime = path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' : 'application/javascript';
    response.writeHead(200, { 'Content-Type': mime });
    response.end(await readFile(absolute));
  } catch {
    response.writeHead(404);
    response.end();
  }
});

let browser;
let socket;
let directory;
let stderr = '';
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  directory = await mkdtemp(join(tmpdir(), '3jsn-browser-reference-'));
  browser = spawn(browserExecutable, ['--headless', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${directory}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let launchError;
  browser.once('error', (error) => { launchError = error; });
  browser.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-20000); });
  let port;
  const deadline = Date.now() + 30000;
  while (!port && Date.now() < deadline) {
    if (launchError) throw launchError;
    if (browser.exitCode !== null) throw new Error(`Browser exited before debugging connection: ${browser.exitCode}`);
    try { port = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!port) await delay(100);
  }
  if (!port) throw new Error('Browser debugging connection timed out.');
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) }).then((response) => response.json());
  const page = pages.find((item) => item.type === 'page');
  if (!page) throw new Error('Browser did not create a page.');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser WebSocket connection timed out.')), 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', (error) => { clearTimeout(timer); reject(error); }, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  });
  function command(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  const version = await command('Browser.getVersion');
  await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/fixtures/webgl-dom/index.html` });
  let result;
  const fixtureDeadline = Date.now() + 20000;
  while (!result && Date.now() < fixtureDeadline) {
    const evaluation = await command('Runtime.evaluate', { expression: 'globalThis.__3jsnFixtureResult ?? null', returnByValue: true });
    if (evaluation.exceptionDetails) throw new Error('Browser could not read the fixture result.');
    result = evaluation.result.value;
    if (!result) await delay(100);
  }
  if (!result) throw new Error('Fixture did not finish within 20 seconds.');
  const fixtureInputs = [];
  for (const path of ['fixtures/webgl-dom/index.html', 'fixtures/webgl-dom/style.css', 'fixtures/webgl-dom/fixture.mjs', 'package-lock.json']) {
    fixtureInputs.push({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') });
  }
  console.log(JSON.stringify({ schemaVersion: 1, kind: 'browser-reference', capturedAt: new Date().toISOString(), host: { platform: process.platform, architecture: process.arch }, browser: version, fixtureInputs, result }, null, 2));
  if (result.status !== 'passed') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ error: error.message, browserLogTail: stderr }));
  process.exitCode = 3;
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    for (let count = 0; count < 20 && browser.exitCode === null; count++) await delay(100);
    if (browser.exitCode === null) browser.kill('SIGKILL');
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
