import * as THREE from 'three/webgpu';
import { createScene } from '../spinning-scene/scene.mjs';
import { createSceneControls } from '../spinning-scene/controls.mjs';

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
const controls = createSceneControls(fixture.camera, canvas, globalThis,
  state => console.log(JSON.stringify({ nativeInputControl: state })));
addEventListener('resize', () => {
  renderer.setSize(canvas.width, canvas.height, false);
  fixture.camera.aspect = canvas.width / canvas.height;
  fixture.camera.updateProjectionMatrix();
});
renderer.setAnimationLoop(time => {
  fixture.update(controls.advance(time));
  renderer.render(fixture.scene, fixture.camera);
});
console.log(JSON.stringify({ nativeThree: true, three: THREE.REVISION,
  sameJavaScriptDevice: renderer.backend.device === device, adapter: adapter.info,
  controls: 'Drag to orbit; wheel to zoom; arrows to orbit; Space to pause; R to reset' }));
