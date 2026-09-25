import * as THREE from 'three/webgpu';
import { pngBase64, quadrants } from '../../fixtures/image-bitmap/quadrants.mjs';

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

const png = Uint8Array.from(atob(pngBase64), character => character.charCodeAt(0));
const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }), {
  imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
});
const image = new THREE.Texture(bitmap);
image.colorSpace = THREE.SRGBColorSpace;
image.magFilter = THREE.NearestFilter;
image.minFilter = THREE.NearestFilter;
image.generateMipmaps = false;
image.needsUpdate = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const geometry = new THREE.PlaneGeometry(2, 2);
const material = new THREE.MeshBasicMaterial({ map: image, toneMapped: false });
scene.add(new THREE.Mesh(geometry, material));
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
camera.position.z = 1;

try {
  advanceFrame(performance.now());
  renderer.render(scene, camera);
  await device.queue.onSubmittedWorkDone();
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  let pixels;
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const source = new Uint8Array(buffer.getMappedRange());
    pixels = new Uint8Array(width * height * 4);
    const bgra = target.format === 'bgra8unorm';
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const input = y * bytesPerRow + x * 4;
      const output = (y * width + x) * 4;
      pixels.set([source[input + (bgra ? 2 : 0)], source[input + 1], source[input + (bgra ? 0 : 2)], source[input + 3]], output);
    }
    buffer.unmap();
  } finally { buffer.destroy(); }
  const samples = [[80, 50], [240, 50], [80, 150], [240, 150]].map(([x, y]) => {
    const index = (y * width + x) * 4;
    return [...pixels.slice(index, index + 4)];
  });
  const orientedQuadrants = [quadrants[0], quadrants[1], quadrants[2], quadrants[3]];
  const matched = samples.every((sample, sampleIndex) => orientedQuadrants[sampleIndex]
    .every((channel, channelIndex) => Math.abs(sample[channelIndex] - channel) <= 2));
  if (!matched) {
    throw new Error(`Three.js texture did not preserve PNG quadrant orientation: ${JSON.stringify(samples)}`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(JSON.stringify({ rustThreeImage: true, three: THREE.REVISION, width, height,
    sameJavaScriptDevice: renderer.backend.device === device,
    adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      device: adapter.info.device, description: adapter.info.description,
      isFallbackAdapter: adapter.info.isFallbackAdapter }, samples, pixels: [...pixels], errors: failures }));
} finally {
  bitmap.close(); image.dispose(); material.dispose(); geometry.dispose(); renderer.dispose();
  target?.destroy(); device.destroy();
}
