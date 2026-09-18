# Native WebGL snapshot handoff — 2026-09-18

The Rust-hosted ANGLE runtime now exports its actual default framebuffer through
an initialized private Metal texture. An optional `metal-snapshot` consumer imports
that texture into wgpu on the identical Metal device and converts it into an
independent host texture. Production transport uses GPU blits, shared-event waits
and a GPU conversion pass. CPU readback appears only in test assertions.

This is a tested runtime boundary, **not native-window WebGL composition** or a
new `3jsn build` compatibility claim. Existing WebGPU composition is unchanged.

## Ownership and synchronization

The snapshot retains its context/display, and live leases reject context resize
or destruction. Each generation uses one texture, one shared event and bounded
transient EGL sync handles. Odd event values publish the producer; the following
even value releases the consumer. The next producer waits for that release before
overwriting the exported texture. Application rendering stays on the original
pbuffer, preserving the meaning of binding the default framebuffer.

The consumer flushes pending wgpu writes before its raw Metal wait, creates its
conversion encoder after that wait, submits it, then signals consumption. This
is an unsafe host boundary: the owning thread must serialize all queue use, with
no pre-existing unsubmitted command buffers spanning the handoff. Exact native
device identity is checked; identical producer/consumer queues are not required.

Explicit close uses bounded waits. Failed or uncertain completion retains the
lease/resources instead of certifying teardown. Device loss, timeout injection
and every native allocation-failure branch have not been hardware-tested.

## Hardware evidence

With Metal API validation enabled on the current Mac:

- [GPU test](2026-09-18-webgl-snapshot/gpu.log): two sizes/generations, initialized
  untouched buffers, Y orientation, channel preservation and premultiplication,
  repeated tokens, pending queue writes and lease lifetime. Each generation has
  an initial frame, three individually checked frames and eight queued captures.
  Queued captures are submitted without intermediate polling or readback, then
  checked after one final wait: **24 snapshot updates in total**.
- [Native state test](2026-09-18-webgl-snapshot/native-state.log): resize and export
  preserve separate application read/draw FBOs, default read/draw buffer selection,
  active-unit texture binding, enabled scissor, color masks, clear values and a
pending GL error. A duplicate publication rejects without losing cleanup or
  later publication capability.

The existing unchanged Three.js DOM fixture also passes with the
[preserved parser](2026-09-18-webgl-snapshot/dom-preserved.log) and
[restricted parser](2026-09-18-webgl-snapshot/dom-restricted.log).
The [19 CPU tests](2026-09-18-webgl-snapshot/cpu.log),
[strict all-target Clippy](2026-09-18-webgl-snapshot/clippy.log) and formatting pass.
[Source and executable identities](2026-09-18-webgl-snapshot/identities.json)
identify this checkpoint.

The first untouched-buffer run crashed inside ANGLE's `GL_BlitFramebuffer`;
[the failure record](2026-09-18-webgl-snapshot/initial-failure.txt) is retained.
ANGLE `ac6cda4cbd71` initializes a robust read attachment before lazily allocating
its pbuffer Metal texture. The fix eagerly zero-clears **only newly created or
replacement** pbuffer color storage through the draw path, preserving application
state. The original untouched-buffer assertion remains and passes. No clear is
performed during publication.

These tests run explicitly and are ignored by ordinary CPU test execution. Root
source CI does not establish native GPU or other-platform support.

## Reproduction

Use the pinned `gl@9.0.0-rc.10` ANGLE package and the existing local V8 archive:

```sh
export CARGO_HOME="$PWD/.cache/cargo"
export CARGO_TARGET_DIR="$PWD/target"
export CARGO_INCREMENTAL=0
export RUSTY_V8_ARCHIVE="$PWD/target/release/gn_out/obj/librusty_v8.a"
export THREEJS_NATIVE_ANGLE_PACKAGE="$PWD/.cache/native-webgl/node_modules/gl"
export ANGLE_LIBRARY_DIR="$THREEJS_NATIVE_ANGLE_PACKAGE/deps/darwin/dylib"
export MTL_DEBUG_LAYER=1
cargo test --offline --locked -j2 --manifest-path experiments/webgl-runtime/Cargo.toml \
  --features metal-snapshot --test snapshot -- --ignored --nocapture
cargo test --offline --locked -j2 --manifest-path experiments/webgl-runtime/Cargo.toml \
  --features metal-snapshot --lib snapshot_preserves_application_bindings_and_errors \
  -- --ignored --nocapture
```

## Remaining integration

The consumer currently provides preserve/premultiply transforms. Painter requires
straight RGBA, so the WebGL window branch still needs explicit unpremultiplication
for the facade's declared `premultipliedAlpha: true` contract, including zero-alpha
handling and transparent-edge tests. It also needs actual DOM node/context
registration, an independent surface-compatible compositor device, synchronous
lease retirement before canvas bitmap resize, and native-window presentation.
See the [composition boundary](../investigations/webgl-dom-composition.md).
