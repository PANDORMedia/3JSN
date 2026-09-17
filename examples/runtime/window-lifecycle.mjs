// Run without RAF so texture lifecycle checks also execute while the OS hides
// the window. The final sentinel verifies that host error teardown stays clean.
const adapter = await navigator.gpu.requestAdapter();
if (!adapter || adapter.info.isFallbackAdapter) throw new Error("hardware GPU required");
const device = await adapter.requestDevice();
const errors = [];
device.addEventListener("uncapturederror", event => errors.push(event.error.message));
const canvas = nativeWindow.canvas;
const context = canvas.getContext("webgpu");
const format = navigator.gpu.getPreferredCanvasFormat();
const configuration = { device, format, alphaMode: "opaque" };
let previous;
for (let index = 0; index < 12; index++) {
  canvas.width = 32 + index;
  canvas.height = 24 + index;
  context.configure(configuration);
  device.pushErrorScope("validation");
  const texture = context.getCurrentTexture();
  if (texture === previous || texture !== context.getCurrentTexture()) throw new Error("frame identity mismatch");
  if (texture.width !== canvas.width || texture.height !== canvas.height || texture.mipLevelCount !== 1 || texture.sampleCount !== 1) {
    throw new Error("surface texture metadata mismatch");
  }
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{
    view: texture.createView(), loadOp: "clear", storeOp: "store",
    clearValue: { r: 0.2, g: 0.4, b: 0.6, a: 1 },
  }] });
  pass.end();
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  const error = await device.popErrorScope();
  if (error) throw new Error(error.message);
  previous = texture;
  if (index % 3 === 0) context.unconfigure();
  else if (index % 3 === 1) context.configure(configuration);
  else canvas.width += 1;
  device.pushErrorScope("validation");
  previous.createView();
  if (!await device.popErrorScope()) throw new Error("expired texture remained usable");
}
await new Promise(resolve => setTimeout(resolve, 20));
if (errors.length) throw new Error(errors.join("; "));
// Leave an acquired texture for the worker's error-path cleanup.
context.configure(configuration);
context.getCurrentTexture();
console.log(JSON.stringify({ nativeLifecycle: true, cycles: 12, errors, adapter: adapter.info.description }));
throw new Error("EXPECTED_NATIVE_LIFECYCLE_COMPLETE");
