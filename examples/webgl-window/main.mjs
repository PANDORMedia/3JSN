// SPDX-License-Identifier: MIT
import { WebGLRenderer, Scene, PerspectiveCamera, BoxGeometry, MeshNormalMaterial, MeshBasicMaterial, Mesh } from 'three';

const scene = new Scene();
const camera = new PerspectiveCamera(40, 2, 0.1, 30);
camera.position.z = 7;
const geometry = new BoxGeometry(1, 1, 1);
const materials = [
  new MeshNormalMaterial(),
  new MeshBasicMaterial({ color: 0xffbd76 }),
  new MeshBasicMaterial({ color: 0x8ce6d0 }),
  new MeshBasicMaterial({ color: 0x6ca6ff, transparent: true, opacity: 0.48, depthWrite: false }),
  new MeshBasicMaterial({ color: 0xf49cce, transparent: true, opacity: 0.62, depthWrite: false }),
];
const shapes = materials.map((material, index) => {
  const mesh = new Mesh(geometry, material);
  scene.add(mesh);
  mesh.position.set([0.1, -1.75, 1.8, -0.95, 2.1][index], [0.15, -0.45, 0.5, 0.7, -0.9][index], [0, 0, -0.3, 0.8, 1.1][index]);
  const size = [1.65, 0.85, 0.75, 1.2, 1.05][index];
  mesh.scale.set(size, size, index >= 3 ? 0.16 : size);
  return mesh;
});
const status = document.getElementById('status');
const bitmap = document.getElementById('bitmap');
const progress = document.getElementById('progress');
let canvas = document.getElementById('scene');
let renderer;
let context;
let frame = 0;
let generation = 1;
let lost = false;
let request;
let scale = 1;
let previousContext = null;

function check(condition, message) {
  if (!condition) throw new Error(`WebGL window fixture: ${message}`);
}
function resize() {
  const rect = canvas.getBoundingClientRect();
  check(rect.width > 0 && rect.height > 0, 'canvas has no CSS area');
  renderer.setSize(Math.max(1, Math.round(rect.width * scale)), Math.max(1, Math.round(rect.height * scale)), false);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
}
function createRenderer() {
  canvas.addEventListener('webglcontextlost', () => { lost = true; });
  renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  context = renderer.getContext();
  renderer.setClearColor(0x000000, 0);
  renderer.debug.onShaderError = () => { throw new Error('WebGL window fixture: shader compilation or linking failed'); };
  resize();
}
function checkpoint(phase) {
  const sameContext = canvas.getContext('webgl2') === context && renderer.getContext() === context;
  const rect = canvas.getBoundingClientRect();
  check(!lost, 'context was lost');
  check(canvas === document.getElementById('scene') && canvas.isConnected, 'active canvas is missing');
  check(sameContext && context.canvas === canvas, 'canvas/context identity changed');
  check(canvas.width === context.drawingBufferWidth && canvas.height === context.drawingBufferHeight, 'drawing buffer differs from canvas bitmap');
  check(context.getError() === context.NO_ERROR, 'renderer reported a GL error');
  status.textContent = phase;
  bitmap.textContent = `${canvas.width} × ${canvas.height} pixels`;
  console.log(JSON.stringify({ webglWindow: { phase, frame, generation,
    bitmap: { width: canvas.width, height: canvas.height },
    css: { width: rect.width, height: rect.height },
    contextIdentity: sameContext, replacementContextDistinct: previousContext === null ? null : context !== previousContext,
    connected: canvas.isConnected, contextLost: lost } }));
}
createRenderer();
addEventListener('resize', resize);

function animate() {
  frame++;
  let phase = frame === 1 ? 'First frame' : null;
  if (frame === 12) {
    scale = 1.25;
    resize();
    phase = 'Bitmap resized';
  }
  if (frame === 24) {
    canvas.width = canvas.width;
    renderer.setViewport(0, 0, canvas.width, canvas.height);
    phase = 'Same-width reset';
  }
  if (frame === 36) {
    const previousCanvas = canvas;
    previousContext = context;
    const next = document.createElement('canvas');
    next.setAttribute('aria-label', 'Animated colorful Three.js shapes');
    const parent = previousCanvas.parentNode;
    parent.insertBefore(next, previousCanvas);
    parent.removeChild(previousCanvas);
    next.id = 'scene';
    renderer.dispose();
    canvas = next;
    generation++;
    createRenderer();
    check(context !== previousContext && !previousCanvas.isConnected, 'replacement retained the prior context or DOM attachment');
    phase = 'Canvas replaced';
  }
  const time = frame / 60;
  shapes.forEach((mesh, index) => {
    mesh.rotation.set(0.25 + time * (0.23 + index * 0.04), 0.45 + time * (0.36 - index * 0.025), Math.sin(time + index) * 0.16);
  });
  renderer.render(scene, camera);
  if (frame === 60) phase = 'Lifecycle complete';
  if (phase) checkpoint(phase);
  if (frame % 12 === 0) progress.textContent = `FRAME ${frame} / GENERATION ${generation}`;
  request = requestAnimationFrame(animate);
}
request = requestAnimationFrame(animate);
addEventListener('pagehide', () => {
  cancelAnimationFrame(request);
  removeEventListener('resize', resize);
  renderer.dispose();
  geometry.dispose();
  materials.forEach(material => material.dispose());
}, { once: true });
