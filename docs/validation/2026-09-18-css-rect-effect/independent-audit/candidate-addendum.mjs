import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { createSubjectColorMatcher } from '../../scripts/compatibility/paint-colors.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const base = 'artifacts/css-rect-boundary';
const out = '.cache/css-rect-boundary-audit';
const prior = await json(`${out}/audit.json`);
const candidate = await json(`${base}/candidate/report.json`);
const baseline = await json(`${base}/native/report.json`);
const browser = await json(`${base}/browser/report.json`);
const binary = await json(`${base}/candidate-binary.json`);
assert.equal(sha(await readFile(binary.path)), binary.sha256);
assert.deepEqual(candidate.inputs, baseline.inputs);
assert.deepEqual(candidate.inputs, browser.inputs);
assert.equal(candidate.backend, 'Metal');
assert.equal(candidate.offscreen, true);
assert.equal(candidate.nativeDeviceIdentityChecked, true);
assert.equal(candidate.nativeQueueIdentityChecked, true);
assert.equal(candidate.cases.length, 16);

async function image(path, expected) {
  const bytes = await readFile(path);
  const png = PNG.sync.read(bytes);
  assert.equal(sha(png.data), expected.pixelSha256, path);
  assert.equal(png.width, expected.width);
  assert.equal(png.height, expected.height);
  return { path, png, encodedSha256: sha(bytes), rgbaSha256: sha(png.data) };
}
const difference = (a, b, bounds) => {
  let pixels = 0, pixelsOverTwo = 0, maxChannelDifference = 0, outsidePerimeter = 0;
  const overTwoCoordinates = [];
  for (let offset = 0; offset < a.data.length; offset += 4) {
    let delta = 0;
    for (let channel = 0; channel < 4; channel++) delta = Math.max(delta, Math.abs(a.data[offset + channel] - b.data[offset + channel]));
    if (!delta) continue;
    const x = offset / 4 % a.width, y = Math.floor(offset / 4 / a.width);
    pixels++;
    if (delta > 2) {
      pixelsOverTwo++;
      if (overTwoCoordinates.length < 16) overTwoCoordinates.push({ x, y, delta });
    }
    maxChannelDifference = Math.max(delta, maxChannelDifference);
    if (!((x === bounds.left || x === bounds.right) && y >= bounds.top && y <= bounds.bottom)
      && !((y === bounds.top || y === bounds.bottom) && x >= bounds.left && x <= bounds.right)) outsidePerimeter++;
  }
  return { pixels, pixelsOverTwo, maxChannelDifference, outsidePerimeter, overTwoCoordinates };
};
const captures = [], images = new Map();
for (const [index, item] of candidate.cases.entries()) {
  const old = baseline.cases[index], reference = browser.cases[index];
  for (const key of ['name', 'scale', 'width', 'height', 'subjectColor', 'layout', 'paint', 'paintCalls', 'gpuErrors']) assert.deepEqual(item[key], old[key]);
  assert.equal(item.paintCalls, 1);
  assert.deepEqual(item.gpuErrors, []);
  const current = await image(`${base}/candidate/${item.file}`, item);
  const before = await image(`${base}/native/${old.file}`, old);
  const expected = await image(`${base}/browser/${reference.file}`, reference);
  const bounds = { left: 72 * item.scale, top: 56 * item.scale, right: 256 * item.scale, bottom: 176 * item.scale };
  const matches = createSubjectColorMatcher(item.subjectColor);
  let subjectPixels = 0, intermediatePixels = 0, nonwhiteOutsideBounds = 0, wrongInteriorPixels = 0;
  for (let y = 0; y < current.png.height; y++) {
    for (let x = 0; x < current.png.width; x++) {
      const offset = (y * current.png.width + x) * 4;
      const nonwhite = [0, 1, 2, 3].some((channel) => current.png.data[offset + channel] !== 255);
      const subject = matches(current.png.data, offset);
      if (subject) subjectPixels++;
      if (!subject && nonwhite) intermediatePixels++;
      if (nonwhite && (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom)) nonwhiteOutsideBounds++;
      if (x > bounds.left && x < bounds.right && y > bounds.top && y < bounds.bottom && !subject) wrongInteriorPixels++;
    }
  }
  assert.equal(subjectPixels, item.scale === 1 ? 21777 : 87713);
  assert.equal(intermediatePixels, item.scale === 1 ? 608 : 1216);
  assert.equal(nonwhiteOutsideBounds, 0);
  assert.equal(wrongInteriorPixels, 0);
  const delta = difference(current.png, before.png, bounds);
  assert.equal(delta.outsidePerimeter, 0);
  const againstBrowser = difference(current.png, expected.png, bounds);
  assert.equal(againstBrowser.pixelsOverTwo, 4);
  assert.equal(againstBrowser.outsidePerimeter, 0);
  for (const point of againstBrowser.overTwoCoordinates) {
    assert.ok([bounds.left, bounds.right].includes(point.x) && [bounds.top, bounds.bottom].includes(point.y));
  }
  const payloadUnchanged = JSON.stringify(item) === JSON.stringify(old);
  const shouldChange = item.name.includes('opacity-half-covered-blue');
  assert.equal(!payloadUnchanged, shouldChange);
  assert.equal(current.encodedSha256 !== before.encodedSha256, shouldChange);
  assert.equal(delta.pixels, shouldChange ? (item.scale === 1 ? 608 : 1216) : 0);
  images.set(JSON.stringify([item.name, item.scale]), current);
  captures.push({ name: item.name, scale: item.scale, path: current.path,
    encodedSha256: current.encodedSha256, rgbaSha256: current.rgbaSha256,
    baselineEncodedSha256: before.encodedSha256, payloadUnchanged, boundsInclusive: bounds,
    subjectPixels, intermediatePixels, nonwhiteOutsideBounds, wrongInteriorPixels,
    comparedWithBaseline: delta, comparedWithBrowser: againstBrowser });
}
for (const item of candidate.cases.filter((item) => item.name.startsWith('polygon-'))) {
  assert.equal(images.get(JSON.stringify([item.name, item.scale])).encodedSha256,
    images.get(JSON.stringify([item.name.slice('polygon-'.length), item.scale])).encodedSha256);
}
const groups = [];
for (const group of (await json('fixtures/opacity-css-rect/invariants.json')).groups) {
  const a = images.get(JSON.stringify([group.cases[0], group.scale]));
  const b = images.get(JSON.stringify([group.cases[1], group.scale]));
  const bounds = { left: 72 * group.scale, top: 56 * group.scale, right: 256 * group.scale, bottom: 176 * group.scale };
  const delta = difference(a.png, b.png, bounds);
  assert.equal(delta.pixels, group.scale === 1 ? 608 : 1216);
  assert.equal(delta.outsidePerimeter, 0);
  groups.push({ name: group.name, scale: group.scale, ...delta });
}
const regenerations = [];
for (const [tool, args, saved] of [
  ['experiments/dom-canvas/compare-clip-invariants.mjs', ['fixtures/opacity-css-rect', `${base}/candidate`], `${base}/candidate-invariants.json`],
  ['experiments/dom-canvas/compare-clips.mjs', [`${base}/browser`, `${base}/candidate`], `${base}/candidate-comparison.json`],
]) {
  const target = `${out}/regenerated-${saved.split('/').at(-1)}`;
  const result = spawnSync(process.execPath, [tool, ...args, target], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(await readFile(target), await readFile(saved));
  regenerations.push({ saved, regenerated: target, sha256: sha(await readFile(saved)), exitCode: result.status });
}
const comparison = await json(`${base}/candidate-comparison.json`);
assert.equal(comparison.passed, 0);
for (const item of comparison.cases) {
  assert.equal(item.differingInteriorPixels, 0);
  assert.deepEqual(item.geometryDifferences, [
    { node: 'middle', field: 'x', browser: 48.375, native: 48 },
    { node: 'middle', field: 'y', browser: 40.25, native: 40 },
    { node: 'subject', field: 'x', browser: 32.375, native: 32 },
    { node: 'subject', field: 'y', browser: 24.25, native: 24 },
  ]);
}
const regressions = [];
for (const entry of await json(`${base}/regression-results.json`)) {
  assert.equal(entry.binarySha256, binary.sha256);
  const currentPath = `${base}/regression/${entry.fixture}/report.json`;
  const bytes = await readFile(currentPath), previous = await readFile(entry.priorReport);
  assert.deepEqual(bytes, previous);
  assert.equal(sha(bytes), entry.reportSha256);
  assert.equal(sha(previous), entry.priorReportSha256);
  const report = JSON.parse(bytes);
  assert.equal(report.cases.length, entry.cases);
  assert.ok((await readFile(`${dirname(currentPath)}/stderr.txt`, 'utf8')).includes('Metal API Validation Enabled'));
  const pngs = [];
  for (const item of report.cases) {
    const path = join(dirname(currentPath), item.file);
    const png = await image(path, item);
    assert.deepEqual(await readFile(path), await readFile(join(dirname(entry.priorReport), item.file)));
    assert.equal(item.paintCalls, 1);
    assert.deepEqual(item.gpuErrors, []);
    pngs.push({ path, encodedSha256: png.encodedSha256, rgbaSha256: png.rgbaSha256 });
  }
  regressions.push({ fixture: entry.fixture, report: currentPath, priorReport: entry.priorReport,
    reportSha256: sha(bytes), count: pngs.length, allReportsAndPngFilesByteIdentical: true, pngs });
}
assert.equal(regressions.reduce((sum, item) => sum + item.count, 0), 190);
const pins = {};
for (const path of [
  ...Object.keys(prior.sourceAndReportSha256).filter((path) => path.startsWith('fixtures/') || path.startsWith('scripts/') || path.startsWith('experiments/')),
  `${base}/candidate/report.json`, `${base}/candidate-binary.json`, `${base}/candidate-invariants.json`,
  `${base}/candidate-comparison.json`, `${base}/regression-results.json`, `${base}/candidate/stderr.txt`,
]) {
  pins[path] = sha(await readFile(path));
  if (prior.sourceAndReportSha256[path]) assert.equal(pins[path], prior.sourceAndReportSha256[path]);
}
assert.ok((await readFile(`${base}/candidate/stderr.txt`, 'utf8')).includes('Metal API Validation Enabled'));
const result = {
  schemaVersion: 1, status: 'verified-bounded-candidate-repair',
  scope: 'Read existing PNGs, reports, sources and binaries; regenerate two comparison reports in this scratch directory. No capture, build, preparation or source edit.',
  binary, sourceAndReportSha256: pins, captures, groups, regenerations, regressions,
  summary: { candidateCaptures: 16, changedCasePayloadsAndPngs: 4, unchangedCasePayloadsAndPngs: 12,
    candidateExactInvariantGroups: 0, browserExactInvariantGroups: 0, totalGroups: 8,
    uniformInteriorMatches: 16, combinedGeometryAndInteriorMatches: 0,
    browserDifferencesOverTwoOnlyAtFourCornersPerCase: true,
    unchangedPriorCapturesVerified: 190, dpr2SingleFillPixelsUnchangedFromAuditedBaseline: true },
  limits: [
    'Observed pair classification now agrees with Chrome; this is not a full antialias or CSS conformance claim.',
    'All cases retain the four known CSSOM x/y translation differences. DPR transition invalidation is not exercised.',
    'Binary hash verification establishes the frozen executable identity; this audit does not reconstruct its build provenance.',
  ],
};
await writeFile(`${out}/candidate-addendum.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result.summary));
