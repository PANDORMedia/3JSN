import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { create, globals } from 'webgpu';
import { PNG } from 'pngjs';

// Disposable Node/Dawn baseline. This is NOT the proposed Rust runtime.
// Native presentation is deliberately absent: the target is a GPU texture.
const backend = process.env.THREEJS_NATIVE_BACKEND ?? {
  darwin: 'metal', win32: 'd3d12', linux: 'vulkan',
}[process.platform];
if (!['metal', 'vulkan', 'd3d12'].includes(backend)) {
  throw new Error('Choose metal, vulkan, or d3d12 with THREEJS_NATIVE_BACKEND.');
}

Object.assign(globalThis, globals);
let gpu = create([`backend=${backend}`]);
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, value: { gpu, userAgent: '3JSN native GPU probe' },
});

// Three starts its internal frame bookkeeping during init(). Drive it manually
// for deterministic captures; no fake browser and no timer-driven frame loop.
let nextFrameId = 0;
const callbacks = new Map();
globalThis.self = {
  requestAnimationFrame(callback) {
    callbacks.set(++nextFrameId, callback);
    return nextFrameId;
  },
  cancelAnimationFrame(id) { callbacks.delete(id); },
};
function advanceFrame(time) {
  const pending = [...callbacks.values()];
  callbacks.clear();
  for (const callback of pending) callback(time);
}

async function run() {
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  assert(adapter, `No ${backend} adapter available. This probe requires native GPU access.`);
  assert(!adapter.info?.isFallbackAdapter, 'A software adapter cannot validate the hardware path.');
  const device = await adapter.requestDevice();
  const width = 640;
  const height = 400;
  let texture;
  let renderer;
  let fixture;
  const errors = [];
  const context = {
    configure({ format, usage }) {
      assert(['bgra8unorm', 'rgba8unorm'].includes(format));
      texture?.destroy();
      texture = device.createTexture({
        label: '3JSN offscreen canvas', size: [width, height], format,
        usage: usage | GPUTextureUsage.COPY_SRC,
      });
    },
    getCurrentTexture() { assert(texture); return texture; },
  };
  const canvas = {
    width, height,
    getContext(kind) {
      assert.equal(kind, 'webgpu', 'WebGL fallback is forbidden in this probe.');
      return context;
    },
  };
  context.canvas = canvas;

  async function capture(seconds) {
    advanceFrame(seconds * 1000);
    fixture.update(seconds);
    renderer.render(fixture.scene, fixture.camera);
    const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
    const buffer = device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height],
      );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const source = new Uint8Array(buffer.getMappedRange());
      const rgba = Buffer.alloc(width * height * 4);
      const bgra = texture.format === 'bgra8unorm';
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const s = y * bytesPerRow + x * 4;
          const d = (y * width + x) * 4;
          rgba[d] = source[s + (bgra ? 2 : 0)];
          rgba[d + 1] = source[s + 1];
          rgba[d + 2] = source[s + (bgra ? 0 : 2)];
          rgba[d + 3] = source[s + 3];
        }
      }
      buffer.unmap();
      return rgba;
    } finally {
      buffer.destroy();
    }
  }

  try {
    const THREE = await import('three/webgpu');
    const { createScene } = await import('../../examples/spinning-scene/scene.mjs');
    renderer = new THREE.WebGPURenderer({ canvas, context, device, antialias: false });
    renderer.onError = (error) => errors.push(error.message);
    renderer.onDeviceLost = (error) => errors.push(error.message);
    await renderer.init();
    assert(renderer.backend.isWebGPUBackend);
    renderer.setSize(width, height, false);
    fixture = createScene(width, height);
    const first = await capture(0);
    const second = await capture(1);
    await device.queue.onSubmittedWorkDone();
    assert.deepEqual(errors, [], 'Native GPU validation/device errors');

    let changedPixels = 0;
    let foregroundPixels = 0;
    for (let i = 0; i < first.length; i += 4) {
      const difference = (a, b, j) => Math.abs(a[i] - b[j])
        + Math.abs(a[i + 1] - b[j + 1]) + Math.abs(a[i + 2] - b[j + 2]);
      if (difference(first, second, i) > 12) changedPixels++;
      if (difference(first, first, 0) > 12) foregroundPixels++;
    }
    assert(foregroundPixels > width * height * 0.02, 'Frame contains no meaningful geometry.');
    assert(changedPixels > width * height * 0.01, 'Scene did not visibly animate.');
    const output = resolve('artifacts/native-webgpu');
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, 'frame-0.png'), PNG.sync.write({ width, height, data: first }));
    await writeFile(resolve(output, 'frame-1.png'), PNG.sync.write({ width, height, data: second }));
    const report = {
      date: new Date().toISOString(),
      kind: 'offscreen-correctness-probe',
      runtime: `Node ${process.version}`, platform: process.platform, arch: process.arch,
      three: THREE.REVISION, webgpuPackage: '0.6.1', requestedBackend: backend,
      adapter: {
        vendor: adapter.info?.vendor, architecture: adapter.info?.architecture,
        device: adapter.info?.device, description: adapter.info?.description,
        isFallbackAdapter: adapter.info?.isFallbackAdapter ?? null,
      },
      width, height, foregroundPixels, changedPixels,
      browser: false, nativeWindow: false, rustIntegration: false,
      performanceClaim: 'None. Readback is for correctness, not frame-time measurement.',
    };
    await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    console.log(`Captures: ${output}`);
  } finally {
    fixture?.dispose();
    renderer?.dispose();
    texture?.destroy();
    device.destroy();
    callbacks.clear();
  }
}

try {
  await run();
} finally {
  // dawn.node's native event loop remains alive while the GPU object is held.
  delete globalThis.navigator;
  delete globalThis.self;
  gpu = null;
  globalThis.gc?.();
}
