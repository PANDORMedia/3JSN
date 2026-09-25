import { pngBase64, quadrants } from '../../../../fixtures/image-bitmap/quadrants.mjs';

const bytes = Uint8Array.from(atob(pngBase64), character => character.charCodeAt(0));
const blob = new Blob([bytes], { type: 'image/png' });
const bitmap = await createImageBitmap(blob);
if (!(bitmap instanceof ImageBitmap) || bitmap.width !== 2 || bitmap.height !== 2) {
  throw new Error('PNG did not produce a 2x2 ImageBitmap');
}
const rgba = bitmap[Symbol.for('Deno_bitmapData')]();
if (rgba.length !== 16 || !quadrants.every((color, index) => color.every((channel, offset) => rgba[index * 4 + offset] === channel))) {
  throw new Error('ImageBitmap pixel data did not preserve decoded RGBA');
}
bitmap.close();

let malformedRejected = false;
try {
  await createImageBitmap(new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/png' }));
} catch {
  malformedRejected = true;
}
if (!malformedRejected) throw new Error('Malformed PNG was not rejected');
