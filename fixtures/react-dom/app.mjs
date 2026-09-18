import * as THREE from 'three/webgpu';
import './behavior.mjs';

const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter || adapter.info.isFallbackAdapter) throw new Error('A hardware WebGPU adapter is required');
const device = await adapter.requestDevice();
const renderer = new THREE.WebGPURenderer({ canvas: document.getElementById('scene'), device, antialias: false });
renderer.onError = error => { throw new Error(error.message); };
renderer.onDeviceLost = error => { throw new Error(error.message); };
device.addEventListener('uncapturederror', event => { throw event.error; });
await renderer.init();
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(300, 340, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#101925');
const camera = new THREE.PerspectiveCamera(38, 300 / 340, 0.1, 30);
camera.position.z = 5;
const geometry = new THREE.TorusKnotGeometry(0.7, 0.19, 96, 16);
const material = new THREE.MeshStandardMaterial({ color: '#65d8b1', roughness: 0.3, metalness: 0.35 });
const mesh = new THREE.Mesh(geometry, material);
scene.add(mesh, new THREE.HemisphereLight('#dbefff', '#19263a', 3));
const light = new THREE.DirectionalLight('#ffffff', 2); light.position.set(3, 4, 5); scene.add(light);
let frames = 0, failure;
uiProbe.snapshot().then(result => console.log(JSON.stringify({ reactPhase: 'initial', result }))).catch(error => { failure = error; });
renderer.setAnimationLoop(time => {
  if (failure) throw failure;
  if (++frames === 20) uiProbe.verify().then(result => {
    console.log(JSON.stringify({ reactPhase: 'verified', result }));
  }).catch(error => { failure = error; });
  mesh.rotation.set(time / 2200, time / 3300, 0);
  renderer.render(scene, camera);
});
addEventListener('pagehide', () => {
  renderer.setAnimationLoop(null);
  uiProbe.unmount();
  geometry.dispose(); material.dispose(); renderer.dispose();
}, { once: true });
