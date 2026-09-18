# WebGL canvas / GPU HTML composition — 2026-09-18

The real DOM WebGL canvas can now feed the existing GPU HTML painter through an
independent compositor device matched to ANGLE's actual Metal device. Application
JavaScript does not create a dummy WebGPU canvas. Snapshot conversion produces
straight RGBA for Painter, including unpremultiplication and alpha-zero handling.

The native-window integration is implemented and compiles, but **native-window
presentation remains unverified** at this checkpoint. The desktop was locked;
the first attempted window run reached its frame-budget timeout. See the
[attempt record](2026-09-18-webgl-composition/window-attempt.txt). Offscreen tests
below do not substitute for presentation evidence.

## Verified GPU behavior

The production DOM bridge, ANGLE runtime, generation adapter, independent Metal
bridge and Painter are exercised together by `webgl_composition.rs`:

- [Preserved parser](2026-09-18-webgl-composition/preserved.log) and
  [restricted parser](2026-09-18-webgl-composition/restricted.log) both pass with
  Metal API validation enabled.
- Native WebGL premultiplied red at half alpha blends over blue HTML. Translucent
  white HTML blends over the canvas and over the background beyond its edge.
  Interior rectangles are compared against explicit expected RGBA values.
- A same-width assignment preserves context identity, retires the export lease,
  resets the bitmap to transparent and creates a new export generation. Ordinary
  repaint reuses that generation. Actual DOM node/context replacement acquires
  new identities and replaces the painter registration.
- A host without the optional registry returns no WebGL canvas. Cleanup closes
  export leases before native contexts; uncertain completion retains owners.
- The shared bounded PNG capture helper writes the final assertion image below.
  Readback is test/capture-only; canvas transport stays on the GPU.

![Native GPU composition control](2026-09-18-webgl-composition/composition.png)

The snapshot test separately passes preserve, premultiply and unpremultiply modes
across three sizes/generations, including eight queued captures per generation
without intermediate CPU waits. Dirty RGB at alpha zero becomes exact zero RGBA.

The new upstream Three `blending.mjs` control renders a transparent
`MeshBasicMaterial` with opacity 0.5. Its center is `[127, 0, 0, 128]`, all corners
are transparent, and 3,136 pixels contain premultiplied red. Five blend-state
methods preserve an existing GL error; four invalid-enum calls leave equation and
factor state unchanged. Restoring the valid state reproduces every rendered byte.
[Compact observed results](2026-09-18-webgl-composition/blending-observation.json).

## Regression scope

[Strict scoped Clippy](2026-09-18-webgl-composition/clippy.log) passes for the
compiled player and both integration targets. The restricted player/test target,
default WebGPU player, and interpreted DOM player with the optional backend also
compile/check successfully. The shared DOM target passes 24 CPU/V8 tests, with
its hardware control ignored during that CPU run. The actual preserved-parser
[DOM WebGL hardware regression](2026-09-18-webgl-composition/dom-regression.log)
also passes against the new registry. The source/configuration check passes for
823 files; JavaScript syntax checks and `git diff --check` pass.
[Source identities](2026-09-18-webgl-composition/source-identities.json) identify
the implementation and fixture inputs at this checkpoint.

The older offscreen WebGPU probe still passes its canvas ownership, transport,
initialization and alpha controls. It exits one with the **previously documented**
ancestor-overflow clipping failure: sample `(400,100)` is `[16,21,34,255]` rather
than white. The [compact regression record](2026-09-18-webgl-composition/webgpu-regression.json)
and [original failure description](2026-09-18-dom-canvas.md#failed-gate-an-ancestor-clip-is-lost)
keep that limitation explicit. This is not a passing whole-painter certification.

## Window lifecycle implementation

The shared window host installs the optional backend only when built with
`native-webgl` and given `THREEJS_NATIVE_ANGLE_LIBRARY_DIR`. Otherwise the existing
WebGPU route remains available. The backend associates the actual native DOM node
identity with its branded ANGLE context, never application-overridden properties.

A shared owner-thread generation retires synchronously before bitmap resize,
including same-value assignments. Failed retirement aborts native replacement
and retains the failed generation. The attribute observer still runs after the
DOM attribute changes; atomic attribute rollback is not claimed. WindowScene
tracks node identity and generation, rather than size alone, when replacing
Painter registrations.

The WebGL route matches a surface-compatible Metal device, uses a separate queue
with the native event handoff, and reports that distinction. Only the existing
WebGPU route claims shared native queue identity. Shutdown drains composition,
unregisters images, closes snapshot generations and then releases ANGLE contexts.

## Remaining gate and reproduction

`examples/webgl-window` is an ordinary animated Three/HTML fixture with genuine
transparency, resize, same-size reset and canvas replacement. Its window run and
visual inspection still require an unlocked desktop. No new package profile,
ANGLE library bundling, Windows/Linux GPU support, performance guarantee, device
loss recovery or general WebGL/browser compatibility is claimed.

Offscreen reproduction, using the existing prepared dependency cache:

```sh
export CARGO_HOME="$PWD/.cache/cargo"
export CARGO_TARGET_DIR="$PWD/target"
export CARGO_INCREMENTAL=0
export RUSTY_V8_ARCHIVE="$PWD/target/release/gn_out/obj/librusty_v8.a"
export THREEJS_NATIVE_ANGLE_PACKAGE="$PWD/.cache/native-webgl/node_modules/gl"
export THREEJS_NATIVE_COMPOSITION_FONT="$PWD/.cache/dom-canvas/blitz/examples/wasm_hello/assets/DejaVuSans.woff2"
export MTL_DEBUG_LAYER=1
cargo test --offline --locked -j2 --manifest-path experiments/compiled-ui-runtime/Cargo.toml \
  --features native-webgl --test webgl_composition -- --ignored --nocapture
# Repeat with --no-default-features for parser omission.
```
