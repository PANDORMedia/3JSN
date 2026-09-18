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
  const viewport = [...gl.getParameter(gl.VIEWPORT)];
  canvas.width = 80;
  check(gl.drawingBufferWidth === 80 && gl.drawingBufferHeight === 96, 'Attribute resize did not reach native storage');
  check([...gl.getParameter(gl.VIEWPORT)].join() === viewport.join(), 'Resize changed application viewport state');
  let resized = new Uint8Array(80 * 96 * 4); __observeNativeFrame(gl, resized);
  check(resized.every(value => value === 0), 'Resized drawing buffer was not initialized');
  gl.clearColor(1,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
  canvas.setAttribute('width', '80');
  resized = new Uint8Array(80 * 96 * 4); __observeNativeFrame(gl, resized);
  check(resized.every(value => value === 0), 'Repeated dimension assignment did not reset storage');
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
  check(gl.getError() === gl.NO_ERROR, 'Canvas lifecycle generated a GL error');
})();
