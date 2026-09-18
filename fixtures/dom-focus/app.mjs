// SPDX-License-Identifier: MIT
import * as THREE from 'three/webgpu';
import { runFocusBehavior } from './behavior.mjs';

const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter || adapter.info.isFallbackAdapter) throw new Error('A hardware WebGPU adapter is required');
const device = await adapter.requestDevice();
device.addEventListener('uncapturederror', event => { throw event.error; });
const renderer = new THREE.WebGPURenderer({ canvas: document.getElementById('scene'), device, antialias: false });
renderer.onError = error => { throw new Error(error.message); };
renderer.onDeviceLost = error => { throw new Error(error.message); };
await renderer.init();
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(320, 180, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#15202b');
const camera = new THREE.PerspectiveCamera(40, 320 / 180, 0.1, 20);
camera.position.z = 4;
const geometry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshNormalMaterial();
const mesh = new THREE.Mesh(geometry, material);
scene.add(mesh);
addEventListener('pagehide', () => {
  renderer.setAnimationLoop(null);
  geometry.dispose(); material.dispose(); renderer.dispose();
}, { once: true });

// Module evaluation drives these asynchronous checks before the host admits
// presentation; pausing RAF would not pause its native presentation budget.
const result = await runFocusBehavior();
console.log(JSON.stringify({ focusPhase: 'complete', completionStage: 'startup-before-animation-loop', result }));
await renderer.setAnimationLoop(time => {
  mesh.rotation.set(time / 1700, time / 2300, 0);
  renderer.render(scene, camera);
});
