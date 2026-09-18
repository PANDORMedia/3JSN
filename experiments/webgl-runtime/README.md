# V8 / ANGLE WebGL binding experiment

This isolated macOS experiment prepares native context ownership for the WebGL
runtime. Upstream Three.js r186 now constructs its `WebGLRenderer`, initializes
fallback textures and clears a native framebuffer through a partial WebGL facade.
The harness injects a canvas fixture through Three's public constructor; it does
not expose DOM `canvas.getContext('webgl2')` or connect to the UI compositor.
No compatibility profile is advanced by this probe.

Rust owns context identities and lifetimes. V8 receives opaque, monotonically
allocated IDs, never native pointers. The Objective-C++ bridge owns the ANGLE
library/display lease and enforces the owner thread. Resize retains the GL
context and replaces its pbuffer. Explicit disposal reports native failure and
retains the handle for retry; failed drop cleanup reports the retained native
owner rather than unloading libraries still in use.

The temporary JavaScript probe checks independent buffers, resizing, stale IDs
and disposal. Its four-byte readback is only a test observation, not a frame
transport. The eventual compositor must use native texture sharing.

## Current validation

The 2026-09-18 Metal run passes context creation/isolation, observation of a
zero-initialized pixel before first clear and after resize, typed-view offset
canaries, rejected resize preservation, GLSL compilation/linking, malformed GLSL,
foreign/wrong-kind/deleted resource rejection, and context disposal. This is
bounded evidence on an Apple M1 Pro, not WebGL conformance. Eight CPU tests pass:
four registry controls, three upload-boundary controls and one query protocol
control. Strict all-target Clippy passes.

The upstream renderer initialization harness verifies an exact red pixel after
`renderer.clear()`, disposal, typed query results, short upload rejection,
cross-context/deleted objects, invalid viewport preservation, precision errors,
coalesced JavaScript/native error flags, and invalid host dimensions. The shader
probe separately verifies that successful attachment preserves a preceding GL
error. No geometry or Three.js scene has drawn through this bridge yet.

The facade intentionally remains partial: only bounded RGBA8 null/Uint8Array
uploads, default unpack state and a 64 MiB per-image allocation budget are
implemented. Unsupported overloads are explicit errors. There is no aggregate
GPU allocation quota. Shader probe operations are not yet standard WebGL methods.
Context-loss recovery, zero-sized canvases, DOM resizing, full WebIDL conversion,
object query reflection and remaining drawing APIs are open work.

The first run rejected `EGL_EXT_create_context_robustness`, which the packaged
Metal backend does not advertise. Reviewing pinned ANGLE source established that
WebGL mode independently enables ANGLE buffer-bounds validation. The corrected
path requires WebGL compatibility and robust resource initialization on **both**
context and pbuffer, and omits the unsupported EXT attributes. This does not
establish native robust access or reset recovery. Undersized draw validation,
full-frame/depth/stencil/texture initialization, context loss, injected teardown
failure and other platforms still need integration evidence.

## Reproduction

Use the pinned `gl@9.0.0-rc.10` package for its ANGLE libraries and headers. This
experiment does not build or load its Node addon. Set
`THREEJS_NATIVE_ANGLE_PACKAGE` to the absolute package directory, then:

```sh
cargo build --locked --manifest-path experiments/webgl-runtime/Cargo.toml
cargo clippy --locked --manifest-path experiments/webgl-runtime/Cargo.toml --all-targets -- -D warnings
MTL_DEBUG_LAYER=1 target/debug/threejs-native-webgl-runtime \
  "$THREEJS_NATIVE_ANGLE_PACKAGE/deps/darwin/dylib"
```

A shared `CARGO_TARGET_DIR` is needed if running the executable at the path above.
The local build used the existing matching V8 150.4.0 archive via
`RUSTY_V8_ARCHIVE`. Build logs and hardware receipts are currently in ignored `.cache/native-webgl/`.
The native libraries are external pinned inputs; they are not bundled here.

Run the upstream renderer control after building:

```sh
node_modules/.bin/esbuild experiments/webgl-runtime/renderer-init.mjs \
  --bundle --format=iife --platform=browser --outfile=.cache/native-webgl/renderer-init.js
MTL_DEBUG_LAYER=1 target/debug/threejs-native-webgl-runtime \
  "$THREEJS_NATIVE_ANGLE_PACKAGE/deps/darwin/dylib" .cache/native-webgl/renderer-init.js
```

The binary enters a current-thread Tokio runtime before creating V8 so its delayed
tasks have a host. This synchronous fixture does not prove application event-loop
or shutdown behavior. No browser, Node addon or CPU frame transport is used.
