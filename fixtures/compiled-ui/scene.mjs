import * as THREE from 'three/webgpu';
import './behavior.js';

const canvas = document.getElementById('scene');
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Hardware WebGPU is required');
const device = await adapter.requestDevice();
const renderer = new THREE.WebGPURenderer({ canvas, device, antialias: false });
renderer.onError = error => { throw new Error(error.message); };
renderer.onDeviceLost = error => { throw new Error(error.message); };
device.addEventListener('uncapturederror', event => { throw event.error; });
await renderer.init();
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(Math.max(1, innerWidth - 48), 210, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#101923');
scene.add(new THREE.HemisphereLight(0xb5dfff, 0x275242, 3));
const camera = new THREE.PerspectiveCamera(32, (innerWidth - 48) / 210, 0.1, 30);
camera.position.set(0, 0, 7);
const geometry = new THREE.TorusKnotGeometry(0.64, 0.18, 96, 16);
const material = new THREE.MeshStandardMaterial({ color: '#82e1bb', roughness: 0.25, metalness: 0.4 });
const mesh = new THREE.Mesh(geometry, material);
scene.add(mesh);
let frames = 0;
renderer.setAnimationLoop(time => {
  frames++;
  if (frames === 3) console.log(JSON.stringify({ uiPhase: 'initial', result: uiFixture.snapshot() }));
  if (frames === 30) console.log(JSON.stringify({ uiPhase: 'mutated', result: uiFixture.mutate() }));
  mesh.rotation.set(time / 2100, time / 3000, 0);
  renderer.render(scene, camera);
});
addEventListener('pagehide', () => {
  renderer.setAnimationLoop(null);
  geometry.dispose(); material.dispose(); renderer.dispose();
}, { once: true });
