import * as THREE from 'three/webgpu';
import { createScene } from '../spinning-scene/scene.mjs';

// Deterministic probe scheduling; this does not certify native display pacing.
const callbacks = new Map();
let nextCallback = 0;
globalThis.self = {
  requestAnimationFrame(callback) { callbacks.set(++nextCallback, callback); return nextCallback; },
  cancelAnimationFrame(id) { callbacks.delete(id); },
};
function advanceFrame(time) {
  const pending = [...callbacks.values()];
  callbacks.clear();
  for (const callback of pending) callback(time);
}

const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Hardware GPU required');
const device = await adapter.requestDevice();
const width = 320;
const height = 200;
let texture;
const failures = [];
device.addEventListener('uncapturederror', event => failures.push(event.error.message));
const context = {
  configure({ format, usage }) {
    texture?.destroy();
    texture = device.createTexture({ size: [width, height], format, usage: usage | GPUTextureUsage.COPY_SRC });
  },
  getCurrentTexture() { return texture; },
};
const canvas = { width, height, getContext: kind => kind === 'webgpu' ? context : null };
context.canvas = canvas;
const renderer = new THREE.WebGPURenderer({ canvas, context, device, antialias: false });
renderer.onError = error => failures.push(error.message);
renderer.onDeviceLost = error => failures.push(error.message);
await renderer.init();
if (!renderer.backend.isWebGPUBackend || renderer.backend.device !== device) throw new Error('Unexpected GPU device');
renderer.setSize(width, height, false);
const fixture = createScene(width, height);

async function capture(seconds) {
  advanceFrame(seconds * 1000);
  fixture.update(seconds);
  renderer.render(fixture.scene, fixture.camera);
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const source = new Uint8Array(buffer.getMappedRange());
    const pixels = new Uint8Array(width * height * 4);
    const bgra = texture.format === 'bgra8unorm';
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const input = y * bytesPerRow + x * 4;
      const output = (y * width + x) * 4;
      pixels.set([source[input + (bgra ? 2 : 0)], source[input + 1], source[input + (bgra ? 0 : 2)], source[input + 3]], output);
    }
    buffer.unmap();
    return pixels;
  } finally { buffer.destroy(); }
}

try {
  const first = await capture(0);
  const second = await capture(1);
  await device.queue.onSubmittedWorkDone();
  let foregroundPixels = 0;
  let changedPixels = 0;
  for (let index = 0; index < first.length; index += 4) {
    if (Math.abs(first[index] - first[0]) + Math.abs(first[index + 1] - first[1]) + Math.abs(first[index + 2] - first[2]) > 12) foregroundPixels++;
    if (Math.abs(first[index] - second[index]) + Math.abs(first[index + 1] - second[index + 1]) + Math.abs(first[index + 2] - second[index + 2]) > 12) changedPixels++;
  }
  if (foregroundPixels < width * height * 0.02 || changedPixels < width * height * 0.01) throw new Error('Three.js scene did not render/animate');
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(JSON.stringify({ rustThree: true, three: THREE.REVISION, width, height,
    nativeWindow: false, sameJavaScriptDevice: renderer.backend.device === device,
    adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      device: adapter.info.device, description: adapter.info.description,
      isFallbackAdapter: adapter.info.isFallbackAdapter }, foregroundPixels, changedPixels,
    errors: failures, frames: [[...first], [...second]] }));
} finally {
  fixture.dispose(); renderer.dispose(); texture?.destroy(); device.destroy(); callbacks.clear();
}
