# Packaged image loading checkpoint

On macOS arm64, the package, runtime and player test suites pass with an
integrity-checked PNG supplied as a package resource. The runtime fixture imports
Three.js r186's unmodified `ImageBitmapLoader` from the pinned npm dependency,
loads the relative packaged URL, receives a standard `Response`, reads its
`Blob`, decodes a 2×2 `ImageBitmap`, and closes it. The same test checks exact
response bytes, media type, abort handling, missing-resource rejection and
rejection of HTTP and query URLs.

The CLI build test imports a PNG without changing application source. It verifies
that esbuild emits a content-hashed asset path, the manifest requires
`package-assets-v1`, the file's bytes/hash match the source, and the build
preserves the project. A separate negative test rejects a player that does not
advertise the capability. The player passes the verified resources into its
runtime before the native window starts.

Validation run:

- `npm test`: 121 passed, 1 skipped.
- `npm run check`: 604 source/config/document files checked.
- `cargo test --workspace --locked --offline`: passed; the existing GPU-dependent
  deferred-surface test remains intentionally ignored.
- `cargo fmt --all -- --check`: passed.

An ignored hardware-GPU integration test now exercises the package path end to
end: it generates a temporary app manifest with a hash-verified PNG, loads it
through `threejs_native_package`, passes verified resources into the runtime,
uses the untouched Three.js r186 `ImageBitmapLoader` and `WebGPURenderer`, then
checks four rendered quadrant colors after Metal readback on Apple M1 Pro. This
test's manifest is generated directly by Rust; it does not yet launch a package
emitted by the CLI after moving it to another directory. Other platforms remain
unverified. No speed or broad compatibility claim follows from these tests.

The GPU test is ignored in ordinary workspace runs because it requires a host
hardware adapter. Run it explicitly on a supported GPU host:

```sh
CARGO_TARGET_DIR=/private/tmp/3jsn-image-target CARGO_PROFILE_DEV_DEBUG=0 \
  CARGO_INCREMENTAL=0 cargo test --locked --offline \
  -p threejs-native-runtime --test package_image_gpu -- --ignored --nocapture
```

The separate [ImageBitmap texture checkpoint](2026-09-25-image-bitmap.md)
records the inline synthetic-PNG upload probe. Decode and staging still use CPU
memory; native decoding and zero-copy upload remain unverified.
