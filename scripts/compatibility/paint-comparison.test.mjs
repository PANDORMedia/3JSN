import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';

const comparator = resolve(import.meta.dirname, '../../experiments/dom-canvas/compare-clips.mjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function compare(t, { color = [224, 32, 48, 255], declared, nativeDeclared = declared, size = 16 }) {
  const directory = await mkdtemp(join(tmpdir(), '3jsn-paint-color-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const png = new PNG({ width: 64, height: 64 });
  png.data.fill(255);
  for (let y = 8; y < 8 + size; y++) {
    for (let x = 8; x < 8 + size; x++) png.data.set(color, (y * 64 + x) * 4);
  }
  const bytes = PNG.sync.write(png);
  const base = { name: 'opacity-subject', scale: 1, width: 64, height: 64,
    layout: Object.fromEntries(['outer', 'middle', 'subject'].map(id => [id, { x: 8, y: 8, width: size, height: size }])),
    pixelSha256: hash(png.data), file: 'capture.png' };
  for (const native of [false, true]) {
    const path = join(directory, native ? 'native' : 'browser');
    await mkdir(path);
    await writeFile(join(path, 'capture.png'), bytes);
    const metadata = native ? nativeDeclared : declared;
    const capture = { ...base, ...(metadata === undefined ? {} : { subjectColor: metadata }),
      ...(native ? { paint: { scale: 1 }, paintCalls: 1, gpuErrors: [] } : {}) };
    await writeFile(join(path, 'report.json'), JSON.stringify({
      cssViewport: { width: 64, height: 64 }, cases: [capture],
      inputs: Object.fromEntries(['htmlSha256', 'scriptSha256', 'casesSha256'].map(key => [key, 'a'.repeat(64)])),
    }));
  }
  const output = join(directory, 'comparison.json');
  const result = spawnSync(process.execPath, [comparator, join(directory, 'browser'), join(directory, 'native'), output],
    { encoding: 'utf8', timeout: 10_000 });
  return { ...result, report: result.status === 0 ? JSON.parse(await readFile(output, 'utf8')) : undefined };
}

test('paint comparison retains the default opaque subject visibility guard', async t => {
  const result = await compare(t, {});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.cases[0].subjectReferencePixels, 256);
});

test('paint comparison accepts declared composited color rounding', async t => {
  const result = await compare(t, { declared: [240, 144, 152, 255], color: [239, 143, 151, 255] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.cases[0].subjectReferencePixels, 256);
});

test('identical images with too little visible composited subject cannot pass', async t => {
  const result = await compare(t, { declared: [240, 144, 152, 255], color: [240, 144, 152, 255], size: 8 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Subject is not visibly exercised/);
});

test('paint comparison rejects different subject metadata between hosts', async t => {
  const result = await compare(t, { declared: [240, 144, 152, 255], nativeDeclared: [224, 32, 48, 255] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Subject reference colors differ/);
});

test('paint comparison rejects malformed subject channels', async t => {
  const result = await compare(t, { declared: [240, 144, 152, 256] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /subjectColor must contain four integer RGBA/);
});
