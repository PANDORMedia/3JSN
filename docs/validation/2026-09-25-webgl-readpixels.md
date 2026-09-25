# WebGL `readPixels` — 2026-09-25

The partial ANGLE context facade now exposes the standard seven-argument
`readPixels(x, y, width, height, format, type, destination)` entry point for
RGBA/UNSIGNED_BYTE reads into a `Uint8Array`. It reads from the current read
framebuffer with default pack state and preserves the native GL error queue.
The native boundary validates nonnegative extents, checked RGBA byte counts,
destination length and a 64 MiB cap before passing a slice to ANGLE. The API
does not provide pixel-pack buffers, non-RGBA8 types, or the WebGL2 offset
overload. Readback is synchronous and is not used to transport compositor frames.

## Evidence

On macOS arm64 / Apple M1 Pro, the standalone upstream Three.js r186
`WebGLRenderer` initialization harness passed with ANGLE Metal API validation
enabled. It cleared the default framebuffer to red and observed
`[255, 0, 0, 255]` through the new public method. The same run verified a
`Uint8Array.subarray` destination without touching surrounding canaries, a short
destination returning `INVALID_OPERATION` without modification, unsupported RGB
format returning `INVALID_ENUM`, and a pending native `INVALID_VALUE` remaining
available after a successful read.

The existing unchanged [DOM Three.js fixture](../../examples/webgl-dom/main.mjs)
also passed its ignored Metal integration test through the real
`HTMLCanvasElement.getContext('webgl2')` path. That fixture renders with upstream
Three.js, calls `gl.readPixels` for its rendered canvas pixels, checks GL errors,
and updates a `CanvasTexture`; the complete test passed with Metal API validation
enabled.

The WebGL runtime's CPU suite passes 23 tests (3 hardware-only tests ignored),
strict all-target Clippy and formatting pass, and the repository suite passes
201 Node tests (1 existing skip) plus 858 source/config/document checks. The
hardware check uses the pinned `gl@9.0.0-rc.10` ANGLE library and source revision
`ac6cda4cbd71`.

Reproduce after preparing the pinned ANGLE and DOM dependencies, then bundling and
running the unchanged fixture as described in the
[DOM integration procedure](2026-09-18-webgl-dom.md#reproduce-on-the-tested-metal-host).
For the standalone controls, bundle `experiments/webgl-runtime/renderer-init.mjs`
with esbuild and pass that bundle as the second argument to
`threejs-native-webgl-runtime`, as documented in the
[runtime probe guide](../../experiments/webgl-runtime/README.md#reproduction).

This verifies a bounded macOS RGBA8 readback path, not framebuffer attachment or
render-target APIs, WebGL conformance, context-loss recovery, window presentation,
other platforms or performance. The API remains experimental and has no GPU
allocation quota beyond its per-call bound.
