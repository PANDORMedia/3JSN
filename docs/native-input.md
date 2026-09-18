# Native input bridge

Keyboard, mouse, wheel and window-focus input now reach Rust-hosted JavaScript
in the native window fixture. The [Mac checkpoint](validation/2026-09-18-native-input.md)
records an interactive Three.js scene, resize and clean close. The separate
[DOM window experiment](../experiments/dom-canvas/WINDOW.md) has bounded mouse,
keyboard and click delivery into native document nodes. General DOM input,
UIEvent subclasses, forms, IME, pointer capture, controllers and other-platform
hardware validation remain open in issues
[#25](https://github.com/PANDORMedia/3JSN/issues/25) and
[#33](https://github.com/PANDORMedia/3JSN/issues/33).

The [input-coalescing checkpoint](validation/2026-09-18-input-coalescing.md)
records bounded adjacent-motion batching, ordered discrete-event delivery, CPU
burst/error controls and native React/completion regressions. Queue overflow
remains explicit; this is not lossless pointer-trajectory or full input support.

## Ownership and delivery

`crates/player/src/input.rs` converts winit events on the OS thread into owned
`NativeInput` records. Runtime-facing types contain no winit types, native
handles, V8 values or callbacks. `crates/runtime/src/input.rs` serializes one
record into the owning isolate and invokes its registered binding. The callback
handle is released before isolate disposal, independently of surface handles.

A shared bounded [input queue](../crates/input-queue/src/lib.rs) connects each
window thread to its owning runtime worker. The standalone player holds at most
1,024 records; the experimental DOM window holds at most 128. Adjacent queued
mouse moves retain the newest position. The standalone player also requires
matching button and modifier snapshots before combining two moves. A button,
key, wheel, focus or leave/reset record is a barrier: moves never cross it, and
discrete records are not combined. This is delivery of the latest motion samples,
not lossless recording of the pointer trajectory.

The window thread never waits for queue capacity. If non-coalescible records fill
the queue, overflow still requests cancellation and shuts the player down with
an explicit error; it does not discard a key-up or grow an unbounded queue.
The worker delivers at most 64 queued records per turn, with microtask checkpoints
between events, while continuing to service frames, timers and IO. Input delivery
does not require a visible window or an animation frame. Queue overflow has CPU
coverage; deliberate overflow of a live GPU window has not been injected.

The queue owns no window, V8 handles or input semantics. The host supplies the
motion-combination rule; a short mutex protects FIFO state and the consumer's
waker. Input destruction and wake callbacks run after unlocking. The asynchronous
player registers a waker while empty, so input and sender disconnection can wake
its event loop without periodic polling. Queued records drain after sender
disconnection; dropping the receiver returns subsequent inputs as closed.
The experimental DOM worker retains its existing 8 ms polling loop; sharing
the queue does not change that worker's scheduling policy.

Viewport and presentation state still use a separate coalescing channel.
FIFO ordering between input records is guaranteed; ordering between an input
record and coalesced resize globals is not. The eventual DOM adapter must resolve
that boundary together with layout and hit testing.

## Fixture events

`nativeWindow.canvas` remains a standalone EventTarget protocol, not an
HTMLCanvasElement. Keyboard and focus events target the global EventTarget;
mouse and wheel events target the canvas. No DOM bubbling or synthetic parent
tree is installed. Deno's maintained Event/EventTarget machinery supplies
listener ordering, cancellation, once/passive behavior and error reporting.

The binding constructs `Event` objects with readonly input fields. It does not
install incomplete global KeyboardEvent, MouseEvent or WheelEvent constructors.
Types are `keydown`, `keyup`, `focus`, `blur`, `mousemove`, `mousedown`, `mouseup`,
`mouseleave` and `wheel`. Click, context-menu, pointer, text/composition and form
actions are not synthesized.

- Keys preserve layout-dependent `key` independently from physical `code`, plus
  location, repeat and four modifier flags. Winit Super spellings map to Meta.
  Dead/unknown keys stay explicit; winit's synthetic focus-reconciliation keys
  are ignored.
- Eight observed modifier-side bits supplement aggregate state because macOS
  sends modifier keys before `ModifiersChanged`. Releasing one of two held Shift
  keys retains Shift. Without side metadata, a modifier held across focus gain
  can have an unknown side; a later isolated transition may be ambiguous.
- Five named mouse buttons use UI Events numbers and masks: middle mask 4,
  right mask 2. State changes before each snapshot. Unnamed extra buttons fail
  with an explicit unsupported error.
- Coordinates use the latest CursorMoved sample in CSS pixels. Button/wheel
  events retain that sample because winit supplies no position on those events.
  Missing samples or changed sample DPR fail explicitly. These are last-observed
  coordinates, not an OS pointer-query service.
- Wheel signs convert winit's content-motion convention. Pixel deltas divide by
  DPR; line deltas retain line units with `deltaMode=1`.
- Blur clears native button/modifier state without forged key-up events. The demo
  clears its drag on blur, mouse-up and mouse-leave. Leaving the canvas does not
  claim pointer capture or global blur.

Fresh host events are trusted. A private WeakSet limits the redispatch guard to
those events: validate the receiver, reject reentrancy, reset trust for public
redispatch and preserve cancellation return values even for empty targets.
An own nonconfigurable getter prevents shadowing native `isTrusted`. This repairs
the relevant pinned Deno shortcuts; it is not complete DOM conformance or a
security boundary. The runtime executes trusted local code. Event timestamps
are created on JS delivery; OS-to-display latency has not been measured.

## Demo

The shared [controller](../examples/spinning-scene/controls.mjs) uses ordinary
event listeners and camera methods, with no native handles or OS imports.
Drag or use arrows to orbit, scroll to zoom, press Space to pause/resume and R to
reset the camera and animation time. Pause/resume resets the next frame's time
baseline, including when no frames ran while hidden. R preserves paused state.

```sh
node node_modules/esbuild/bin/esbuild examples/runtime/three-window.mjs --bundle --format=esm --platform=browser --outfile=artifacts/rust-window/three-window.mjs
cargo run --locked --release -p threejs-native-player -- --window artifacts/rust-window/three-window.mjs
```

Bundle `examples/runtime/input-contract.mjs` for the diagnostic trace. It checks
native trust and logs at most 64 raw records; the demo's control callback logs
camera/pause changes separately. These diagnostics are not a benchmark. Thirteen
Node tests cover the controller; V8 tests exercise host serialization and dispatch.
