import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { snapshotTree } from '../../scripts/compatibility/snapshot.mjs';
import { WEB_FONT_LIMITS } from './web-font-cache.mjs';
import { localizeWebFonts } from './web-fonts.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function bounded(promise, message, milliseconds = 2_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

for (const kind of ['stylesheet', 'font']) for (const stop of ['cancellation', 'deadline']) {
  test(`real HTTP ${kind} mid-body ${stop} closes transport, preserves source and permits retry`, { timeout: 10_000 }, async t => {
    const base = await mkdtemp(join(tmpdir(), '3jsn-font-network-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const projectRoot = join(base, 'project'), stateDir = join(base, 'state');
    await mkdir(projectRoot);
    const css = Buffer.from('/* Original streaming fixture */ @font-face{font-family:Stream;src:url("font")}');
    // A coherent packaging header; this test makes no claim about font decoding or glyph rendering.
    const font = Buffer.alloc(49);
    font.write('wOF2'); font.writeUInt32BE(font.length, 8); font.writeUInt16BE(1, 12);
    font.writeUInt32BE(128, 16); font.writeUInt32BE(1, 20);
    const stalledPath = kind === 'stylesheet' ? '/style.css' : '/font';
    const responseClosed = Promise.withResolvers(), socketClosed = Promise.withResolvers(), headersReceived = Promise.withResolvers();
    let stall = true, stalledResponse, stalledSocket;
    const server = createServer((request, response) => {
      const body = request.url === '/style.css' ? css : font;
      response.writeHead(200, { 'content-type': request.url === '/style.css' ? 'text/css' : 'font/woff2', 'content-length': body.length });
      if (stall && request.url === stalledPath) {
        stalledSocket = request.socket;
        response.once('close', responseClosed.resolve);
        request.socket.once('close', socketClosed.resolve);
        response.write(body.subarray(0, kind === 'font' ? 48 : 24));
      } else response.end(body);
    });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const htmlBytes = Buffer.from(`<!doctype html><link rel="stylesheet" href="${origin}/style.css"><canvas id="scene"></canvas><script type="module" src="app.mjs"></script>`);
    await writeFile(join(projectRoot, 'index.html'), htmlBytes);
    await writeFile(join(projectRoot, 'app.mjs'), 'export const unchanged = true;');
    const before = await snapshotTree(projectRoot);
    const controller = new AbortController();
    const options = { projectRoot, outputDir: join(base, 'output'), stateDir, htmlEntry: 'index.html', htmlBytes };
    // Observe the real response without replacing its body, abort signal or network transport.
    const fetchImpl = async (...args) => {
      const response = await fetch(...args);
      if (new URL(args[0]).pathname === stalledPath) { stalledResponse = response; headersReceived.resolve(); }
      return response;
    };
    const pending = localizeWebFonts({ ...options, signal: controller.signal,
      limits: { ...WEB_FONT_LIMITS, timeoutMs: stop === 'deadline' ? 1_000 : WEB_FONT_LIMITS.timeoutMs } }, { fetchImpl });
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await bounded(headersReceived.promise, 'Client did not receive the partial HTTP response.');
    await setImmediate();
    assert.equal(stalledResponse.bodyUsed, true, 'Cancellation must occur while the actual response body is being consumed.');
    if (stop === 'cancellation') controller.abort();
    const { error, value } = await bounded(outcome, 'Stalled body did not reject promptly.');
    assert.equal(value, undefined);
    assert.equal(error?.code, stop === 'cancellation' ? 'CANCELLED' : 'FONT_FETCH_TIMEOUT');
    assert.ok(error.message.includes(`${origin}${stalledPath}`));
    await bounded(Promise.all([responseClosed.promise, socketClosed.promise]), 'Partial HTTP response/socket remained open.');
    assert.equal(stalledSocket.destroyed, true);
    assert.equal((await readdir(stateDir)).includes('.lease'), false);
    await assert.rejects(readFile(join(stateDir, 'lock.json')), { code: 'ENOENT' });
    assert.deepEqual(await snapshotTree(projectRoot), before);

    stall = false;
    const recovered = await bounded(localizeWebFonts(options), 'Same-cache retry did not finish.');
    assert.equal(recovered.lock.entries.length, 2);
    for (const [path, bytes] of [['/style.css', css], ['/font', font]]) {
      const pin = recovered.lock.entries.find(entry => entry.requestUrl === `${origin}${path}`);
      assert.equal(pin.response.bytes, bytes.length);
      assert.equal(pin.response.sha256, hash(bytes));
    }
    assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'lock.json'), 'utf8')), recovered.lock);
    assert.equal((await readdir(stateDir)).includes('.lease'), false);
    assert.deepEqual(await snapshotTree(projectRoot), before);
  });
}
