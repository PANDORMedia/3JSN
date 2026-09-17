const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) throw new Error('No native GPU adapter available');
if (adapter.info.isFallbackAdapter) throw new Error('This fixture requires a hardware adapter');
const device = await adapter.requestDevice();
const errors = [];
device.addEventListener('uncapturederror', event => errors.push(event.error.message));
const size = 64;
const texture = device.createTexture({
  size: [size, size], format: 'rgba8unorm',
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});
const buffer = device.createBuffer({
  size: size * size * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
try {
  device.pushErrorScope('validation');
  const shader = device.createShaderModule({ code: `
    @vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
      let positions = array<vec2f, 3>(vec2f(-0.8, -0.8), vec2f(0.8, -0.8), vec2f(0.0, 0.8));
      return vec4f(positions[index], 0.0, 1.0);
    }
    @fragment fn fragment() -> @location(0) vec4f { return vec4f(0.0, 1.0, 0.0, 1.0); }
  ` });
  const pipeline = device.createRenderPipeline({
    layout: 'auto', vertex: { module: shader, entryPoint: 'vertex' },
    fragment: { module: shader, entryPoint: 'fragment', targets: [{ format: 'rgba8unorm' }] },
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{
    view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1],
  }] });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: size * 4 }, [size, size]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const pixels = new Uint8Array(buffer.getMappedRange());
  const center = [...pixels.slice((32 * size + 32) * 4, (32 * size + 32) * 4 + 4)];
  const corner = [...pixels.slice(0, 4)];
  let greenPixels = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] === 255) greenPixels++;
  buffer.unmap();
  const validation = await device.popErrorScope();
  if (validation) errors.push(validation.message);
  if (errors.length) throw new Error(`GPU validation: ${errors.join('; ')}`);
  if (center.join() !== '0,255,0,255' || corner.join() !== '0,0,0,255' || greenPixels < 1000) {
    throw new Error(`Incorrect GPU pixels: ${JSON.stringify({ center, corner, greenPixels })}`);
  }
  console.log(JSON.stringify({
    fixture: 'rust-hosted-webgpu-triangle', result: 'pass', width: size, height: size,
    adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      device: adapter.info.device, description: adapter.info.description,
      isFallbackAdapter: adapter.info.isFallbackAdapter },
    center, corner, greenPixels, validationErrors: errors,
  }));
} finally {
  buffer.destroy();
  texture.destroy();
  device.destroy();
}
