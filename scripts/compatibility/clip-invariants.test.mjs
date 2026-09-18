import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';

const comparator = resolve(import.meta.dirname, '../../experiments/dom-canvas/compare-clip-invariants.mjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function compare(t, mutate = () => {}, names = ['single', 'covered']) {
  const directory = await mkdtemp(join(tmpdir(), '3jsn-clip-invariants-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, 'fixture');
  const capture = join(directory, 'capture');
  await mkdir(fixture);
  await mkdir(capture);
  const requested = names.map(name => ({ name, scale: 1 }));
  const source = { 'index.html': '<div></div>', 'fixture.js': 'void 0;', 'cases.json': JSON.stringify(requested) };
  const definition = { schemaVersion: 1, backgroundColor: [255, 255, 255, 255],
    groups: [{ name: 'opaque-overlap', scale: 1, cases: requested.map(item => item.name) }] };
  const report = { cssViewport: { width: 64, height: 64 }, paintTraversal: 'ownership',
    inputs: Object.fromEntries(Object.values(source).map((bytes, index) =>
      [['htmlSha256', 'scriptSha256', 'casesSha256'][index], hash(bytes)])), cases: [] };
  const images = requested.map(() => {
    const png = new PNG({ width: 64, height: 64 });
    png.data.fill(255);
    for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) png.data.set([224, 32, 48, 255], (y * 64 + x) * 4);
    png.data.set([240, 144, 152, 255], (7 * 64 + 8) * 4);
    return png;
  });
  report.cases = requested.map((entry, index) => ({ ...entry, width: 64, height: 64,
    file: `${entry.name}.png`, pixelSha256: hash(images[index].data),
    layout: Object.fromEntries(['outer', 'middle', 'subject'].map(id => [id, { x: 8, y: 8, width: 16, height: 16 }])),
    paintCalls: 1, paint: { scale: 1 }, gpuErrors: [] }));
  mutate({ images, report, definition, source });
  for (const [file, bytes] of Object.entries(source)) await writeFile(join(fixture, file), bytes);
  await writeFile(join(fixture, 'invariants.json'), JSON.stringify(definition));
  for (const [index, png] of images.entries()) await writeFile(join(capture, report.cases[index].file), PNG.sync.write(png));
  await writeFile(join(capture, 'report.json'), JSON.stringify(report));
  const output = join(directory, 'comparison.json');
  const result = spawnSync(process.execPath, [comparator, fixture, capture, output], { encoding: 'utf8', timeout: 10_000 });
  return { ...result, report: await readFile(output, 'utf8').then(JSON.parse).catch(() => undefined) };
}

test('clip invariants accept complete identical images with visible subjects', async t => {
  const result = await compare(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.passed, 1);
  assert.equal(result.report.groups[0].comparisons[0].subjectPixels, 256);
  assert.equal(result.report.groups[0].referenceIntermediatePixels, 1);
});

test('clip invariants include outermost pixels and a one-channel difference of one', async t => {
  const result = await compare(t, ({ images, report }) => {
    images[1].data[3] = 254;
    report.cases[1].pixelSha256 = hash(images[1].data);
  });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.report.groups[0].comparisons[0].firstDifference,
    { x: 0, y: 0, reference: [255, 255, 255, 255], actual: [255, 255, 255, 254] });
  assert.equal(result.report.groups[0].comparisons[0].differingPixels, 1);
  assert.equal(result.report.groups[0].comparisons[0].maxChannelDifference, 1);
  assert.equal(result.report.groups[0].comparisons[0].differingPixelsOverTwo, 0);
});

test('clip invariants reject aliased references without intermediate colors', async t => {
  const result = await compare(t, ({ images, report }) => {
    for (const [index, png] of images.entries()) {
      png.data.set([255, 255, 255, 255], (7 * 64 + 8) * 4);
      report.cases[index].pixelSha256 = hash(png.data);
    }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Reference has no intermediate edge colors/);
  assert.equal(result.report, undefined);
});

test('clip invariants report inclusive bounds and secondary counts without relaxing equality', async t => {
  const result = await compare(t, ({ images, report }) => {
    images[1].data[0] = 251;
    images[1].data[(64 * 64 - 1) * 4] = 252;
    report.cases[1].pixelSha256 = hash(images[1].data);
  });
  assert.equal(result.status, 1, result.stderr);
  const comparison = result.report.groups[0].comparisons[0];
  assert.equal(comparison.differingPixels, 2);
  assert.equal(comparison.differingPixelsOverTwo, 2);
  assert.equal(comparison.maxChannelDifference, 4);
  assert.deepEqual(comparison.differenceBounds, { left: 0, top: 0, right: 63, bottom: 63 });
});

test('clip invariants reject captures omitted from every comparison group', async t => {
  const result = await compare(t, ({ definition }) => { definition.groups[0].cases.pop(); }, ['single', 'covered', 'omitted']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Some captures have no declared comparison group/);
  assert.equal(result.report, undefined);
});

test('clip invariants reject stale pixels and stale fixture identity', async t => {
  for (const [name, mutate, message] of [
    ['pixels', ({ images }) => { images[1].data[0] = 0; }, /Capture pixel identity differs/],
    ['source', ({ source }) => { source['fixture.js'] += 'void 1;'; }, /Fixture identity differs/],
  ]) await t.test(name, async child => {
    const result = await compare(child, mutate);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(result.report, undefined);
  });
});

test('clip invariants reject blank subjects, changed geometry and native GPU errors', async t => {
  for (const [name, mutate, message] of [
    ['blank', ({ images, report }) => { images[1].data.fill(255); report.cases[1].pixelSha256 = hash(images[1].data); }, /Subject is not visibly exercised/],
    ['geometry', ({ report }) => { report.cases[1].layout.subject.x++; }, /Invariant geometry differs/],
    ['gpu', ({ report }) => { report.cases[1].gpuErrors.push('validation error'); }, /validation error/],
  ]) await t.test(name, async child => {
    const result = await compare(child, mutate);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(result.report, undefined);
  });
});

test('clip invariants require distinct captures at the declared scale', async t => {
  for (const [name, mutate, message] of [
    ['duplicate', ({ definition }) => { definition.groups[0].cases[1] = 'single'; }, /requires distinct cases/],
    ['scale', ({ definition }) => { definition.groups[0].scale = 2; }, /Missing invariant capture/],
  ]) await t.test(name, async child => {
    const result = await compare(child, mutate);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(result.report, undefined);
  });
});
