import { WebGLRenderer, REVISION } from 'three';

const { createContext, closeContext, observePixel } = globalThis.__webglHost;
function check(value, message) { if (!value) throw new Error(message); }
// Explicit canvas injection exercises upstream Three without claiming DOM integration.
const listeners = new Map();
const canvas = {
  width: 32, height: 32, style: {},
  addEventListener(type, listener) { listeners.set(type, listener); },
  removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
};
for (const width of [1.5, NaN, Infinity, 0, -1, 16385, 2 ** 32 + 32]) {
  let rejected = false;
  try { createContext(canvas, width, 32); } catch (error) { rejected = error instanceof RangeError; }
  check(rejected, 'Invalid host dimensions were accepted');
}
const gl = createContext(canvas, canvas.width, canvas.height);
const renderer = new WebGLRenderer({ canvas, context: gl });
check(renderer.getContext() === gl, 'Three replaced the supplied context');
check(gl.getError() === gl.NO_ERROR, 'Renderer initialization generated a GL error');
check(gl.getParameter(gl.VIEWPORT) instanceof Int32Array, 'Viewport is not typed');
check(renderer.capabilities.maxTextures > 0, 'No native texture limits');
check(renderer.getContextAttributes().antialias === false, 'Attributes hide native configuration');
renderer.setClearColor(0xff0000, 1);
renderer.clear();
const guarded = new Uint8Array(12).fill(91);
observePixel(gl, guarded.subarray(4, 8));
check(guarded.slice(4, 8).join() === '255,0,0,255', 'Three clear did not reach the GPU');
check(guarded.slice(0, 4).every(x => x === 91) && guarded.slice(8).every(x => x === 91), 'Readback overwrote guards');
const texture = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, texture);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(3));
check(gl.getError() === gl.INVALID_OPERATION, 'Short upload was not rejected');
check(gl.getError() === gl.NO_ERROR, 'Error flag was not consumed');
gl.deleteTexture(texture);
gl.deleteTexture(texture);
gl.bindTexture(gl.TEXTURE_2D, texture);
check(gl.getError() === gl.INVALID_OPERATION, 'Deleted texture was accepted');
const other = createContext(canvas, 4, 4);
other.bindTexture(other.TEXTURE_2D, gl.createTexture());
check(other.getError() === other.INVALID_OPERATION, 'Cross-context object was accepted');
closeContext(other);
const beforeViewport = [...gl.getParameter(gl.VIEWPORT)];
gl.viewport(0, 0, -1, 4);
check(gl.getError() === gl.INVALID_VALUE, 'Negative viewport size was accepted');
check([...gl.getParameter(gl.VIEWPORT)].join() === beforeViewport.join(), 'Invalid viewport mutated state');
check(gl.getShaderPrecisionFormat(0xffffffff, gl.HIGH_FLOAT) === null, 'Invalid shader enum accepted');
check(gl.getError() === gl.INVALID_ENUM, 'Invalid precision query did not flag an error');
check(gl.getParameter(0xffffffff) === null, 'Unknown parameter did not return null');
gl.getParameter(gl.VIEWPORT);
check(gl.getError() === gl.INVALID_ENUM, 'Unknown parameter did not set GL error');
gl.texImage2D(0xffffffff, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
gl.enable(0xffffffff);
check(gl.getError() === gl.INVALID_ENUM, 'Mixed validation errors were not reported');
check(gl.getError() === gl.NO_ERROR, 'Identical outstanding errors were not coalesced');
const report = { status: 'upstream-renderer-initialization-only', threeRevision: REVISION,
  renderer: gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION),
  maxTextures: renderer.capabilities.maxTextures, pixel: [...guarded.slice(4, 8)],
  limitations: ['No geometry draw yet', 'Injected canvas fixture; no DOM/window integration',
    'Partial WebGL API; no conformance claim', 'macOS Metal only'] };
renderer.dispose();
check(listeners.size === 0, 'Renderer listeners remain after disposal');
check(gl.getError() === gl.NO_ERROR, 'Renderer disposal generated a GL error');
closeContext(gl);
globalThis.__rendererInitReport = report;
