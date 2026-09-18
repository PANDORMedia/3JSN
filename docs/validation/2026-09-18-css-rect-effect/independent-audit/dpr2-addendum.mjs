import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const priorPath = '.cache/css-rect-boundary-audit/audit.json';
const prior = await json(priorPath);
const pins = {};
for (const [path, expected] of Object.entries(prior.sourceAndReportSha256)) {
  const actual = sha(await readFile(path));
  assert.equal(actual, expected, path);
  pins[path] = actual;
}
const binary = await json('artifacts/css-rect-boundary/native-binary.json');
assert.equal(sha(await readFile(binary.binary)), binary.sha256);
const strips = {
  left: { x0: 144, x1: 144, y0: 114, y1: 350, scaled: 0.25, unscaled: 0.625 },
  right: { x0: 512, x1: 512, y0: 114, y1: 350, scaled: 0.75, unscaled: 0.375 },
  top: { x0: 146, x1: 510, y0: 112, y1: 112, scaled: 0.5, unscaled: 0.75 },
  bottom: { x0: 146, x1: 510, y0: 352, y1: 352, scaled: 0.5, unscaled: 0.25 },
};
const captures = [];
for (const priorRun of prior.runs) {
  const report = await json(priorRun.report);
  for (const item of report.cases.filter((entry) => entry.scale === 2)) {
    const priorCapture = priorRun.captures.find((entry) => entry.name === item.name && entry.scale === 2);
    assert.ok(priorCapture);
    const bytes = await readFile(priorCapture.file);
    const png = PNG.sync.read(bytes);
    assert.equal(sha(bytes), priorCapture.encodedSha256);
    assert.equal(sha(png.data), priorCapture.rgbaSha256);
    assert.equal(sha(png.data), item.pixelSha256);
    assert.equal(png.width, 896);
    assert.equal(png.height, 512);
    const pixel = (x, y) => Array.from(png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4));
    const result = {
      renderer: priorRun.renderer, name: item.name, scale: 2,
      path: priorCapture.file, encodedSha256: sha(bytes), rgbaSha256: sha(png.data),
      usedForTranslationInference: item.name.endsWith('-single'),
    };
    if (result.usedForTranslationInference) {
      const interior = pixel(200, 200);
      assert.equal(interior[3], 255);
      result.interiorSample = { x: 200, y: 200, rgba: interior };
      result.edgeStrips = {};
      for (const [edge, strip] of Object.entries(strips)) {
        const values = new Map();
        let count = 0;
        let maxScaledRgbResidual = 0;
        let minUnscaledGreenResidual = Infinity;
        for (let y = strip.y0; y <= strip.y1; y++) {
          for (let x = strip.x0; x <= strip.x1; x++) {
            const actual = pixel(x, y);
            assert.equal(actual[3], 255);
            const key = actual.join(',');
            values.set(key, (values.get(key) ?? 0) + 1);
            for (let channel = 0; channel < 3; channel++) {
              const expected = 255 + strip.scaled * (interior[channel] - 255);
              maxScaledRgbResidual = Math.max(maxScaledRgbResidual, Math.abs(actual[channel] - expected));
            }
            const unscaledGreen = 255 + strip.unscaled * (interior[1] - 255);
            minUnscaledGreenResidual = Math.min(minUnscaledGreenResidual, Math.abs(actual[1] - unscaledGreen));
            count++;
          }
        }
        assert.equal(values.size, 1, `${result.path} ${edge}: uniform straight edge`);
        assert.ok(maxScaledRgbResidual <= 1, `${result.path} ${edge}: scaled hypothesis`);
        assert.ok(minUnscaledGreenResidual >= 28, `${result.path} ${edge}: unscaled hypothesis rejected`);
        const rgba = [...values.keys()][0].split(',').map(Number);
        result.edgeStrips[edge] = {
          boundsInclusive: { x0: strip.x0, y0: strip.y0, x1: strip.x1, y1: strip.y1 },
          pixels: count, rgba,
          coverageInferredFromGreen: (255 - rgba[1]) / (255 - interior[1]),
          scaledTranslationExpectedCoverage: strip.scaled,
          unscaledTranslationExpectedCoverage: strip.unscaled,
          maxScaledRgbResidual, minUnscaledGreenResidual,
        };
      }
    }
    captures.push(result);
  }
}
assert.equal(captures.length, 16);
const inferred = captures.filter((entry) => entry.usedForTranslationInference);
assert.equal(inferred.length, 8);
for (const native of inferred.filter((entry) => entry.renderer === 'native')) {
  const browser = inferred.find((entry) => entry.renderer === 'browser' && entry.name === native.name);
  assert.deepEqual(native.edgeStrips, browser.edgeStrips);
}
const failurePath = 'artifacts/css-rect-boundary/dpr-transition-failure.txt';
const failure = await readFile(failurePath, 'utf8');
assert.ok(failure.includes('103.375 != 103.75'));
const addendum = {
  schemaVersion: 1,
  status: 'verified-recorded-dpr2-pixels-only',
  priorAudit: { path: priorPath, sha256: sha(await readFile(priorPath)) },
  scope: 'Read existing files only; no capture, build, source preparation, renderer change or CPU-test execution. Output is limited to this audit directory.',
  deviceGeometryHypotheses: {
    scaledTranslation: { left: 144.75, top: 112.5, right: 512.75, bottom: 352.5 },
    unscaledTranslation: { left: 144.375, top: 112.25, right: 512.375, bottom: 352.25 },
    sharedInclusivePixelBounds: { left: 144, top: 112, right: 512, bottom: 352 },
  },
  method: 'Use single-fill states to avoid repeated per-contribution clipping. On opaque white, infer coverage as (255 - edge green)/(255 - interior green). Compare RGB against white/interior interpolation, retaining channel quantization tolerance. Strips exclude corners; no general corner antialias equivalence is inferred.',
  counts: {
    verifiedDpr2Pngs: captures.length, singleFillPngsWithStrips: inferred.length,
    straightEdgePixelsChecked: inferred.reduce((sum, item) => sum + Object.values(item.edgeStrips).reduce((n, edge) => n + edge.pixels, 0), 0),
  },
  captures,
  binary: { path: binary.binary, sha256: binary.sha256 },
  sourceAndReportSha256: pins,
  separateCpuFailure: {
    path: failurePath, sha256: sha(failure), assertion: '103.375 != 103.75',
    relation: 'The preserved failure was observed during a resolved-document DPR transition. This audit does not execute or diagnose invalidation. Fresh fixture style mutation and the recorded GPU capture path do not establish cached DPR-transition correctness.',
  },
  conclusion: 'The recorded browser and native DPR 2 straight edges agree with the scaled .75/.5 translation, and reject the unscaled .375/.25 hypothesis by at least 28 green-channel levels on every sampled edge. Inclusive support alone could not prove that result. The earlier physical-paint statement is supported for these captures by fractional coverage, and must not be generalized to cached document DPR transitions.',
};
await writeFile('.cache/css-rect-boundary-audit/dpr2-addendum.json', `${JSON.stringify(addendum, null, 2)}\n`);
console.log(JSON.stringify({ status: addendum.status, ...addendum.counts }));
