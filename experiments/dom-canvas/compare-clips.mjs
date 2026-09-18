import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';

const [browserDirectory, nativeDirectory, outputFile] = process.argv.slice(2);
if (!browserDirectory || !nativeDirectory || !outputFile || process.argv.length !== 5) {
  console.error('Usage: node experiments/dom-canvas/compare-clips.mjs <browser-directory> <native-directory> <report.json>');
  process.exit(2);
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
const load = async directory => JSON.parse(await readFile(resolve(directory, 'report.json'), 'utf8'));
const [browser, native] = await Promise.all([load(browserDirectory), load(nativeDirectory)]);
assert(browser.cases.length > 0, 'Empty captures cannot establish parity');
assert.equal(native.cases.length, browser.cases.length, 'Capture counts differ');
assert.deepEqual(native.cssViewport, browser.cssViewport, 'CSS viewports differ');
for (const key of ['htmlSha256', 'scriptSha256', 'casesSha256']) {
  assert.match(browser.inputs[key], /^[a-f0-9]{64}$/);
  assert.equal(native.inputs[key], browser.inputs[key], `Fixture source differs: ${key}`);
}

async function image(directory, capture) {
  const png = PNG.sync.read(await readFile(resolve(directory, capture.file)));
  assert.equal(png.width, capture.width);
  assert.equal(png.height, capture.height);
  assert.equal(sha256(png.data), capture.pixelSha256, 'Capture pixels differ from recorded identity');
  return png;
}

const comparisons = [];
for (const [index, expected] of browser.cases.entries()) {
  const actual = native.cases[index];
  for (const field of ['name', 'scale', 'width', 'height']) assert.equal(actual[field], expected[field]);
  assert.equal(actual.width, native.cssViewport.width * actual.scale);
  assert.equal(actual.height, native.cssViewport.height * actual.scale);
  assert.equal(actual.paint.scale, actual.scale);
  assert.deepEqual(actual.gpuErrors, []);
  assert.equal(actual.paintCalls, 1, 'A second layout pass can conceal stale paint coordinates');
  const [reference, capture] = await Promise.all([image(browserDirectory, expected), image(nativeDirectory, actual)]);
  const { width, height } = reference;
  let differingPixels = 0;
  let interiorPixels = 0;
  let differingInteriorPixels = 0;
  let firstInteriorDifference;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const differs = [0, 1, 2, 3].some(channel => Math.abs(reference.data[offset + channel] - capture.data[offset + channel]) > 2);
      if (differs) differingPixels++;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) continue;
      // Browser-uniform 3x3 neighborhoods exclude its rasterized shape edges.
      // Interior mismatches still expose missing clips and misplaced geometry.
      let interior = true;
      for (let dy = -1; dy <= 1 && interior; dy++) {
        for (let dx = -1; dx <= 1 && interior; dx++) {
          const adjacent = ((y + dy) * width + x + dx) * 4;
          interior = [0, 1, 2, 3].every(channel => reference.data[offset + channel] === reference.data[adjacent + channel]);
        }
      }
      if (!interior) continue;
      interiorPixels++;
      if (differs) {
        differingInteriorPixels++;
        firstInteriorDifference ??= { x, y, browser: [...reference.data.subarray(offset, offset + 4)], native: [...capture.data.subarray(offset, offset + 4)] };
      }
    }
  }
  assert(interiorPixels > width * height * 0.8, 'Fixture has too little uniform interior for this comparator');
  const geometryDifferences = [];
  for (const node of ['outer', 'middle', 'subject']) {
    for (const field of ['x', 'y', 'width', 'height']) {
      const a = actual.layout[node][field], b = expected.layout[node][field];
      assert(Number.isFinite(a) && Number.isFinite(b));
      if (Math.abs(a - b) > 0.1) geometryDifferences.push({ node, field, browser: b, native: a });
    }
  }
  comparisons.push({ name: expected.name, scale: expected.scale,
    interiorAndGeometryMatch: differingInteriorPixels === 0 && geometryDifferences.length === 0,
    differingPixels, interiorPixels, differingInteriorPixels, firstInteriorDifference, geometryDifferences,
    browser: { file: expected.file, pixelSha256: expected.pixelSha256 },
    native: { file: actual.file, pixelSha256: actual.pixelSha256 } });
}
const passed = comparisons.filter(item => item.interiorAndGeometryMatch).length;
const report = { schemaVersion: 1, status: passed === comparisons.length ? 'passed' : 'partial',
  passed, total: comparisons.length, browser: browser.browser, nativeDevice: native.device,
  criteria: { maxChannelDifference: 2, maxGeometryDifferenceCssPixels: 0.1, rasterEdgeExclusion: 'Non-uniform browser 3x3 neighborhoods and outermost image pixels', nativePaintCallsPerCase: 1 },
  limits: ['Edges are counted separately; interior parity does not prove identical antialiasing.', 'Only the recorded ordered cases, viewport and device scales were compared.'],
  inputs: { browserReportSha256: sha256(await readFile(resolve(browserDirectory, 'report.json'))),
    nativeReportSha256: sha256(await readFile(resolve(nativeDirectory, 'report.json'))),
    comparatorSha256: sha256(await readFile(import.meta.filename)) },
  cases: comparisons };
await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`);
console.table(comparisons.map(item => ({ case: item.name, scale: item.scale, interiorDifferences: item.differingInteriorPixels, geometryDifferences: item.geometryDifferences.length, match: item.interiorAndGeometryMatch })));
console.log(`${report.status.toUpperCase()}: ${passed}/${comparisons.length} cases match browser geometry and uniform interior pixels.`);
if (report.status !== 'passed') process.exitCode = 1;
