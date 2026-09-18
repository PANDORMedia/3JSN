import * as THREE from 'three/webgpu';
import { measure, localize } from './metrics.mjs';

const canvas = document.getElementById('scene');
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter || adapter.info.isFallbackAdapter) throw new Error('A hardware WebGPU adapter is required');
const device = await adapter.requestDevice();
const renderer = new THREE.WebGPURenderer({ canvas, device, antialias: false });
renderer.onError = error => { throw new Error(error.message); };
renderer.onDeviceLost = error => { throw new Error(error.message); };
device.addEventListener('uncapturederror', event => { throw event.error; });
await renderer.init();
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(Math.max(1, innerWidth - 60), 116, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#101a26');
const camera = new THREE.PerspectiveCamera(32, (innerWidth - 60) / 116, 0.1, 30);
camera.position.set(0, 0, 8);
scene.add(new THREE.HemisphereLight(0xd6f6ff, 0x193841, 3));
const geometry = new THREE.TorusKnotGeometry(0.66, 0.2, 96, 16);
const material = new THREE.MeshStandardMaterial({ color: '#72dfbc', roughness: 0.28, metalness: 0.5 });
const mesh = new THREE.Mesh(geometry, material);
scene.add(mesh);
let frame = 0;
globalThis.fontProbe = { measure, localize };
renderer.setAnimationLoop(time => {
  if (++frame === 3) console.log(JSON.stringify({ fontMetrics: 'initial', samples: measure() }));
  if (frame === 30) localize();
  if (frame === 35) console.log(JSON.stringify({ fontMetrics: 'localized', samples: measure() }));
  mesh.rotation.set(time / 2100, time / 3100, 0);
  renderer.render(scene, camera);
});
addEventListener('pagehide', () => {
  renderer.setAnimationLoop(null);
  geometry.dispose();
  material.dispose();
  renderer.dispose();
}, { once: true });
