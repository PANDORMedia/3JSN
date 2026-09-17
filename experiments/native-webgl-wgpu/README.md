# ANGLE / wgpu-core 29 native texture interop

This standalone Rust experiment consumes an ANGLE-rendered private Metal texture
through wgpu-core 29.0.1. It uses the wgpu 29.0.1 Rust wrapper to exercise that
core, wgpu-hal 29.0.4 and wgpu-types 29.0.1. Those core/HAL/types versions match the
current `deno_webgpu` 0.226 dependency line, but **this does not instantiate Deno's
registry or run JavaScript**.

Status: passed on one Apple M1 Pro Mac. This is research, not an adopted runtime
backend. No root workspace dependency or engine boundary is changed.

## Reproduce

Prerequisites: Node 24, Rust 1.93, Xcode command-line tools, a Metal-capable Mac
and native GPU access. From the repository root:

```sh
npm install --prefix .cache/native-webgl --cache .cache/native-webgl/npm-cache --ignore-scripts --no-audit --no-fund --save-exact gl@9.0.0-rc.10
MTL_DEBUG_LAYER=1 node experiments/native-webgl-wgpu/run.mjs
```

The candidate supplies headers, two function-loader sources and ANGLE libraries.
Its Node addon is not built or loaded. No upstream ANGLE source build or system
package installation is performed. Cargo uses this experiment's independent
manifest/lockfile, a maximum of two jobs, and `.cache/webgl-wgpu/target` for output.
All downloaded/compiled libraries stay in ignored caches.

Use `--deps-dir <directory-containing-node_modules>` to select an existing
isolated candidate installation. After dependencies are cached, `--offline`
prevents Cargo network access. The result is written to
`artifacts/native-webgl-wgpu/report.json`. The runner enforces a 40-second native
execution timeout and records source/library hashes plus actual validation-layer
diagnostics. Builds are independently bounded at three minutes.

Focused Rust checks use the same isolated settings:

```sh
cargo fmt --manifest-path experiments/native-webgl-wgpu/Cargo.toml --check
CARGO_HOME="$PWD/.cache/cargo" CARGO_TARGET_DIR="$PWD/.cache/webgl-wgpu/target" CARGO_BUILD_JOBS=2 THREEJS_NATIVE_ANGLE_PACKAGE="$PWD/.cache/native-webgl/node_modules/gl" cargo clippy --locked --manifest-path experiments/native-webgl-wgpu/Cargo.toml -- -D warnings
```

## Ownership invariants

The Objective-C++ bridge owns EGL, the GLES context/framebuffer, its private
Metal producer texture and the shared event. Rust owns wgpu's device, queue,
imported texture wrapper and composition resources. No native objects are exposed
to game code.

- Query ANGLE's exact `MTLDevice`, then inspect the actual device owned by wgpu's
  Metal HAL. Compare object identity before any import. A mismatch fails with an
  explicit ownership gate; matching adapter names are insufficient.
- The bridge creates RGBA8Unorm, private 2D storage with one mip/layer, render-target
  and shader-read usage. A completed zero clear establishes initialized contents
  before the unsafe HAL import. This is one setup completion wait per generation,
  not CPU image transport.
- Rust takes its own retained reference to the texture and supplies matching
  metadata to `wgpu_hal::metal::Device::texture_from_raw`, then imports it through
  `wgpu::Device::create_texture_from_hal`. The descriptor exposes texture-binding
  use to wgpu; external writes occur only within the synchronization protocol.
- The bridge checks that the actual native queue borrowed from wgpu also belongs
  to the exact ANGLE device. It never destroys or replaces that queue.
- This experiment has one submitting thread, no competing queue users and no
  unsubmitted wgpu encoder at a handoff boundary. Runtime adoption must preserve
  those constraints or establish an explicit shared submission owner.

The public APIs used are documented in
[wgpu's texture import contract](https://docs.rs/wgpu/29.0.1/wgpu/struct.Device.html#method.create_texture_from_hal)
and [HAL queue access contract](https://docs.rs/wgpu/29.0.1/wgpu/struct.Queue.html#method.as_hal).
`unsafe` use remains a maintained boundary with invariants; successful pixels
alone would not justify bypassing those contracts.

## GPU ordering

For frame `n`, ANGLE waits on the previous consumer completion, draws through
GLSL ES 3.00 and signals shared-event value `2n+1`. It flushes that work.

Before creating this frame's wgpu encoder, the host commits a native wait command
on **wgpu's actual Metal queue** for value `2n+1`. It then submits a normal wgpu
WGSL composition pass. That pass reads the imported texture, blends a green layer
over its left half, and writes a separate wgpu storage texture. After submission,
the host commits a native signal command for value `2n+2`, allowing ANGLE to reuse
the producer texture.

Eight frames are queued before CPU inspection. Readback is solely of the final
composed result for validation. No producer frame is copied to the CPU or uploaded
into wgpu as transport. Resources are retained until the final native signal and
wgpu submissions complete, and mapped buffers are unmapped before release.

## Evidence and remaining work

The [recorded result](../../docs/validation/2026-09-17-webgl-wgpu-metal.json) passed
96 alternating frames over 12 imported texture generations and three extents,
checking all 155,648 composed pixels. Exact device/queue identity checks passed.
wgpu validation was enabled, and Metal reported `Metal API Validation Enabled`.
The first execution caught a reserved identifier in the test WGSL; the corrected
shader passes the same validation.

The [earlier native Metal proof](../native-webgl-interop/README.md) established the
lower-level ANGLE/Metal path independently. This experiment advances that evidence
to the selected wgpu-core version, without proving integration into
`deno_webgpu`'s resource IDs, a JS WebGL binding, native presentation or HTML.

Still unverified: multithreaded submission, multiple simultaneous canvases, device
loss/recovery, window resize, alternate formats/color-space policy, performance,
other GPU models and Windows/Linux. The source uses a narrow successful-lifecycle
test and best-effort native cleanup after failure; it is not production recovery
code. No API migration, fallback or backend adoption follows automatically from
this result.
