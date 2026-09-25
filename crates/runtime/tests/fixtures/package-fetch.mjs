import { ImageBitmapLoader } from '../../../../node_modules/three/src/loaders/ImageBitmapLoader.js';
import { pngBase64 } from '../../../../fixtures/image-bitmap/quadrants.mjs';

const expected = [...Uint8Array.from(atob(pngBase64), character => character.charCodeAt(0))];
const response = await fetch("./checker.png");
if (!(response instanceof Response) || response.status !== 200 || !response.ok) {
  throw new Error("packaged fetch did not return a successful Response");
}
if (response.headers.get("content-type") !== "image/png") {
  throw new Error("packaged fetch lost its image media type");
}
const blob = await response.blob();
if (!(blob instanceof Blob) || blob.type !== "image/png") {
  throw new Error("Response.blob did not preserve the packaged image type");
}
const bytes = [...new Uint8Array(await blob.arrayBuffer())];
if (bytes.join(",") !== expected.join(",")) {
  throw new Error(`packaged fetch changed bytes: ${bytes}`);
}

const bitmap = await new ImageBitmapLoader().loadAsync("./checker.png");
if (bitmap.width !== 2 || bitmap.height !== 2) {
  throw new Error("Three.js ImageBitmapLoader did not decode the packaged image");
}
bitmap.close();

const controller = new AbortController();
controller.abort();
try {
  await fetch("./checker.png", { signal: controller.signal });
  throw new Error("aborted package fetch unexpectedly succeeded");
} catch (error) {
  if (error.name !== "AbortError") throw error;
}

for (const url of ["./missing.png", "https://example.test/checker.png", "./checker.png?cache=1"]) {
  try {
    await fetch(url);
    throw new Error(`unsupported package request unexpectedly succeeded: ${url}`);
  } catch (error) {
    if (error.message.startsWith("unsupported package request unexpectedly succeeded")) throw error;
  }
}
