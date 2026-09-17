import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFixtureServer } from './fixture-server.mjs';

test('static read failures return 404 and leave the fixture service usable', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), '3jsn-fixture-server-test-'));
  const fixture = createFixtureServer(root);
  try {
    await mkdir(join(root, 'fixtures', 'example'), { recursive: true });
    await writeFile(join(root, 'fixtures', 'example', 'index.html'), '<p>fixture</p>');
    await new Promise((resolve, reject) => {
      fixture.server.once('error', reject);
      fixture.server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${fixture.server.address().port}`;
    for (const path of ['/fixtures/example/', '/fixtures/example/missing.html']) {
      const response = await fetch(origin + path, { signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 404, path);
      assert.equal(await response.text(), '');
    }
    const response = await fetch(`${origin}/fixtures/example/index.html`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '<p>fixture</p>');
    const api = await fetch(`${origin}/fixture-api/message`, { signal: AbortSignal.timeout(2000) });
    assert.equal(api.status, 200);
    assert.equal((await api.json()).version, 1);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
