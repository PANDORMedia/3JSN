# WebGL context attributes and native composition

This checkpoint addresses the alpha/context-attribute finding in the
[PR #64 review](https://github.com/PANDORMedia/3JSN/pull/64#pullrequestreview-5251544972).
The previous DOM backend discarded the second `getContext` argument and always
treated canvas pixels as premultiplied alpha. That changed both opaque rendering
and straight-alpha composition for unchanged applications.

## Implementation

The DOM backend converts context options before allocating a context. Attribute
getters can resize the canvas or recursively create a context, so allocation reads
dimensions and rechecks first-context ownership after conversion. Later calls
retain the existing context without rereading options. Reported attributes are
copies; the compositor uses private metadata even if the application replaces
`getContextAttributes`.

`alpha`, `depth` and `stencil` select the native framebuffer's attachments.
`premultipliedAlpha` selects GPU unpremultiplication or preservation on the way to
the existing straight-alpha HTML painter. These choices survive bitmap resize.
The defaults and interpretation follow the
[Khronos WebGL context-attribute contract](https://registry.khronos.org/webgl/specs/latest/1.0/#5.2).

This pinned ANGLE Metal build exposes only alpha-bearing EGL configs. An attempted
RGB config selection failed; the raw failure and configuration enumeration are
archived below. Opaque contexts instead use ANGLE's RGB IOSurface client-buffer
path. It supplies an RGB default framebuffer, including destination-alpha blending
semantics, while retaining the existing snapshot and queue ownership protocol.
There is no CPU mapping or pixel transport. Row stride uses IOSurface alignment,
including odd bitmap widths. Fresh color, depth and stencil storage is explicitly
GPU-cleared before application access; resize restores application write masks.

ANGLE's [IOSurface implementation at ac6cda4cbd71](https://github.com/google/angle/blob/ac6cda4cbd71/src/libANGLE/renderer/metal/IOSurfaceSurfaceMtl.mm)
retains the IOSurface and implements RGB storage by initializing backing alpha to
one and disabling alpha writes. This source inspection explains the mechanism;
the hardware tests below verify the behavior of the installed libraries. It does
not establish authenticated binary provenance.

## Evidence

- All eight alpha/depth/stencil combinations pass on Metal: actual attachment
  bits, clear/readback, destination-alpha blending, initial depth, odd-width resize
  and depth/front/back-stencil write-mask restoration. A draw after resize checks
  that freshly cleared depth and stencil admit the expected first fragment.
- The existing native snapshot control still preserves application framebuffer
  bindings and pending GL errors. Nineteen native CPU tests pass.
- Both parser modes pass four alpha/premultiplication combinations through the
  real HTML compositor. Pixel assertions cover canvas over blue HTML, white HTML
  over canvas, initialized reset, repaint, replacement and teardown.
- Both parser modes pass the unchanged Three.js default opaque renderer and real
  DOM checks for defaults, depth/stencil selection, invalid dictionaries, getter
  ordering, enum conversion, getter-triggered resize, recursive context requests
  and copied attributes. Twenty-four DOM CPU tests pass in the preserved build.
- The unchanged public animated demo passes 60 frames in each parser mode with
  five checkpoints, four generations and cleanup. Final captures match the prior
  checkpoint: `18a45c0715feba788761025143be29d1234ad7e6034a0169a5980e3734c8d041`.
- Scoped strict Clippy, formatting and repository source checks pass.

[Archived logs and demo reports](2026-09-18-context-attributes/) include executable
and fixture hashes for the demos. Tests use local ANGLE libraries, the public font
fixture and Metal validation. Readbacks serve assertions only.

The native checks use `cargo test --manifest-path experiments/webgl-runtime/Cargo.toml`;
run its ignored tests separately with `ANGLE_LIBRARY_DIR` pointing to the package's
`deps/darwin/dylib` directory and `MTL_DEBUG_LAYER=1`. The build also needs
`THREEJS_NATIVE_ANGLE_PACKAGE` pointing to the pinned `gl` package root.
For each compiled UI feature mode, run the ignored `dom_webgl_` tests in
`webgl_composition` with that package root and `THREEJS_NATIVE_COMPOSITION_FONT`
set. Run `webgl_dom_canvas` in `webgl_dom` with `THREEJS_NATIVE_DOM_FIXTURE` pointing
to the bundled public `examples/webgl-dom/main.mjs`. The archived demo reports
record exact commands, environments and input hashes for the 60-frame runs.

## Remaining boundary

This is an experimental Metal checkpoint, not full WebGL conformance or a new
platform claim. The earlier `preserveDrawingBuffer` limitation is superseded by
the [2026-09-25 preservation checkpoint](2026-09-25-preserve-drawing-buffer.md),
which reports the requested value and clears after native composition when false.
Antialiasing remains unavailable and reports false. Power preference is validated
as an enum but remains a hint; there is no GPU-selection policy. Desynchronized
presentation and performance-caveat policy remain unimplemented.

Native-window acceptance, context loss, GPU failure recovery, broader APIs,
signing and other-platform hardware tests remain open. No context-loss or broader
issue acceptance gate is closed by these offscreen tests.
