import * as THREE from 'three/webgpu';
import checkerUrl from './checker.png';

const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Hardware surface-compatible GPU required');
const device = await adapter.requestDevice();
const canvas = nativeWindow.canvas;
const context = canvas.getContext('webgpu');
const renderer = new THREE.WebGPURenderer({ canvas, context, device, antialias: false, alpha: false });
renderer.onError = error => { throw new Error(error.message); };
renderer.onDeviceLost = error => { throw new Error(error.message); };
device.addEventListener('uncapturederror', event => { throw new Error(event.error.message); });
await renderer.init();
if (!renderer.backend.isWebGPUBackend || renderer.backend.device !== device) {
  throw new Error('Three.js must use the native surface-compatible JavaScript device');
}
renderer.setSize(canvas.width, canvas.height, false);

const bitmap = await new THREE.ImageBitmapLoader().loadAsync(checkerUrl);
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

const target = new THREE.RenderTarget(32, 32, { depthBuffer: false, stencilBuffer: false });
renderer.setRenderTarget(target);
renderer.render(scene, camera);
renderer.setRenderTarget(null);
const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 32, 32);
const samples = [[8, 8], [24, 8], [8, 24], [24, 24]].map(([x, y]) => {
  const offset = y * 256 + x * 4;
  return Array.from(pixels.slice(offset, offset + 4));
});
const expected = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]];
if (!samples.every((sample, index) => expected[index].every((channel, i) => Math.abs(sample[i] - channel) <= 2))) {
  throw new Error(`Packaged image GPU pixels mismatch: ${JSON.stringify(samples)}`);
}
console.log(JSON.stringify({ packageImageReadback: true, three: THREE.REVISION,
  sameJavaScriptDevice: renderer.backend.device === device,
  adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
    device: adapter.info.device, description: adapter.info.description,
    isFallbackAdapter: adapter.info.isFallbackAdapter },
  sourceUrl: checkerUrl, samples }));
renderer.setAnimationLoop(() => renderer.render(scene, camera));
