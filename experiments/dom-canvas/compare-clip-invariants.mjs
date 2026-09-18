import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { createSubjectColorMatcher, subjectColor } from '../../scripts/compatibility/paint-colors.mjs';

const [fixtureDirectory, captureDirectory, outputFile] = process.argv.slice(2);
if (!fixtureDirectory || !captureDirectory || !outputFile || process.argv.length !== 5) {
  console.error('Usage: node experiments/dom-canvas/compare-clip-invariants.mjs <fixture-directory> <capture-directory> <report.json>');
  process.exit(2);
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const captureBytes = await readFile(resolve(captureDirectory, 'report.json'));
const definitionBytes = await readFile(resolve(fixtureDirectory, 'invariants.json'));
const capture = JSON.parse(captureBytes);
const definition = JSON.parse(definitionBytes);
assert.equal(definition.schemaVersion, 1);
assert(definition.backgroundColor !== undefined, 'Declare the control background color');
const background = subjectColor(definition.backgroundColor);
assert(Array.isArray(definition.groups) && definition.groups.length > 0, 'No invariant groups');
for (const [file, field] of [['index.html', 'htmlSha256'], ['fixture.js', 'scriptSha256'], ['cases.json', 'casesSha256']]) {
  assert.equal(capture.inputs[field], hash(await readFile(resolve(fixtureDirectory, file))), `Fixture identity differs: ${file}`);
}
const requested = JSON.parse(await readFile(resolve(fixtureDirectory, 'cases.json')));
assert.equal(capture.cases.length, requested.length, 'Capture count differs');
const images = new Map();
for (const [index, entry] of capture.cases.entries()) {
  const expected = requested[index];
  assert.equal(entry.name, expected.name);
  assert.equal(entry.scale, expected.scale ?? 1);
  assert(Number.isFinite(entry.scale) && entry.scale > 0, 'Invalid capture scale');
  assert.deepEqual(entry.subjectColor, expected.subjectColor);
  for (const id of ['outer', 'middle', 'subject']) {
    for (const field of ['x', 'y', 'width', 'height']) {
      assert(Number.isFinite(entry.layout?.[id]?.[field]), `Missing geometry: ${id}.${field}`);
    }
  }
  assert(entry.width === capture.cssViewport.width * entry.scale && entry.height === capture.cssViewport.height * entry.scale);
  if (capture.paintTraversal !== undefined) {
    assert.equal(entry.paintCalls, 1);
    assert.equal(entry.paint.scale, entry.scale);
    assert.deepEqual(entry.gpuErrors, []);
  }
  const png = PNG.sync.read(await readFile(resolve(captureDirectory, entry.file)));
  assert.equal(png.width, entry.width);
  assert.equal(png.height, entry.height);
  assert.equal(hash(png.data), entry.pixelSha256, 'Capture pixel identity differs');
  const matchesSubject = createSubjectColorMatcher(entry.subjectColor);
  let subjectPixels = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) if (matchesSubject(png.data, offset)) subjectPixels++;
  assert(subjectPixels > 100, `Subject is not visibly exercised: ${entry.name}`);
  const key = JSON.stringify([entry.name, entry.scale]);
  assert(!images.has(key), `Duplicate capture: ${key}`);
  images.set(key, { entry, png, subjectPixels });
}

