import * as THREE from 'three/webgpu';
import { createScene } from '../../examples/spinning-scene/scene.mjs';

globalThis.self = globalThis;
const errors = [];
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Hardware GPU required');
const device = await adapter.requestDevice();
if (!(device instanceof EventTarget)) throw new Error('GPU device uses a different EventTarget');
device.addEventListener('uncapturederror', event => errors.push(event.error.message));
let renderer, fixture, gameTexture, output, binding, pipeline, width, height;
const shader = device.createShaderModule({ code: `
@group(0) @binding(0) var game: texture_2d<f32>;
@group(0) @binding(1) var ui: texture_2d<f32>;
@group(0) @binding(2) var output: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8)
fn compose(@builtin(global_invocation_id) p: vec3<u32>) {
  let size = textureDimensions(game);
  if (p.x >= size.x * 3u || p.y >= size.y) { return; }
  let point = vec2<i32>(i32(p.x % size.x), i32(p.y));
  let a = textureLoad(ui, point, 0);
  let b = textureLoad(game, point, 0);
  // Vello 0.10 stores straight alpha in its final fine-raster shader.
  var color = vec4(a.rgb * a.a + b.rgb * (1.0 - a.a), a.a + b.a * (1.0 - a.a));
  // Diagnostic planes are GPU copies into the final assertion image. No source
  // image is read back or uploaded between producer and compositor.
  if (p.x >= size.x && p.x < size.x * 2u) { color = b; }
  if (p.x >= size.x * 2u) { color = a; }
  textureStore(output, vec2<i32>(p.xy), color);
}` });

async function beginGeneration(nextWidth, nextHeight) {
  width = nextWidth; height = nextHeight;
  const context = {
    configure({ format, usage }) {
      gameTexture?.destroy();
      gameTexture = device.createTexture({ size: [width, height], format,
        usage: usage | GPUTextureUsage.TEXTURE_BINDING });
    },
    getCurrentTexture() { return gameTexture; },
  };
  const canvas = { width, height, getContext: kind => kind === 'webgpu' ? context : null };
  context.canvas = canvas;
  renderer = new THREE.WebGPURenderer({ canvas, context, device, antialias: false });
  renderer.onError = error => errors.push(error.message);
  renderer.onDeviceLost = error => errors.push(error.message);
  await renderer.init();
  if (renderer.backend.device !== device || !renderer.backend.isWebGPUBackend) throw new Error('Renderer device changed');
  renderer.setSize(width, height, false);
  fixture = createScene(width, height);
  output = device.createTexture({ size: [width * 3, height], format: 'rgba8unorm',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
  pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: shader, entryPoint: 'compose' } });
}

function renderGame(time) {
  __advanceProbeFrame(time * 1000);
  fixture.update(time);
  renderer.render(fixture.scene, fixture.camera);
}
function compose() {
  // Three.js configures its canvas lazily on the first render.
  binding ??= device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: gameTexture.createView() },
    { binding: 1, resource: globalThis.uiTexture.createView() },
    { binding: 2, resource: output.createView() },
  ] });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline); pass.setBindGroup(0, binding);
  pass.dispatchWorkgroups(Math.ceil(width * 3 / 8), Math.ceil(height / 8)); pass.end();
  device.queue.submit([encoder.finish()]);
}
async function capture() {
  const bytesPerRow = Math.ceil(width * 12 / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow }, [width * 3, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buffer.getMappedRange());
    const pixels = new Uint8Array(width * height * 12);
    for (let y = 0; y < height; y++) pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 12), y * width * 12);
    buffer.unmap();
    if (errors.length) throw new Error(errors.join('; '));
    return [...pixels];
  } finally { buffer.destroy(); }
}
async function endGeneration() {
  fixture?.dispose(); await renderer?.dispose(); gameTexture?.destroy(); output?.destroy();
  binding = pipeline = fixture = renderer = gameTexture = output = undefined;
  globalThis.uiTexture?.destroy();
  globalThis.uiTexture = undefined;
}
globalThis.probe = { device, beginGeneration, renderGame, compose, capture, endGeneration,
  info: { three: THREE.REVISION, adapter: adapter.info.description }, errors };
