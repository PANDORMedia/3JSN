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
renderer.setSize(480, 300, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#16243a');
const camera = new THREE.PerspectiveCamera(45, 480 / 300, 0.1, 100);
camera.position.z = 4;
const geometry = new THREE.TorusKnotGeometry(0.7, 0.22, 96, 16);
const material = new THREE.MeshStandardMaterial({ color: '#81ecc7', metalness: 0.35, roughness: 0.3 });
const mesh = new THREE.Mesh(geometry, material);
scene.add(mesh, new THREE.HemisphereLight('#d7efff', '#14233a', 2));
const key = new THREE.DirectionalLight('#ffffff', 3); key.position.set(2, 3, 4); scene.add(key);
let frame = 0, request;
function render() {
  frame++;
  if (frame === 3) console.log(JSON.stringify({ uiPhase: 'initial', result: uiProbe.snapshot() }));
  if (frame === 30) console.log(JSON.stringify({ uiPhase: 'mutated', result: uiProbe.mutate() }));
  mesh.rotation.x += 0.004; mesh.rotation.y += 0.008;
  renderer.render(scene, camera);
  request = requestAnimationFrame(render);
}
request = requestAnimationFrame(render);
addEventListener('pagehide', () => {
  cancelAnimationFrame(request); geometry.dispose(); material.dispose(); renderer.dispose();
});
