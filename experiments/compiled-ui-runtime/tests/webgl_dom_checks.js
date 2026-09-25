(() => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  check(globalThis.__angleProbe === undefined && globalThis.__webglHost === undefined, 'Probe globals leaked into DOM host');
  const canvas = document.getElementById('scene');
  check(canvas instanceof HTMLCanvasElement && canvas.parentNode === document.body, 'Three did not create a real DOM canvas');
  const gl = canvas.getContext('webgl2');
  check(gl === canvas.getContext('webgl2') && gl.canvas === canvas, 'Canvas context identity changed');
  check(canvas.getContext('webgpu') === null && canvas.getContext('2d') === null, 'Canvas accepted incompatible mode');
  check(canvas.width === 96 && canvas.height === 96 && gl.drawingBufferWidth === 96 && gl.drawingBufferHeight === 96, 'setSize did not resize native storage');
  check(gl.getError() === gl.NO_ERROR, 'DOM fixture generated a GL error');
  const pixels = new Uint8Array(96 * 96 * 4); __observeNativeFrame(gl, pixels);
  const colors = new Set();
  for (let i = 0; i < pixels.length; i += 4) colors.add(`${pixels[i]},${pixels[i+1]},${pixels[i+2]}`);
  check(colors.size >= 4, 'DOM Three mesh pixels are missing');
  const alpha = gl.getContextAttributes().alpha;
  const isInitialized = bytes => bytes.every((value, index) => value === (index % 4 === 3 && !alpha ? 255 : 0));
  const viewport = [...gl.getParameter(gl.VIEWPORT)];
  canvas.width = 80;
  check(gl.drawingBufferWidth === 80 && gl.drawingBufferHeight === 96, 'Attribute resize did not reach native storage');
  check([...gl.getParameter(gl.VIEWPORT)].join() === viewport.join(), 'Resize changed application viewport state');
  let resized = new Uint8Array(80 * 96 * 4); __observeNativeFrame(gl, resized);
  check(isInitialized(resized), 'Resized drawing buffer was not initialized');
  gl.clearColor(1,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
  canvas.setAttribute('width', '80');
  resized = new Uint8Array(80 * 96 * 4); __observeNativeFrame(gl, resized);
  check(isInitialized(resized), 'Repeated dimension assignment did not reset storage');
  check(canvas.getContext('webgl2') === gl, 'Resize replaced the JS context');
  let resizeRejected = false;
  try { canvas.width = 0; } catch (error) { resizeRejected = error instanceof RangeError; }
  check(resizeRejected && gl.drawingBufferWidth === 80 && canvas.getContext('webgl2') === gl, 'Failed resize changed native state');
  canvas.width = 80;
  const failed = document.createElement('canvas');
  failed.width = 0;
  let createRejected = false;
  try { failed.getContext('webgl2'); } catch (error) { createRejected = error instanceof RangeError; }
  check(createRejected, 'Unsupported zero extent was accepted');
  failed.width = 16;
  check(failed.getContext('webgpu') !== null, 'Failed creation locked the canvas mode');
  const other = document.createElement('canvas');
  const gpu = other.getContext('webgpu');
  check(gpu !== null && gpu === other.getContext('webgpu') && other.getContext('webgl2') === null, 'WebGPU mode regressed');
  let rejected = false;
  try { HTMLCanvasElement.prototype.getContext.call(document.createElement('div'), 'webgl2'); } catch (error) { rejected = error instanceof TypeError; }
  check(rejected, 'Non-canvas receiver acquired a native context');
  const attributesCanvas = document.createElement('canvas');
  attributesCanvas.width = attributesCanvas.height = 4;
  for (const invalid of [false, 1, 'attributes', { powerPreference: 'invalid' }]) {
    let rejected = false;
    try { attributesCanvas.getContext('webgl2', invalid); } catch (error) { rejected = error instanceof TypeError; }
    check(rejected, 'Invalid context dictionary was accepted');
  }
  const order = [];
  const names = ['alpha', 'antialias', 'depth', 'desynchronized', 'failIfMajorPerformanceCaveat',
    'powerPreference', 'premultipliedAlpha', 'preserveDrawingBuffer', 'stencil'];
  const options = Object.fromEntries(names.map(name => [name, undefined]));
  for (const name of names) Object.defineProperty(options, name, { get() { order.push(name); return undefined; } });
  const attributesGl = attributesCanvas.getContext('webgl2', options);
  check(order.join() === names.join(), 'Context dictionary getters were reordered or repeated');
  const attributes = attributesGl.getContextAttributes();
  check(attributes.alpha && attributes.depth && !attributes.stencil && attributes.premultipliedAlpha
    && !attributes.preserveDrawingBuffer,
    'Default WebGL context attributes differ');
  attributes.alpha = false;
  attributes.depth = false;
  check(attributesGl.getContextAttributes().alpha && attributesGl.getContextAttributes().depth,
    'Returned attributes mutated the context');
  check(attributesCanvas.getContext('webgl2', { get alpha() { throw Error('Re-read context options'); } }) === attributesGl,
    'Repeated context request replaced context');
  const resizedByGetter = document.createElement('canvas');
  const resizedGl = resizedByGetter.getContext('webgl2', {
    get alpha() { resizedByGetter.width = 7; resizedByGetter.height = 9; return true; },
    powerPreference: { [Symbol.toPrimitive](hint) { check(hint === 'string', 'Enum used wrong primitive hint'); return 'default'; } },
  });
  check(resizedGl.drawingBufferWidth === 7 && resizedGl.drawingBufferHeight === 9,
    'Attribute getters left stale native dimensions');
  const reentrant = document.createElement('canvas');
  let inner;
  const outer = reentrant.getContext('webgl2', { get alpha() { inner = reentrant.getContext('webgpu'); return true; } });
  check(outer === null && reentrant.getContext('webgpu') === inner, 'Reentrant attributes replaced canvas mode');
  const sameMode = document.createElement('canvas');
  const sameOuter = sameMode.getContext('webgl2', {
    get alpha() { inner = sameMode.getContext('webgl2', { alpha: true }); return false; },
  });
  check(sameOuter === inner && sameOuter.getContextAttributes().alpha, 'Reentrant attributes replaced first context');
  const noDepth = document.createElement('canvas').getContext('webgl2', { depth: 0, stencil: true });
  check(!noDepth.getContextAttributes().depth && noDepth.getContextAttributes().stencil,
    'Depth/stencil options were not forwarded');
  const preservedCanvas = document.createElement('canvas');
  const preserved = preservedCanvas.getContext('webgl2', { preserveDrawingBuffer: true });
  check(preserved.getContextAttributes().preserveDrawingBuffer,
    'preserveDrawingBuffer request was not reported');
  check(noDepth.getParameter(noDepth.DEPTH_BITS) === 0 && noDepth.getParameter(noDepth.STENCIL_BITS) >= 8,
    'Native depth/stencil buffers differ from reported attributes');
  check(gl.getError() === gl.NO_ERROR && attributesGl.getError() === attributesGl.NO_ERROR,
    'Canvas lifecycle generated a GL error');
})();
