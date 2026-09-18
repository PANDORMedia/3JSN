import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createFixtureServer } from './fixture-server.mjs';

const root = resolve(import.meta.dirname, '../..');

/** A disposable loopback fixture server and Chrome CDP connection.
 * The callback must honor signal outside command(). Rejections include
 * sessionFailure, browserLogTail, terminationSignal and cleanupError so CLIs
 * can report failures after the child is reaped and its profile is removed.
 */
export async function withBrowserSession(executable, run) {
  const fixtureServer = createFixtureServer(root);
  const { server } = fixtureServer;
  const cancellation = new AbortController();
  let browser, socket, directory, browserClosed;
  let stderr = '';
  let terminationSignal, failure, interruptedFailure, cleanupError, result;
  let stopping = false;
  const pending = new Map();
  const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map(name => [name, () => {
    terminationSignal ??= name;
    cancellation.abort(new Error(`Reference capture interrupted by ${name}.`));
  }]));
  for (const [name, handler] of signalHandlers) process.on(name, handler);

  function waitForBrowserClose(timeout) {
    let timer;
    return Promise.race([
      browserClosed.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeout); }),
    ]).finally(() => clearTimeout(timer));
  }

  async function cleanup() {
    stopping = true;
    for (const call of [...pending.values()]) call.reject(new Error('Browser session closed.'));
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
  }

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    cancellation.signal.throwIfAborted();
    directory = await mkdtemp(join(tmpdir(), '3jsn-browser-reference-'));
    cancellation.signal.throwIfAborted();
    browser = spawn(executable, ['--headless', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${directory}`, '--remote-debugging-port=0', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
    browserClosed = new Promise(resolve => browser.once('close', resolve));
    let launchError;
    browser.once('error', error => { launchError = error; });
    browser.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-20000); });
    let port;
    const deadline = Date.now() + 30000;
    while (!port && Date.now() < deadline) {
      cancellation.signal.throwIfAborted();
      if (launchError) throw launchError;
      if (browser.exitCode !== null || browser.signalCode !== null) {
        throw new Error(`Browser exited before debugging connection: ${browser.signalCode ?? browser.exitCode}`);
      }
      try { port = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!port) await delay(100, undefined, { signal: cancellation.signal });
    }
    if (!port) throw new Error('Browser debugging connection timed out.');
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(5000)]),
    }).then(response => response.json());
    const page = pages.find(item => item.type === 'page');
    if (!page) throw new Error('Browser did not create a page.');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        socket.removeEventListener('open', opened);
        socket.removeEventListener('error', failed);
        cancellation.signal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      };
      const opened = () => finish();
      const failed = () => finish(new Error('Browser WebSocket connection failed.'));
      const aborted = () => finish(cancellation.signal.reason);
      const timer = setTimeout(() => finish(new Error('Browser WebSocket connection timed out.')), 10000);
      socket.addEventListener('open', opened, { once: true });
      socket.addEventListener('error', failed, { once: true });
      cancellation.signal.addEventListener('abort', aborted, { once: true });
      if (cancellation.signal.aborted) aborted();
    });
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        const call = pending.get(message.id);
        if (!call) return;
        if (message.error) call.reject(new Error(message.error.message));
        else call.resolve(message.result);
      } catch (error) { cancellation.abort(error); }
    });
    socket.addEventListener('close', () => {
      if (!stopping) cancellation.abort(new Error('Browser debugging connection closed.'));
    });
    socket.addEventListener('error', () => {
      if (!stopping) cancellation.abort(new Error('Browser debugging connection failed.'));
    });
    let sequence = 0;
    function command(method, params = {}) {
      cancellation.signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const finish = (callback, value) => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          cancellation.signal.removeEventListener('abort', aborted);
          callback(value);
        };
        const aborted = () => finish(reject, cancellation.signal.reason);
        const timer = setTimeout(() => finish(reject, new Error(`Browser command timed out: ${method}`)), 10000);
        pending.set(id, { resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
        cancellation.signal.addEventListener('abort', aborted, { once: true });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch (error) { finish(reject, error); }
      });
    }
    result = await run({ command, origin: `http://127.0.0.1:${server.address().port}`, signal: cancellation.signal });
  } catch (error) {
    failure = error;
    interruptedFailure = Boolean(terminationSignal);
  } finally {
    try { await cleanup(); }
    catch (error) { cleanupError = error; }
    for (const [name, handler] of signalHandlers) process.off(name, handler);
  }
  if (failure || cleanupError || terminationSignal) {
    throw Object.assign(new Error(failure?.message ?? cancellation.signal.reason?.message ?? 'Browser session cleanup failed.'), {
      sessionFailure: Boolean(failure && !interruptedFailure), browserLogTail: stderr,
      terminationSignal, cleanupError,
    });
  }
  return result;
}
