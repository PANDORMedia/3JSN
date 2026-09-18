# Native window adapter

Status: the opaque Three.js fixture visibly rendered on macOS/Metal on
2026-09-18, and a bounded run presented 120 frames with Metal API validation.
The full hardware lifecycle acceptance gate remains open. Track
[surface #15](https://github.com/PANDORMedia/3JSN/issues/15),
[Three.js #16](https://github.com/PANDORMedia/3JSN/issues/16),
[scheduling #17](https://github.com/PANDORMedia/3JSN/issues/17) and
[lifecycle #18](https://github.com/PANDORMedia/3JSN/issues/18).

## Thread and resource ownership

The player runs winit 0.30.13 on the OS event thread. It creates the window and
`WindowSurface` there: macOS requires its NSView-to-Metal-layer operation on that
thread. The prepared value contains a shared GPU registry, a surface identifier
and a retained window owner. No raw handle or JavaScript object crosses threads.
Failure before transfer releases the surface exactly once.

A dedicated worker creates V8 and runs one current-thread Tokio runtime for its
entire lifetime. Deno's local tasks require that reactor flavor; entering a
multithread runtime is insufficient even if V8 itself stays on one thread.
The worker polls JavaScript and a bounded latest-state channel. Timers and async
GPU work wake that reactor; there is no periodic idle polling loop.

The channel coalesces viewport, visibility, redraw, presentation acknowledgement
and close state. The worker requests a native redraw only when work requires it.
After rendering, the OS thread calls winit's `pre_present_notify`; its
acknowledgement lets the worker present. At most one such frame is pending.
Default surface presentation is FIFO with requested maximum frame latency two.
That is a configuration policy, not a measured latency guarantee.

The worker never invokes window methods. On close, the OS thread requests
cancellation, continues servicing events, and waits for the worker's stopped
message. The runtime releases persistent V8 handles before disposing its isolate,
then releases the surface and its retained window. The OS owner remains alive
until the stopped worker is joined. A thread-safe V8 interrupt handles synchronous
infinite JS loops; it cannot interrupt a blocked native driver call.

## Canvas and frame behavior

The integration fixture gets `nativeWindow.canvas`. This is a small canvas
protocol, not an `HTMLCanvasElement`, DOM implementation or supported game API.
It accepts WebGPU only. The future DOM adapter must supply actual canvas nodes.
The GPU adapter request includes this surface in its compatibility selection;
canvas context, device and textures use the same Deno/wgpu registry.

Presentation uses the acquired native GPU texture directly. There is no CPU
readback or image upload in that path. After present, the retained JS texture is
destroyed and the cached current texture is cleared. Abandoned frames are
discarded before resize, reconfigure, unconfigure, hiding or shutdown. This ordering
matters: destroying the texture alone leaves wgpu's acquired surface slot occupied.
Reconfiguration is never used just to expire an ordinary presented frame.

Visibility can change between an OS redraw event and GPU acquisition. Transient
acquisition statuses use a valid disposable GPU texture so the application's
callback can finish. Its completed image is copied into one GPU-owned pending
texture before the JavaScript texture expires. Presentation retries use that
image without replaying callbacks, including a one-shot render. A transient retry
waits 16 ms while the reactor continues polling JavaScript and host state; this
timer exists only while a retry is needed. Hide/restore preserves the pending
image. Explicit resize, configure or unconfigure invalidates it.

Restoring a deferred image requires native surface `COPY_DST` support, checked
before configuration. The exceptional path uses GPU copies; the normal path
still renders directly to the surface. `Lost` and `Outdated` trigger surface
reconfiguration on retry. Device failures propagate as errors rather than
pretending to have recovered a device.

Animation callbacks use one monotonic timestamp per frame. Dispatch snapshots
the registered callback IDs, honors cancellation during dispatch, runs microtask
checkpoints between callbacks and defers new callbacks until the next frame.
Exceptions use the runtime's global error event. CPU tests exercise this ordering
inside V8 as well as the scheduler's standalone fixture. Hidden, occluded,
suspended and zero-size windows stop display-frame dispatch while timers continue;
unfocused visible windows continue. The host adds no fixed simulation step.

## Run the fixtures

```sh
cargo run --locked -p threejs-native-player -- --window examples/runtime/window.mjs --frames 120
node node_modules/esbuild/bin/esbuild examples/runtime/three-window.mjs --bundle --format=esm --platform=browser --outfile=artifacts/rust-window/three-window.mjs
cargo run --locked -p threejs-native-player -- --window artifacts/rust-window/three-window.mjs --frames 120
npm run probe:window-lifecycle
```

Omit `--frames` for an interactive window. With a frame budget, a 30-second deadline
or closing before that budget fails validation; no blank/occluded run is a pass.
The Three.js fixture explicitly selects `alpha: false`: this Mac's surface accepts
opaque and postmultiplied alpha, while Three.js defaults to premultiplied alpha.
Transparent presentation still requires a compatibility implementation; the
runtime does not silently substitute a different alpha convention.
The shared Three.js scene source is unchanged; bundling resolves its imports into
generated output. This is not the proposed `3jsn build` product yet.

The lifecycle probe renders outside RAF so it can execute while macOS occludes
the window. Three separate processes each run twelve configure/resize/expiry
cycles, checking identity, dimensions, GPU validation and retained-texture expiry.
An explicit completion error then exercises teardown with an acquired texture.
Its expected nonzero exit is accepted only with all assertions and that sentinel.
This is separate from a successful visible presentation run.

## Remaining gates

Visible native captures, frame-texture assertions, resize/minimize/restore,
display/DPI changes, present failures and repeated open/close must pass on real
hardware. Device-loss recovery and native input are not implemented. Transient
failure after an ordinary acquired image is handed to presentation can still
lose a one-shot frame; retaining every normal frame would add a separate copy
cost and needs an explicit design decision.

The native adapter reports correct one-mip/one-sample surface texture metadata,
but is not a conformant complete canvas binding. Internal copy usage flags may
permit operations that the original application usage would reject; exposing
the original `texture.usage` value alone does not fix validation semantics.
Invalid configuration calls also need to preserve existing state before failing.
These and calls outside the display-frame lifecycle require broader conformance
tests. None of these gaps are certified by the current compatibility profile.

Extension JS is [embedded at compile time](validation/runtime-embedding-notes.md),
so changing the source tree after building cannot change the runtime bootstrap.
Packaging and clean-machine installation remain separate milestones.