const names = new Set();
const used = new Set();
const groups = [];
for (const group of definition.groups) {
  assert(typeof group.name === 'string' && group.name.length > 0 && !names.has(group.name), 'Invalid or duplicate group name');
  names.add(group.name);
  assert(Array.isArray(group.cases) && group.cases.length >= 2 && new Set(group.cases).size === group.cases.length, 'A group requires distinct cases');
  const members = group.cases.map(name => {
    const image = images.get(JSON.stringify([name, group.scale]));
    assert(image, `Missing invariant capture: ${name} at ${group.scale}x`);
    used.add(JSON.stringify([name, group.scale]));
    return image;
  });
  const [reference, ...rest] = members;
  const matchesSubject = createSubjectColorMatcher(reference.entry.subjectColor);
  let referenceIntermediatePixels = 0;
  for (let offset = 0; offset < reference.png.data.length; offset += 4) {
    if (!matchesSubject(reference.png.data, offset)
      && background.some((channel, index) => channel !== reference.png.data[offset + index])) referenceIntermediatePixels++;
  }
  assert(referenceIntermediatePixels > 0, `Reference has no intermediate edge colors: ${group.name}`);
  const comparisons = rest.map(actual => {
    assert.deepEqual(actual.entry.layout, reference.entry.layout, 'Invariant geometry differs');
    assert.deepEqual(actual.entry.subjectColor, reference.entry.subjectColor, 'Invariant subject colors differ');
    let differingPixels = 0;
    let maxChannelDifference = 0;
    let differingPixelsOverTwo = 0;
    let differenceBounds;
    let firstDifference;
    for (let offset = 0; offset < reference.png.data.length; offset += 4) {
      let delta = 0;
      for (let channel = 0; channel < 4; channel++) delta = Math.max(delta, Math.abs(reference.png.data[offset + channel] - actual.png.data[offset + channel]));
      if (!delta) continue;
      differingPixels++;
      if (delta > 2) differingPixelsOverTwo++;
      maxChannelDifference = Math.max(maxChannelDifference, delta);
      const x = (offset / 4) % reference.png.width, y = Math.floor(offset / 4 / reference.png.width);
      differenceBounds ??= { left: x, top: y, right: x, bottom: y };
      differenceBounds.left = Math.min(differenceBounds.left, x);
      differenceBounds.top = Math.min(differenceBounds.top, y);
      differenceBounds.right = Math.max(differenceBounds.right, x);
      differenceBounds.bottom = Math.max(differenceBounds.bottom, y);
      firstDifference ??= {
        x, y,
        reference: [...reference.png.data.subarray(offset, offset + 4)], actual: [...actual.png.data.subarray(offset, offset + 4)],
      };
    }
    return { name: actual.entry.name, identical: differingPixels === 0, differingPixels, differingPixelsOverTwo,
      maxChannelDifference, differenceBounds, firstDifference,
      pixelSha256: actual.entry.pixelSha256, subjectPixels: actual.subjectPixels };
  });
  groups.push({ ...group, referencePixelSha256: reference.entry.pixelSha256, referenceIntermediatePixels,
    identical: comparisons.every(item => item.identical), comparisons });
}
assert.equal(used.size, images.size, 'Some captures have no declared comparison group');
const passed = groups.filter(group => group.identical).length;
const report = {
  schemaVersion: 1, status: passed === groups.length ? 'passed' : 'partial', passed, total: groups.length,
  criteria: { completeRgbaEquality: true, crossRendererComparison: false, excludedPixels: 0, channelTolerance: 0,
    secondaryDifferenceCountThreshold: 2, backgroundColor: background },
  inputs: { captureReportSha256: hash(captureBytes), invariantsSha256: hash(definitionBytes),
    comparatorSha256: hash(await readFile(import.meta.filename)),
    subjectColorMatcherSha256: hash(await readFile(new URL('../../scripts/compatibility/paint-colors.mjs', import.meta.url))) },
  limits: ['These are proposed within-renderer image invariants, not a general browser-conformance result.',
    'The intermediate-color guard assumes these monochrome controls over their declared flat background; it is not a general edge detector.',
    'A nonidentical group is an observed classification, not automatically a standards violation.',
    'The secondary difference count never changes the exact-equality result.',
    'Cross-renderer antialias fidelity requires separate evidence.'],
  groups,
};
await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`);
console.table(groups.map(group => ({ group: group.name, scale: group.scale, identical: group.identical,
  differingPixels: group.comparisons.reduce((sum, item) => sum + item.differingPixels, 0) })));
console.log(`${report.status.toUpperCase()}: ${passed}/${groups.length} declared image-invariance groups.`);
if (report.status !== 'passed') process.exitCode = 1;
