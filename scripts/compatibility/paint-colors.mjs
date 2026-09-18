import assert from 'node:assert/strict';

export function subjectColor(value) {
  if (value === undefined) return [224, 32, 48, 255];
  assert(Array.isArray(value) && value.length === 4
    && value.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255),
  'subjectColor must contain four integer RGBA channels from 0 to 255.');
  return value;
}

export function createSubjectColorMatcher(value) {
  const color = subjectColor(value);
  // Declared composited colors can differ by rounding across raster backends.
  const tolerance = value === undefined ? 0 : 2;
  return (pixels, offset) => color.every((channel, index) => Math.abs(pixels[offset + index] - channel) <= tolerance);
}
