# Rust/V8 WebGL initialization — 2026-09-18

An isolated Rust/V8 host now runs the unchanged upstream Three.js r186
`WebGLRenderer` constructor against ANGLE's native Metal backend. Its fallback
2D, cube, array and 3D textures and scratch framebuffer objects use real GLES
resources. Calling Three's `setClearColor` and `clear` produces the observed
RGBA pixel `[255, 0, 0, 255]` on an Apple M1 Pro with Metal API validation enabled.

This is renderer initialization, not a mesh-rendering or unchanged-project
checkpoint. The fixture explicitly injects its canvas/context through Three's
public constructor. There is no DOM canvas registration, native window or UI
composition in this experiment. Missing methods remain absent; extensions are
not advertised without bindings. No compatibility profile advances.

## Evidence

- [Renderer report](2026-09-18-webgl-runtime/renderer-init.json) and
  [Metal stderr](2026-09-18-webgl-runtime/renderer-init-stderr.txt).
- [Ownership/shader probe](2026-09-18-webgl-runtime/ownership.json) and
  [Metal stderr](2026-09-18-webgl-runtime/ownership-stderr.txt).
- Eight [CPU tests](2026-09-18-webgl-runtime/cpu-tests.txt), strict all-target
  [Clippy](2026-09-18-webgl-runtime/clippy.txt), and
  [source identities](2026-09-18-webgl-runtime/source-identities.json).
- [ANGLE supply identity](2026-09-18-webgl-runtime/angle-supply.json): pinned
  `gl@9.0.0-rc.10` provides libraries, headers and generated loaders. Its Node addon
  is neither built nor loaded. This is the same ANGLE artifact used by the earlier
  native texture-sharing investigation.

The hardware controls cover typed-view canaries, short RGBA uploads, foreign and
deleted objects, preserved GL errors, merged error flags, invalid viewport state,
precision enums, context isolation, bounded dimensions, resize preservation and
GLSL compile/link failures. They do not establish complete WebGL conformance or
hostile-code isolation. Readback is only a validation observation.

A source review of pinned ANGLE revision `ac6cda4cbd71` found that
[WebGL context mode enables buffer-access validation independently of native robust access](https://chromium.googlesource.com/angle/angle/+/ac6cda4cbd71/src/libANGLE/Context.cpp#4529).
The bridge requires robust initialization for both context and pbuffer. The
unsupported EXT robust-context attributes are not requested; this does not claim
GPU reset recovery. Host typed-array bounds are checked independently because
native pointers do not carry JavaScript allocation lengths.

## Remaining integration

Next: standard shader/program reflection, buffer/VAO and uniform bindings, then
an unchanged indexed Three.js mesh and GLSL material. The resulting drawing
buffer must connect to the existing native texture-sharing compositor boundary;
per-frame CPU readback is not an acceptable transport.

The current upload surface accepts RGBA8/null or Uint8Array only, default unpack
state, and a 64 MiB per-image budget. There is no aggregate allocation quota.
WebIDL conversions, resource pending-deletion semantics, zero-sized DOM canvases,
context loss, arbitrary uploads and other platforms remain incomplete. The
synchronous test harness does not prove a full event loop or shutdown protocol.

[Build and run commands](../../experiments/webgl-runtime/README.md).
