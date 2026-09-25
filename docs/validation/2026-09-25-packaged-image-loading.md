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

This checkpoint exercises package loading, decoding and the player handoff on one
Mac, but does not render the packaged texture to the GPU or perform GPU readback.
The separate [ImageBitmap texture checkpoint](2026-09-25-image-bitmap.md)
verified an inline synthetic PNG upload and four Metal readback pixels on an
Apple M1 Pro; that inline probe was rerun after this runtime integration and
passed. The packaged-resource path itself still needs a GPU readback test,
package relocation test and validation on other platforms. No speed or broad
compatibility claim follows from these tests.
