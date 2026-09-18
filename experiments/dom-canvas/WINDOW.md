# Native HTML + Three.js window

This Metal-only experiment presents the [Orbit Study fixture](../../examples/dom-window/README.md)
using the same HTML and bundled JavaScript as its browser reference. It combines
the existing DOM canvas adapter, Blitz layout/text, Vello paint and the checked
Metal device/queue bridge. It does not change the current CLI compatibility profile.

From the repository root, after `npm ci` and the [DOM canvas preparation](README.md):

```sh
export CARGO_HOME="$PWD/.cache/cargo"
export CARGO_TARGET_DIR="$PWD/target"
node experiments/dom-canvas/prepare.mjs --check
mkdir -p artifacts/dom-window
cp examples/dom-window/index.html artifacts/dom-window/index.html
npx --no-install esbuild examples/dom-window/app.mjs --bundle --platform=browser --format=esm --sourcemap --outfile=artifacts/dom-window/app.bundle.mjs
cargo build --offline --locked -j2 --manifest-path experiments/dom-canvas/Cargo.toml --bin threejs-dom-window-probe
MTL_DEBUG_LAYER=1 target/debug/threejs-dom-window-probe \
  .cache/dom-canvas/blitz/examples/wasm_hello/assets/DejaVuSans.woff2 \
  examples/dom-window/index.html artifacts/dom-window/app.bundle.mjs
```

Append `120` to stop after 120 presented frames. A bounded run has a 90-second
host deadline and rejects early closure. The font remains an explicit local
input from the pinned upstream source; this command does not distribute it.
The executable needs access to the macOS window server and Metal hardware.
This debug build is a correctness demo, not a performance result.

Click Pause or use Space; R resets the animation. Resizing updates the document's
CSS viewport, the canvas drawing buffer and the native surface. To compare the
same build in a browser, serve `artifacts/dom-window` over localhost. Native
startup receives the HTML and bundled module as separate arguments; it does not
discover or execute arbitrary HTML script tags or fetch application assets.

## Ownership and frame flow

The OS thread creates the window, wrapper wgpu instance and its safe surface.
A dedicated worker owns V8 and the authoritative DOM. The application configures
the real `#scene` canvas using standard APIs; the host discovers its actual
GPUDevice through that canvas rather than requiring an application global.
Three.js may configure the canvas during its first animation callback.

The existing Metal bridge matches that device to the surface instance's adapter
and retains Deno's exact native command queue. One worker serializes submissions
to the two resource registries. Their resource IDs and initialization tracking
remain separate. Each changed canvas goes through initialized GPU snapshot,
alpha conversion and Vello atlas registration. Vello paints HTML and the canvas
into RGBA8 storage, then wgpu's maintained `TextureBlitter` writes the opaque
BGRA/RGBA native surface. There is no CPU pixel transport and no zero-copy claim.

A canvas with no new current texture keeps its previous registered image.
Canvas dimensions or format changes drain and retire its old registration;
surface size changes similarly drain before reconfiguration. Per-frame draining
is avoided. Expiry happens after snapshot submission, while the host image
survives the JavaScript texture. The compositor uses the existing default DOM
renderer; the separate positioned/ownership candidate is not adopted here.

Viewport/redraw/presentation state is coalesced, with at most one prepared surface
image awaiting the main thread's `pre_present_notify` acknowledgement. Timeout
and occlusion retry that composed frame without replaying its animation callbacks.
Outdated surfaces reconfigure; lost surfaces fail explicitly because surface
recreation is not implemented. Hidden/zero-sized windows skip painting. Async
work is polled on an 8 ms worker timer; redraw scheduling is experimental and
does not establish optimized frame pacing or demand-driven idle behavior.

Input uses a bounded 128-record FIFO, dispatching at most 64 records per worker
turn. Overflow fails explicitly. Hit testing resolves the DOM and releases its
borrow before invoking JavaScript, so handlers can mutate that same document.
Only a matching primary-button press/release target produces a click. Cursor
exit, resize and blur clear pending pointer activation. See the fixture's
[input limits](../../examples/dom-window/README.md).

Close interrupts executing JavaScript and cancels asynchronous module startup.
The worker drops any acquired image, drains both GPU registries, unregisters
canvas storage, releases persistent JS handles and disposes V8. The OS thread
retains the window until the worker joins. Failed GPU drain is a reported fatal
error; that failed generation is retained until process exit instead of claiming
safe resource release. This teardown does not dispatch `pagehide` or verify
application `renderer.dispose()` handlers.

## Verified scope

Read the [hardware checkpoint](../../docs/validation/2026-09-18-dom-window.md).
This is one opaque canvas, a simple HTML page and bounded keyboard/mouse behavior
on one Mac. It does not certify WebGL, CtF, arbitrary project loading, multiple
canvases, asset APIs, CSS animations, color management, transparent presentation,
clip-aware input, focus/forms/IME, accessibility, scrolling, physical monitor/DPR
changes, device-loss recovery, other platforms or performance. The existing
ancestor-clipping and broader HTML compatibility gates remain open.
