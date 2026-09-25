# WebGL drawing-buffer preservation — 2026-09-25

The optional native WebGL canvas now reports the requested
`preserveDrawingBuffer` value. With the default `false`, its default color,
depth and stencil buffers are cleared after a successful native composition;
with `true`, the frame remains available to later WebGL reads. Context ownership
and this option remain host-private.

On macOS/Metal, the offscreen DOM compositor integration passes for both values.
It checks that the painter receives the rendered canvas before the clear,
samples the drawing buffer after the compositor boundary, covers RGBA and opaque
RGB contexts, and verifies the default false and explicit true cases. The clear
overrides and restores color/depth write masks, scissor and rasterizer-discard
state, preserves the application GL error queue, and resets color/depth/stencil
to WebGL defaults. An ANGLE shared-event wait orders the clear behind the
compositor's native texture read without a CPU-side frame wait.

The native window hook runs after `SurfaceTexture::present()` returns, so a
failed or skipped surface acquisition does not discard the drawing buffer. The
window route compiles with the `native-webgl` feature; a visible native-window
presentation was not run as part of this checkpoint. This does not establish
other platform support, full WebGL conformance, context loss/recovery, or a
performance improvement.

## Evidence

The preserved and discarded Metal composition cases, plus the alpha/premultiply
matrix, passed with ANGLE's Metal API validation enabled. The native-window host
passed `cargo check --release --all-targets --features native-webgl`. Formatting
passed. The separate `webgl_dom_canvas` runtime test could not request its
offscreen WebGPU adapter in this run (`NotPresent`); it provides no new DOM-suite
result.

The ignored source checks and GPU integration are in
[`webgl_composition.rs`](../../experiments/compiled-ui-runtime/tests/webgl_composition.rs)
and [`webgl_dom_checks.js`](../../experiments/compiled-ui-runtime/tests/webgl_dom_checks.js).
The pinned ANGLE input and local V8 archive are external build prerequisites;
the native libraries are not included in the project.

## Native-window attempt — 2026-09-25

The compiled-UI player built successfully with the pinned `gl@9.0.0-rc.10`
ANGLE package and the native WebGL feature. The unchanged public window fixture
was then run for 120 frames with the documented probe. The process produced no
fixture records and timed out after 95 seconds; stderr reported macOS
LaunchServices scheduling failure and an invalid `com.apple.hiservices`
connection. The runner verified that the fixture sources stayed unchanged and
saved the failed-run report under the ignored `.cache/native-webgl/` directory.
This attempt does not demonstrate visible presentation or identify a rendering
failure: the macOS window host did not deliver the fixture's first frame. Keep
the native-window gate open until the probe runs in a usable desktop session.
