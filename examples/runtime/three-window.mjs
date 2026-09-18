import * as THREE from 'three/webgpu';
import { createScene } from '../spinning-scene/scene.mjs';

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
const fixture = createScene(canvas.width, canvas.height);
addEventListener('resize', () => {
  renderer.setSize(canvas.width, canvas.height, false);
  fixture.camera.aspect = canvas.width / canvas.height;
  fixture.camera.updateProjectionMatrix();
});
renderer.setAnimationLoop(time => {
  fixture.update(time / 1000);
  renderer.render(fixture.scene, fixture.camera);
});
console.log(JSON.stringify({ nativeThree: true, three: THREE.REVISION,
  sameJavaScriptDevice: renderer.backend.device === device, adapter: adapter.info }));
