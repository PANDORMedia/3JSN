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

test('external image copies preserve dictionary origins and convert typed-array sequences', () => {
  const original = globalThis.ImageBitmap;
  globalThis.ImageBitmap = FixtureBitmap;
  try {
    const red = [255, 0, 0, 255], green = [0, 255, 0, 255];
    const bitmap = new FixtureBitmap(2, 2, Uint8Array.from([...red, ...green, ...red, ...green]));
    const texture = new FixtureTexture();
    const queue = new FixtureQueue();
    queue.copyExternalImageToTexture({ source: bitmap, origin: new Uint32Array([1, 0]) },
      { texture, origin: new Uint32Array([1, 0, 0]) }, new Uint32Array([1, 1]));
    assert.deepEqual([...queue.writes[0][1]], green);
    assert.deepEqual(queue.writes[0][0].origin, new Uint32Array([1, 0, 0]));

    const dictionaryQueue = new FixtureQueue();
    dictionaryQueue.copyExternalImageToTexture({ source: bitmap, origin: { x: 1, y: 0 } },
      { texture, origin: { x: 1, y: 0, z: 0 } }, { width: 1, height: 1 });
    assert.deepEqual([...dictionaryQueue.writes[0][1]], green);
    assert.deepEqual(dictionaryQueue.writes[0][0].origin, { x: 1, y: 0, z: 0 });

    const defaultHeightQueue = new FixtureQueue();
    assert.throws(() => defaultHeightQueue.copyExternalImageToTexture(
      { source: bitmap }, { texture }, { height: 1 }), /Invalid image copy width/);
    assert.throws(() => defaultHeightQueue.copyExternalImageToTexture(
      { source: bitmap }, { texture }, []), /Invalid image copy width/);
    defaultHeightQueue.copyExternalImageToTexture({ source: bitmap, origin: { x: 1, y: 0 } },
      { texture }, { width: 1 });
    assert.deepEqual([...defaultHeightQueue.writes[0][1]], green);
    assert.deepEqual(defaultHeightQueue.writes[0][3], { width: 1, height: 1, depthOrArrayLayers: 1 });
  } finally {
    if (original === undefined) delete globalThis.ImageBitmap;
    else globalThis.ImageBitmap = original;
  }
});
