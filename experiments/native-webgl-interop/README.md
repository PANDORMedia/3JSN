# ANGLE / native Metal texture interop

This isolated macOS experiment proves a native GPU composition path using the
ANGLE libraries distributed with `gl@9.0.0-rc.10`. The implementation is a small
Objective-C++ executable so that Rust, V8 and wgpu adaptation cannot obscure the
native ownership contract. It does not load the Node WebGL addon or execute JS.

## Reproduce

Prerequisites: Node 24, Xcode command-line tools, a Metal-capable Mac and native
GPU access. Install the pinned candidate into an ignored cache; lifecycle scripts
are disabled and no addon or ANGLE source build is needed:

```sh
npm install --prefix .cache/native-webgl --cache .cache/native-webgl/npm-cache --ignore-scripts --no-audit --no-fund --save-exact gl@9.0.0-rc.10
node experiments/native-webgl-interop/run.mjs
```

An existing isolated installation can be selected with `--deps-dir <directory>`.
The runner compiles the original probe plus the candidate's two function-loader
sources with one compiler driver, then runs a bounded GPU test. The executable
stays in `.cache/webgl-interop/`; the report goes to
`artifacts/native-webgl-interop/report.json`. No third-party binary is committed.

To request the Metal API validation layer:

```sh
MTL_DEBUG_LAYER=1 node experiments/native-webgl-interop/run.mjs
```

The runner records that request. Availability of a validation layer must also be
checked from its runtime diagnostics; the environment variable alone is not a
validation result.

## Ownership and synchronization

1. Select ANGLE's Metal backend explicitly and query its exact `MTLDevice` using
   `EGL_EXT_device_query` and `EGL_ANGLE_device_metal`.
2. Create a private Metal texture on that device with render-target/shader-read
   usage. Import it with `EGL_METAL_TEXTURE_ANGLE`, then attach it to a GLES3
   framebuffer. ANGLE's WebGL-compatible context needs an explicit host-side
   request for `GL_OES_EGL_image`; this is not a proposed extension exposed to games.
3. Render alternating colors through GLSL ES 3.00. Publish each producer completion
   through an EGL Metal shared-event fence and flush its command stream.
4. An independent native Metal queue waits on that event. A compute shader reads
   the producer texture directly and blends a green layer over its left half into
   a second private texture. Signal consumer completion after its commands.
5. Before reusing the producer texture, ANGLE waits on the consumer event on the
   GPU. Queue eight frames before the CPU waits for final test results.

Only the **final composed pixels** are copied to CPU-visible buffers for assertions.
No producer image is read back or reuploaded to transport it into the compositor.
The test uses 12 fresh texture/EGLImage generations over three extents, verifies
every final pixel and tears resources down after GPU completion. This exercises
size-dependent allocation and lifetime; it is not a window-resize acceptance test.

## Evidence and limitations

The [recorded result](../../docs/validation/2026-09-17-webgl-metal-interop.json)
contains native identity, library/source hashes, 96 frames and 155,648 checked
pixels. The [WebGL investigation](../../docs/investigations/webgl.md) describes
the integration choices this informs.

This proves same-device ANGLE/native Metal interop without an upstream patch.
It does **not** prove that wgpu can adopt this device/texture/queue contract, that
the Node WebGL binding can expose it, or that a complete HTML/WebGL compositor
works. Rust wrapping, browser API behavior, presentation, device loss, color-space
policy, performance and other platforms remain separate gates. This small probe
also does not replace runtime-grade recovery and cleanup after every failure.
