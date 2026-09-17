import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const websocketModule = pathToFileURL(createRequire(import.meta.url).resolve('ws')).href;
const fakeBrowserSource = `#!/usr/bin/env node
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ws from ${JSON.stringify(websocketModule)};
const { WebSocketServer } = ws;
const profile = process.argv.find((arg) => arg.startsWith('--user-data-dir=')).split('=')[1];
const state = { pid: process.pid, profile, phase: 'startup' };
const publish = () => writeFile(process.env.REFERENCE_TEST_STATE, JSON.stringify(state));
if (process.env.REFERENCE_TEST_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
if (process.env.REFERENCE_TEST_PHASE === 'command') {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:' + state.port }]));
  });
  const websocket = new WebSocketServer({ server });
  websocket.on('connection', (connection) => connection.on('message', async () => {
    state.phase = 'command';
    await publish();
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = server.address().port;
  await writeFile(join(profile, 'DevToolsActivePort'), String(state.port) + '\\n');
}
await publish();
setInterval(() => {}, 1000);
`;

async function bounded(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Test operation timed out.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

for (const scenario of [
  { signal: 'SIGINT', code: 130, phase: 'startup', ignoreTerm: true },
  { signal: 'SIGTERM', code: 143, phase: 'command', ignoreTerm: false },
]) {
  test(`reference runner cleans up after ${scenario.signal} during ${scenario.phase}`, {
    timeout: 15000,
    skip: process.platform === 'win32' ? 'POSIX executable and signal regression' : false,
  }, async () => {
    const temporary = await mkdtemp(join(tmpdir(), '3jsn-reference-test-'));
    const executable = join(temporary, 'browser.mjs');
    const stateFile = join(temporary, 'state.json');
    let runner;
    let closed;
    let state;
    let stderr = '';
    try {
      await writeFile(executable, fakeBrowserSource, { mode: 0o700 });
      runner = spawn(process.execPath, [join(root, 'scripts/compatibility/browser-reference.mjs'), executable], {
        cwd: root,
        env: { ...process.env, REFERENCE_TEST_STATE: stateFile, REFERENCE_TEST_PHASE: scenario.phase, REFERENCE_TEST_IGNORE_TERM: scenario.ignoreTerm ? '1' : '0' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      runner.stderr.on('data', (chunk) => { stderr += chunk; });
      closed = new Promise((resolve, reject) => {
        runner.once('close', (code, signal) => resolve({ code, signal }));
        runner.once('error', reject);
      });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        if (state?.phase === scenario.phase) break;
        assert.equal(runner.exitCode, null, stderr);
        await delay(20);
      }
      assert.equal(state?.phase, scenario.phase, stderr);
      assert.equal(isAlive(state.pid), true);
      runner.kill(scenario.signal);
      assert.deepEqual(await bounded(closed, 6000), { code: scenario.code, signal: null }, stderr);
      assert.equal(isAlive(state.pid), false, 'Browser child must be reaped before the runner exits.');
      await assert.rejects(stat(state.profile), { code: 'ENOENT' });
      if (state.port) await assert.rejects(fetch(`http://127.0.0.1:${state.port}`, { signal: AbortSignal.timeout(1000) }));
    } finally {
      if (runner && runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
      if (closed) await bounded(closed, 2000).catch(() => {});
      if (state && isAlive(state.pid)) process.kill(state.pid, 'SIGKILL');
      if (state?.profile) await rm(state.profile, { recursive: true, force: true });
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
