# ImageBitmap to native Three.js texture checkpoint

The Rust-hosted WebGPU runtime now decodes a small PNG into `ImageBitmap` and
uploads it through Three.js r186's unchanged `WebGPURenderer` path. The probe
ran on macOS arm64 with an Apple M1 Pro Metal adapter. It checked the rendered
readback at all four quadrants against the source colors and found no WebGPU
errors. The rendered image is available at
[`artifacts/rust-three-image/texture.png`](../../artifacts/rust-three-image/texture.png);
the machine-readable versions, adapter details, hashes and pixel samples are in
[`report.json`](../../artifacts/rust-three-image/report.json).

This checkpoint adds `Blob`, `createImageBitmap`, `ImageBitmap` and a narrow
`GPUQueue.copyExternalImageToTexture` implementation. Image bytes are decoded
and staged through CPU memory before the native WebGPU queue uploads them. The
supported copy is limited to ImageBitmap sources, straight-alpha sRGB input and
`rgba8unorm` destinations. This does not establish native image decoding or a
zero-copy path.

The probe uses an inline synthetic PNG. It does not implement package-resource
fetch, `Response`, or Three.js `ImageBitmapLoader`; ordinary project texture
URLs therefore remain unsupported by this checkpoint. It also does not cover
WebGL texture uploads, other image sources, native windows, or platforms beyond
the recorded Mac. The next resource gate is integrity-checked package loading
through unchanged upstream `ImageBitmapLoader` and texture rendering after
relocating the built package.

Verification:

```sh
CARGO_TARGET_DIR=/private/tmp/3jsn-image-target CARGO_PROFILE_DEV_DEBUG=0 \
  CARGO_INCREMENTAL=0 node scripts/probe-three-image.mjs
CARGO_TARGET_DIR=/private/tmp/3jsn-image-target CARGO_PROFILE_DEV_DEBUG=0 \
  CARGO_INCREMENTAL=0 cargo +1.93.0 test -j 2 -p threejs-native-runtime --locked --offline
cargo +1.93.0 fmt --all --check
npm run check
```

The probe needs host Metal access; the Cargo integration test validates image
decode and malformed-PNG rejection without requiring a GPU. One existing
GPU-dependent runtime test remains intentionally ignored in the CPU test run.
