import * as THREE from '../../../../node_modules/three/build/three.webgpu.js';

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
const width = 32;
const height = 32;
let target;
const failures = [];
device.addEventListener('uncapturederror', event => failures.push(event.error.message));
const context = {
  configure({ format, usage }) {
    target?.destroy();
    target = device.createTexture({ size: [width, height], format, usage: usage | GPUTextureUsage.COPY_SRC });
  },
  getCurrentTexture() { return target; },
};
const canvas = { width, height, getContext: kind => kind === 'webgpu' ? context : null };
context.canvas = canvas;
const renderer = new THREE.WebGPURenderer({ canvas, context, device, antialias: false });
renderer.onError = error => failures.push(error.message);
renderer.onDeviceLost = error => failures.push(error.message);
await renderer.init();
if (!renderer.backend.isWebGPUBackend || renderer.backend.device !== device) throw new Error('Unexpected GPU device');
renderer.setSize(width, height, false);

const bitmap = await new THREE.ImageBitmapLoader().loadAsync('./checker.png');
const texture = new THREE.Texture(bitmap);
texture.colorSpace = THREE.SRGBColorSpace;
texture.magFilter = THREE.NearestFilter;
texture.minFilter = THREE.NearestFilter;
texture.generateMipmaps = false;
texture.needsUpdate = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const geometry = new THREE.PlaneGeometry(2, 2);
const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
scene.add(new THREE.Mesh(geometry, material));
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
camera.position.z = 1;

try {
  advanceFrame(performance.now());
  renderer.render(scene, camera);
  await device.queue.onSubmittedWorkDone();
  const bytesPerRow = 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  let samples;
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const source = new Uint8Array(buffer.getMappedRange());
    const bgra = target.format === 'bgra8unorm';
    samples = [[8, 8], [24, 8], [8, 24], [24, 24]].map(([x, y]) => {
      const offset = y * bytesPerRow + x * 4;
      return [source[offset + (bgra ? 2 : 0)], source[offset + 1],
        source[offset + (bgra ? 0 : 2)], source[offset + 3]];
    });
    buffer.unmap();
  } finally { buffer.destroy(); }
  const expected = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]];
  if (!samples.every((sample, index) => expected[index].every((channel, i) => Math.abs(sample[i] - channel) <= 2))) {
    throw new Error(`Packaged Three.js texture pixels mismatch: ${JSON.stringify(samples)}`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  bitmap.close(); texture.dispose(); material.dispose(); geometry.dispose(); renderer.dispose();
  target?.destroy(); device.destroy();
}
