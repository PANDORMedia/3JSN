import * as THREE from 'three/webgpu';
import { createScene } from '../../examples/spinning-scene/scene.mjs';
import { runCanvasContract } from '../../fixtures/webgpu-canvas/contract.mjs';

globalThis.self = globalThis;
const adapter = await navigator.gpu.requestAdapter();
if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Hardware GPU required');
const device = await adapter.requestDevice();
const errors = [];
device.addEventListener('uncapturederror', event => errors.push(event.error.message));
let renderer, scene, canvas, context;

async function contract() {
  const checks = [];
  await runCanvasContract((name, passed, observed) => {
    checks.push({ name, passed, observed });
    if (!passed) throw new Error(`Native canvas contract failed: ${name} (${JSON.stringify(observed)})`);
  }, device);
  if (errors.length) throw new Error(errors.join('; '));
  return checks;
}
async function start() {
  canvas = document.getElementById('scene');
  context = canvas.getContext('webgpu');
  renderer = new THREE.WebGPURenderer({ canvas, device, antialias: false });
  await renderer.init();
  renderer.setSize(320, 200, false);
  scene = createScene(320, 200);
}
function render(time) {
  __advanceProbeFrame(time * 1000);
  scene.update(time);
  renderer.render(scene.scene, scene.camera);
  probe.lastTexture = context.getCurrentTexture();
}
function resize(width, height) {
  renderer.setSize(width, height, false);
  scene.camera.aspect = width / height;
  scene.camera.updateProjectionMatrix();
}
function configuration() {
  const { format, usage, alphaMode } = context.getConfiguration();
  return { format, usage, alphaMode, width: canvas.width, height: canvas.height };
}
function detach() { document.getElementById('stage').removeChild(canvas); }
function attach() {
  document.getElementById('stage').appendChild(canvas);
  if (canvas.getContext('webgpu') !== context) throw new Error('Reparenting changed context identity');
}
async function assertExpired() {
  device.pushErrorScope('validation');
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: probe.lastTexture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
  pass.end(); device.queue.submit([encoder.finish()]);
  return (await device.popErrorScope()) instanceof GPUValidationError;
}
function clearColor(alphaMode) {
  const configuration = context.getConfiguration();
  context.configure({ ...configuration, alphaMode });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0.5, 0, 0.5] }] });
  pass.end(); device.queue.submit([encoder.finish()]);
}
async function finish() {
  scene?.dispose(); await renderer?.dispose(); context?.unconfigure();
  renderer = scene = canvas = context = undefined;
}
globalThis.probe = { device, contract, start, render, resize, configuration, detach, attach, assertExpired, clearColor, finish, errors,
  info: { adapter: adapter.info.description, three: THREE.REVISION } };
