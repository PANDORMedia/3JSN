# Orbit Study: DOM and Three.js in one window

An original, redistributable fixture using a real document canvas, upstream
Three.js, an HTML status label and button, resize events, and Space/R keyboard
input. The scene is shared with [spinning-scene](../spinning-scene/scene.mjs).
The application contains no native host operations or probe globals.

Click Pause or press Space to pause/resume. Press R to reset the animation while
retaining its paused/running state. A resumed animation establishes a fresh frame
timestamp, so an interval without animation callbacks does not get added at once.
Resize updates both the canvas CSS size and its drawing buffer through Three.js.
The canvas has no border, padding, clip or transform.

For a browser reference, run these commands from the repository root:

```sh
mkdir -p .cache/dom-window-web
cp examples/dom-window/index.html .cache/dom-window-web/index.html
npx --no-install esbuild examples/dom-window/app.mjs --bundle --platform=browser --format=esm --sourcemap --outfile=.cache/dom-window-web/app.bundle.mjs
python3 -m http.server 8000 --directory .cache/dom-window-web
```

Open `http://localhost:8000` in a browser with hardware WebGPU. The HTML is copied
unchanged; both hosts load the same generated application module. A hardware
adapter is required, and GPU initialization, validation and device-loss failures
are surfaced. This is a fixture, not unchanged-project compatibility certification.
The current `native-window-v1` CLI profile does not package this HTML document;
this fixture targets the separate DOM-window integration experiment.
Use the [native run instructions](../../experiments/dom-canvas/WINDOW.md) to open
the combined window. Its [hardware checkpoint](../../docs/validation/2026-09-18-dom-window.md)
records the tested behavior and remaining gates.

The experimental native bootstrap is
[window.js](../../experiments/dom-canvas/src/window.js). It runs after the DOM
canvas extension and imports the shipping animation scheduler. Native callbacks
provide a physical viewport and scale, while pointer positions are already CSS
coordinates. Rust hit-tests the current layout and releases its document borrow
before dispatch; the existing DOM binding owns node identity and propagation.

The bounded input protocol accepts `mousedown`, `mouseup`, `mousemove`,
`keydown`, `keyup`, `focus`, `blur` and an internal `pointerreset`. Direct host
`click` inputs are rejected. A primary-button release generates one click only
when its preceding press used that same target and button. Releasing over another
node does not activate it. Common-ancestor click targeting, auxiliary activation
and multi-click counting are not implemented. Pointer events use a wrapped DOM
target, or the global target for an empty node ID. Keyboard and focus events target the
global object. Button state follows down/up events. The host sends `pointerreset`
on cursor leave and resize; it clears held buttons and pending click targets
without emitting a DOM event. Blur also clears that pointer state. Key repeat is
inferred until keyup and cleared on blur. Only Space/R keyboard mapping is
exercised by this fixture. Events are Deno `Event` objects with read-only additional fields, not
complete `MouseEvent` or `KeyboardEvent` implementations. Trusted activation,
modifier transport, focus navigation, IME, touch, wheel, pointer capture, scrolling
and accessibility behavior are not established. Synthetic events retain their
ordinary untrusted status.

Frame, resize and input callbacks are synchronous. Animation callbacks run with
the production microtask checkpoints; callback failures are reported through the
host rather than converted into successful frames. This source addition alone
does not verify native presentation, browser parity, input hit testing or GPU
lifecycle behavior; those require separate integration evidence.
