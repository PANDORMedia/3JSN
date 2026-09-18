// SPDX-License-Identifier: MIT
import { WebGLRenderer, Scene, PerspectiveCamera, BoxGeometry, MeshBasicMaterial, Mesh, REVISION } from 'three';

const { createContext, closeContext, observeFrame } = globalThis.__webglHost;
const width = 128, height = 128;
const canvas = { width, height, style: {}, addEventListener() {}, removeEventListener() {} };
const gl = createContext(canvas, width, height);
function check(value, message) { if (!value) throw new Error(`Blending fixture: ${message}`); }
function error(expected, message) {
  check(gl.getError() === expected, message);
  check(gl.getError() === gl.NO_ERROR, 'unexpected additional GL error');
}
function pixels() {
  const data = new Uint8Array(width * height * 4);
  observeFrame(gl, data);
  error(gl.NO_ERROR, 'readback failed');
  return data;
}
const equations = () => [gl.getParameter(gl.BLEND_EQUATION_RGB), gl.getParameter(gl.BLEND_EQUATION_ALPHA)];
const factors = () => [gl.BLEND_SRC_RGB, gl.BLEND_DST_RGB, gl.BLEND_SRC_ALPHA, gl.BLEND_DST_ALPHA].map(pname => gl.getParameter(pname));
function same(actual, expected, message) {
  check(actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]) < 0.000001), message);
}
let renderer, geometry, material, report;
try {
  renderer = new WebGLRenderer({ canvas, context: gl, alpha: true, antialias: false, premultipliedAlpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.debug.onShaderError = () => { throw new Error('Blending fixture: Three shader compilation or linking failed'); };
  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 4;
  geometry = new BoxGeometry(1.6, 1.6, 0.1);
  material = new MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.5 });
  scene.add(new Mesh(geometry, material));
  renderer.render(scene, camera);
  error(gl.NO_ERROR, 'transparent Three render generated a GL error');
  const first = pixels();
  const centerOffset = (64 * width + 64) * 4;
  const center = [...first.slice(centerOffset, centerOffset + 4)];
  check(center.every((value, index) => Math.abs(value - [128, 0, 0, 128][index]) <= 1), 'center is not half-alpha premultiplied red');
  const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]].map(([x, y]) => {
    const offset = (y * width + x) * 4;
    return [...first.slice(offset, offset + 4)];
  });
  check(corners.every(pixel => pixel.every(value => value === 0)), 'transparent clear did not survive at all corners');
  let coveredPixels = 0;
  for (let offset = 0; offset < first.length; offset += 4) {
    if (first[offset + 3] === 0) {
      check(first[offset] === 0 && first[offset + 1] === 0 && first[offset + 2] === 0, 'transparent background contains nonzero color');
      continue;
    }
    coveredPixels++;
    check(Math.abs(first[offset] - first[offset + 3]) <= 1 && first[offset + 1] === 0 && first[offset + 2] === 0,
      'covered pixel is not premultiplied red');
    check(Math.abs(first[offset + 3] - 128) <= 1, 'single front face did not retain half alpha');
  }
  check(coveredPixels > 500 && coveredPixels < width * height / 2, 'transparent mesh coverage is missing or fills the background');

  // Seed only after Three renders: these direct state calls must not consume
  // an unrelated native error while setting valid blend state.
  gl.enable(0xffffffff);
  gl.blendEquation(gl.FUNC_SUBTRACT);
  same(equations(), [gl.FUNC_SUBTRACT, gl.FUNC_SUBTRACT], 'blendEquation did not update both channels');
  gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_REVERSE_SUBTRACT);
  same(equations(), [gl.FUNC_ADD, gl.FUNC_REVERSE_SUBTRACT], 'separate blend equations were lost');
  gl.blendFunc(gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA);
  same(factors(), [gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA, gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA], 'blendFunc did not update both channels');
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ZERO);
  same(factors(), [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ZERO], 'separate blend factors were lost');
  gl.blendColor(0.25, 0.5, 0.75, 1);
  same([...gl.getParameter(gl.BLEND_COLOR)], [0.25, 0.5, 0.75, 1], 'blendColor was not applied');
  error(gl.INVALID_ENUM, 'valid blend calls consumed the pending INVALID_ENUM');

  const before = [...equations(), ...factors()];
  const invalid = [
    ['blendEquation', () => gl.blendEquation(0xffffffff)],
    ['blendEquationSeparate', () => gl.blendEquationSeparate(gl.FUNC_SUBTRACT, 0xffffffff)],
    ['blendFunc', () => gl.blendFunc(0xffffffff, gl.ONE)],
    ['blendFuncSeparate', () => gl.blendFuncSeparate(gl.ONE, gl.ZERO, 0xffffffff, gl.ONE)],
  ];
  for (const [name, invoke] of invalid) {
    invoke();
    error(gl.INVALID_ENUM, `${name} accepted an invalid enum`);
    same([...equations(), ...factors()], before, `${name} partially changed state on rejection`);
    error(gl.NO_ERROR, `${name} state observation failed`);
  }
  gl.blendEquation(gl.FUNC_ADD);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  renderer.render(scene, camera);
  error(gl.NO_ERROR, 'render after rejected blend calls failed');
  const restored = pixels();
  check(restored.every((value, index) => value === first[index]), 'restoring blend state changed the transparent Three image');
  report = {
    status: 'offscreen-upstream-three-blending', threeRevision: REVISION, width, height,
    materialOpacity: 0.5, center, corners, coveredPixels,
    transparentPixels: width * height - coveredPixels,
    premultipliedPixelsVerified: true, validBlendMethods: 5,
    invalidEnumMethods: invalid.map(([name]) => name),
    pendingInvalidEnumPreserved: true, invalidCallsPreservedState: true, restoredPixelsIdentical: true,
    limitations: ['Injected canvas fixture; no DOM/window composition', 'Partial WebGL facade', 'Pixel readback is assertion-only', 'No performance claim'],
  };
} finally {
  try {
    geometry?.dispose();
    material?.dispose();
    renderer?.dispose();
  } finally {
    closeContext(gl);
  }
}
globalThis.__rendererInitReport = report;
