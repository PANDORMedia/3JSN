# Native DOM window checkpoint

A native macOS window now combines ordinary HTML text/button updates and an
upstream Three.js WebGPU canvas through the existing Metal compositor. The
fixture has no `probe` or `nativeWindow` game API. Its HTML and generated bundle
are also the browser reference, with no host-specific application rewrite.

This is an experimental integration checkpoint on one Mac, not unchanged-project
or cross-platform compatibility certification. [Run instructions and ownership](../../experiments/dom-canvas/WINDOW.md)
describe the explicit HTML/module/font inputs and remaining architecture limits.

## Executed checks

| Check | Observed result |
| --- | --- |
| Bounded native run with Metal API validation | 120 presentations and 120 canvas snapshots; exit 0 |
| One canvas draw followed by 20 native presentations | One snapshot retained across all presentations; exit 0 |
| Deliberate exception on the eighth animation callback | Exit 1 with the application file/line and animation callback stack |
| Browser reference | Scene visible, Pause changes status/button, no captured console errors |
| Native UI | Scene and HTML visible; Pause/Space toggle; resizing changes the canvas from 904×440 to 784×360 CSS pixels at DPR2 |
| Cross-target mouse release | Dragging from canvas onto Pause leaves the scene running |
| Native close | Window closes after 9,877 presentations and reports 9,878 canvas snapshots after resource teardown |

The [receipts](2026-09-18-dom-window/receipt.json) pin binary, source, font, bundle,
lockfile and archived log identities. [Native frame log](2026-09-18-dom-window/native-120.txt),
[retention log](2026-09-18-dom-window/retained-canvas.txt) and
[error log](2026-09-18-dom-window/frame-error.txt) preserve the executed results.
UI checks were observed through native/browser UI automation and screenshots in
the task; no screenshot file or pixel-equivalence claim is archived. The font
and browser text rasterization differ. Counts alone do not prove visual parity.

The scoped window Clippy check passes with warnings denied for the target. The
dependency still emits its existing `Intrinsic` dead-code warning. Repository
Node tests pass 79/79, including nine bootstrap protocol checks. Those bootstrap
tests cover callback registration, RAF/microtask ordering, resize values, input
targeting, click pairing, pointer reset and error reporting; they are not browser
conformance tests. See the [test logs](2026-09-18-dom-window/node-tests.txt).
The default experiment's [11 CPU tests](2026-09-18-dom-window/rust-tests.txt)
also pass, covering geometry, stacking and layer budgets.
The separate [DPR repair](2026-09-18-dpr-cache.md) has 77 passing candidate CPU
tests; it is not part of the default renderer used by this window.

The fixture's source map retains its application source. The served HTML copy
is byte-identical to the native HTML input; both runs use the same bundle file.
The native executable embeds V8, Deno WebGPU, Blitz and Vello. Node/esbuild build
the module and are not its rendering host. Both GPU registries check their exact
native device/queue identity before sharing textures. The display path uses GPU
snapshot/alpha/atlas/blit stages and no CPU pixel transport.

## Remaining gates

The host currently expects one configured canvas named `scene` and a separately
supplied bundled module. It does not integrate this HTML entry into `3jsn build`,
load arbitrary page scripts/assets, run an unchanged WebGL game or certify CtF.
This build is unoptimized and the run is not a benchmark. Input events have a
bounded field/target contract; focus, IME, pointer capture, wheel, accessibility
and clipped/transformed hit parity are not implemented by this adapter.

Resize was observed on the same DPR2 display. Physical monitor-scale changes,
long-duration minimize/restore stress, device/surface-loss recovery and other
platforms remain unverified. Host-owned teardown is exercised; application
`pagehide`/renderer-disposal hooks are not invoked. The default renderer retains
the known ancestor-clipping gap; the broader ownership candidate remains separate.
