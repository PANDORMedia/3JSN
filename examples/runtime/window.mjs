const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
if (!adapter || adapter.info.isFallbackAdapter) throw new Error("hardware surface-compatible GPU required");
const device = await adapter.requestDevice();
device.addEventListener("uncapturederror", event => { throw new Error(event.error.message); });
const canvas = nativeWindow.canvas;
const context = canvas.getContext("webgpu");
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format, alphaMode: "opaque" });
let frame = 0;
function render() {
  const texture = context.getCurrentTexture();
  if (context.getCurrentTexture() !== texture) throw new Error("same-frame texture identity changed");
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{
    view: texture.createView(), loadOp: "clear", storeOp: "store",
    clearValue: { r: 0.05, g: 0.25 + 0.2 * Math.sin(frame++ / 20), b: 0.5, a: 1 },
  }] });
  pass.end();
  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(render);
}
console.log(JSON.stringify({ nativeSurface: true, adapter: {
  vendor: adapter.info.vendor, architecture: adapter.info.architecture,
  device: adapter.info.device, description: adapter.info.description,
  isFallbackAdapter: adapter.info.isFallbackAdapter,
}, format }));
requestAnimationFrame(render);
