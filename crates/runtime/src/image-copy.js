function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid image copy ${name}`);
  return value;
}

function sequenceValues(value) {
  if (Array.isArray(value)) return value;
  return value && typeof value[Symbol.iterator] === "function" ? Array.from(value) : undefined;
}

function extentValue(size, name, index, fallback) {
  const sequence = sequenceValues(size);
  return integer((sequence ? sequence[index] : size?.[name]) ?? fallback, name);
}

function originValue(origin, key, index, label) {
  const sequence = sequenceValues(origin);
  return integer((sequence ? sequence[index] : origin?.[key]) ?? 0, label);
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
      if ((destinationInfo.colorSpace ?? "srgb") !== "srgb" || destinationInfo.premultipliedAlpha === true) {
        throw new DOMException("Only straight-alpha sRGB image copies are supported", "NotSupportedError");
      }
      if (destination.format !== "rgba8unorm" && destination.format !== "rgba8unorm-srgb") {
        throw new DOMException("Image copies require an rgba8unorm destination texture", "NotSupportedError");
      }

      const sourceOrigin = sourceInfo.origin ?? {};
      const destinationOrigin = destinationInfo.origin ?? {};
      const sourceX = originValue(sourceOrigin, "x", 0, "source x");
      const sourceY = originValue(sourceOrigin, "y", 1, "source y");
      const destinationX = originValue(destinationOrigin, "x", 0, "destination x");
      const destinationY = originValue(destinationOrigin, "y", 1, "destination y");
      const destinationZ = originValue(destinationOrigin, "z", 2, "destination z");
      const mipLevel = integer(destinationInfo.mipLevel ?? 0, "mip level");
      const width = extentValue(copySize, "width", 0, bitmap.width - sourceX);
      const height = extentValue(copySize, "height", 1, bitmap.height - sourceY);
      const depth = extentValue(copySize, "depthOrArrayLayers", 2, 1);
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
      if (sourceX !== 0 || sourceY !== 0 || width !== bitmap.width || height !== bitmap.height || sourceInfo.flipY === true) {
        upload = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
          const sourceRow = sourceY + (sourceInfo.flipY === true ? height - 1 - y : y);
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
