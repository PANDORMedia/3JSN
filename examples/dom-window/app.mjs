import * as THREE from 'three/webgpu';
import { createScene } from '../spinning-scene/scene.mjs';

const canvas = document.getElementById('scene');
const status = document.getElementById('status');
const pauseButton = document.getElementById('pause');
const dimensions = document.getElementById('dimensions');
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter || adapter.info.isFallbackAdapter) throw new Error('A hardware WebGPU adapter is required');
const device = await adapter.requestDevice();
const renderer = new THREE.WebGPURenderer({ canvas, device, antialias: false, alpha: false });
renderer.onError = error => { throw new Error(error.message); };
renderer.onDeviceLost = error => { throw new Error(error.message); };
device.addEventListener('uncapturederror', event => { throw event.error; });
await renderer.init();
if (!renderer.backend.isWebGPUBackend || renderer.backend.device !== device) {
  throw new Error('The renderer must use the requested WebGPU device');
}

const scene = createScene();
let paused = false;
let elapsed = 0;
let previousTime;
let stopped = false;

function showState() {
  status.textContent = paused ? 'Paused · take a closer look.' : 'Running · light follows the geometry.';
  pauseButton.textContent = paused ? 'Resume' : 'Pause';
  pauseButton.setAttribute('aria-pressed', String(paused));
}
function togglePause() {
  paused = !paused;
  previousTime = undefined;
  showState();
}
function onKey(event) {
  if (event.key !== ' ' && event.key.toLowerCase() !== 'r') return;
  event.preventDefault();
  if (event.repeat) return;
  if (event.key === ' ') togglePause();
  else { elapsed = 0; previousTime = undefined; scene.update(0); showState(); }
}
function resize() {
  const width = Math.max(1, Math.floor(innerWidth - 56));
  const height = Math.max(1, Math.floor(innerHeight - 200));
  const ratio = devicePixelRatio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  renderer.setPixelRatio(ratio);
  renderer.setSize(width, height, false);
  scene.camera.aspect = width / height;
  scene.camera.updateProjectionMatrix();
  dimensions.textContent = `${width} × ${height} · ${Math.round(ratio * 100)}%`;
}

pauseButton.addEventListener('click', togglePause);
addEventListener('keydown', onKey);
addEventListener('resize', resize);
showState();
resize();
renderer.setAnimationLoop(time => {
  if (previousTime !== undefined && !paused) elapsed += Math.max(0, time - previousTime) / 1000;
  previousTime = time;
  scene.update(elapsed);
  renderer.render(scene.scene, scene.camera);
});

addEventListener('pagehide', () => {
  if (stopped) return;
  stopped = true;
  pauseButton.removeEventListener('click', togglePause);
  removeEventListener('keydown', onKey);
  removeEventListener('resize', resize);
  renderer.setAnimationLoop(null);
  renderer.dispose();
  scene.dispose();
}, { once: true });
