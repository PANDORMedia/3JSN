import assert from 'node:assert/strict';
import test from 'node:test';
import { installImageBitmapTextureCopy } from '../src/image-copy.js';

class FixtureBitmap {
  constructor(width, height, pixels) { this.width = width; this.height = height; this.pixels = pixels; }
  [Symbol.for('Deno_bitmapData')]() { return this.pixels; }
}

class FixtureTexture {
  constructor() {
    this.width = 2;
    this.height = 2;
    this.depthOrArrayLayers = 1;
    this.mipLevelCount = 1;
    this.format = 'rgba8unorm';
  }
}

class FixtureQueue {
  writes = [];
  writeTexture(...args) { this.writes.push(args); }
}

installImageBitmapTextureCopy({ GPUQueue: FixtureQueue, GPUTexture: FixtureTexture });

test('external image copies honor sequence-form source and destination origins', () => {
  const original = globalThis.ImageBitmap;
  globalThis.ImageBitmap = FixtureBitmap;
  try {
    const red = [255, 0, 0, 255], green = [0, 255, 0, 255];
    const bitmap = new FixtureBitmap(2, 2, Uint8Array.from([...red, ...green, ...red, ...green]));
    const texture = new FixtureTexture();
    const queue = new FixtureQueue();
    queue.copyExternalImageToTexture({ source: bitmap, origin: [1, 0] },
      { texture, origin: [1, 0, 0] }, [1, 1]);
    assert.deepEqual([...queue.writes[0][1]], green);
    assert.deepEqual(queue.writes[0][0].origin, [1, 0, 0]);
  } finally {
    if (original === undefined) delete globalThis.ImageBitmap;
    else globalThis.ImageBitmap = original;
  }
});
