function integer(value, name) {
  let number;
  try { number = +value; } catch { throw new TypeError(`Invalid image copy ${name}`); }
  if (!Number.isFinite(number) || number < 0 || number > 0xffff_ffff) {
    throw new TypeError(`Invalid image copy ${name}`);
  }
  return Math.trunc(number);
}

function sequenceValues(value) {
  if (Array.isArray(value)) return value;
  return value && typeof value[Symbol.iterator] === "function" ? Array.from(value) : undefined;
}

function extentValues(size) {
  const sequence = sequenceValues(size);
  const value = (name, index, fallback) => integer(
    (sequence ? sequence[index] : size?.[name]) ?? fallback, name);
  return {
    width: value("width", 0, undefined),
    height: value("height", 1, 1),
    depth: value("depthOrArrayLayers", 2, 1),
  };
}

function originValues(origin, label, includeDepth) {
  const sequence = sequenceValues(origin);
  const value = (key, index) => integer((sequence ? sequence[index] : origin?.[key]) ?? 0, `${label} ${key}`);
  const result = { x: value("x", 0), y: value("y", 1) };
  if (includeDepth) result.z = value("z", 2);
  return result;
}

export function installImageBitmapTextureCopy({ GPUQueue, GPUTexture }) {
  Object.defineProperty(GPUQueue.prototype, "copyExternalImageToTexture", {
    configurable: true,
    writable: true,
    value(sourceInfo, destinationInfo, copySize) {
      const bitmap = sourceInfo?.source;
      if (!(bitmap instanceof ImageBitmap)) {
        throw new TypeError("copyExternalImageToTexture currently requires an ImageBitmap source");
      }
      const destination = destinationInfo?.texture;
      if (!(destination instanceof GPUTexture)) {
        throw new TypeError("copyExternalImageToTexture requires a GPUTexture destination");
      }
      const premultipliedAlpha = Boolean(destinationInfo.premultipliedAlpha);
      if ((destinationInfo.colorSpace ?? "srgb") !== "srgb" || premultipliedAlpha) {
        throw new DOMException("Only straight-alpha sRGB image copies are supported", "NotSupportedError");
      }
      if (destination.format !== "rgba8unorm" && destination.format !== "rgba8unorm-srgb") {
        throw new DOMException("Image copies require an rgba8unorm destination texture", "NotSupportedError");
      }

      const sourceOrigin = originValues(sourceInfo.origin, "source", false);
      const destinationOrigin = originValues(destinationInfo.origin, "destination", true);
      const { x: sourceX, y: sourceY } = sourceOrigin;
      const { x: destinationX, y: destinationY, z: destinationZ } = destinationOrigin;
      const mipLevel = integer(destinationInfo.mipLevel ?? 0, "mip level");
      const { width, height, depth } = extentValues(copySize);
      const flipY = Boolean(sourceInfo.flipY);
      if (mipLevel >= destination.mipLevelCount) {
        throw new DOMException("Image copy mip level is outside the destination texture", "OperationError");
      }
      const mipWidth = Math.max(1, Math.floor(destination.width / (2 ** mipLevel)));
      const mipHeight = Math.max(1, Math.floor(destination.height / (2 ** mipLevel)));
      if (width === 0 || height === 0 || depth !== 1
        || sourceX + width > bitmap.width || sourceY + height > bitmap.height
        || destinationX + width > mipWidth || destinationY + height > mipHeight
        || destinationZ >= destination.depthOrArrayLayers) {
        throw new DOMException("Image copy bounds are outside the bitmap or destination texture", "OperationError");
      }

      const getData = bitmap[Symbol.for("Deno_bitmapData")];
      if (typeof getData !== "function") {
        throw new DOMException("ImageBitmap has no usable pixel data", "InvalidStateError");
      }
      const rgba = getData.call(bitmap);
      if (rgba.length !== bitmap.width * bitmap.height * 4) {
        throw new DOMException("ImageBitmap has no usable RGBA pixel data", "InvalidStateError");
      }
      let upload = rgba;
      if (sourceX !== 0 || sourceY !== 0 || width !== bitmap.width || height !== bitmap.height || flipY) {
        upload = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
          const sourceRow = sourceY + (flipY ? height - 1 - y : y);
          const start = (sourceRow * bitmap.width + sourceX) * 4;
          upload.set(rgba.subarray(start, start + width * 4), y * width * 4);
        }
      }
      this.writeTexture({ texture: destination, mipLevel, origin: destinationOrigin,
        aspect: destinationInfo.aspect ?? "all" }, upload,
      { offset: 0, bytesPerRow: width * 4, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 });
    },
  });
}
