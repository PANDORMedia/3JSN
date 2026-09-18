# Three.js and live HTML on one native Metal queue

This experiment connects the shared Three.js scene, Deno WebGPU and the Blitz
DOM/Vello painter in one V8 realm. Its purpose is to validate a GPU-only texture
boundary and explicit ownership before adopting a compositor architecture.
It is outside the shipping Cargo workspace and is not a supported game runtime.

The [recorded Metal validation](../../docs/validation/2026-09-18-native-html-interop.md)
passes 32 frames, four generations, pixel/event assertions and an injected
after-submit failure with confirmed cleanup.

## Boundaries

| Module | Responsibility |
| --- | --- |
| `app.mjs` | Three.js fixture host, WebGPU composition and final assertion readback |
| `src/host.rs` | V8/bootstrap integration and ownership of imported JS texture objects |
| `src/dom_bridge.rs`, `src/bindings.js` | Existing authoritative Rust DOM and bounded JS wrappers using Deno events |
| `src/painter.rs` | Layout, Vello scene encoding, rasterization and producer diagnostics |
| `src/metal.rs` | Checked native device/queue identity, native texture retention and import |
| `src/evidence.rs` | Independent pixel assertions and PNG output |
| `src/main.rs` | Bounded test sequence and teardown |
| `events.js` | DOM event regression assertions, including exception cleanup |

The shipping runtime's `web-globals.js` supplies the same Event/EventTarget and
WebGPU classes. The DOM adapter extends those classes instead of installing a
second event implementation. The original DOM fixture and shared Three.js scene
sources remain unchanged. The fixture still supplies a minimal offscreen canvas
and manual frame timestamps; it does not run an arbitrary unchanged web project.

## GPU contract

Deno and Vello use separate wgpu-core registries because the high-level wrapper
has no public constructor from Deno's existing `Arc<Global>` and resource IDs.
The Metal adapter retains Deno's native device and command queue, opens an adapter
with matching native identity and installs that exact queue into Vello's wrapper.
It checks both identities after registration. IDs never cross registries.

Vello owns an RGBA8 UI texture. Its initialized native Metal object is retained and
imported into Deno's registry with matching dimensions, format, usages, sample/mip
counts and tracked hazards. One Deno `GPUTexture` owns the imported ID; the producer
owns its independent retain. Registry validation does not track the other alias.
The host must therefore serialize both producers and consumers deliberately.

Each frame submits Three.js work, flushes Deno's pending queue writes, submits
Vello paint, and then submits the Deno composition pass on the same native queue.
No unsubmitted encoder crosses those phases. Initialization is completed before
the unsafe import. Batches are bounded, with final assertion readbacks providing
GPU completion before resource destruction. This is not a frame-pacing benchmark.
Both registries are drained on errors while texture aliases are still alive.
If completion cannot be established, the process fails and retains the producer
until exit; it never reports that path as orderly cleanup.

Vello 0.10's final raster shader writes **straight alpha**. The compositor uses
`ui.rgb * ui.a + game.rgb * (1 - ui.a)` over the opaque game. The diagnostic image
contains three GPU-written planes: composite, game, UI. CPU assertions independently
check source-over for every pixel, transparent background, text, CSS color mutation
and changing Three.js geometry. This does not establish browser color-space/HDR
parity. There is no CPU pixel transport between rendering and composition.

## Reproduce

On a Metal-capable Mac with Rust 1.93+, Node 24+ and a native compiler:

```sh
npm ci
node experiments/native-html-interop/bundle.mjs
CARGO_BUILD_JOBS=2 cargo build --locked \
  --manifest-path experiments/native-html-interop/Cargo.toml
node experiments/native-html-interop/run.mjs .cache/html-paint-probe/DejaVuSans.woff2
```

Prepare the pinned font following the [HTML paint instructions](../html-paint/README.md).
The executable checks its SHA-256 and disables system-font discovery. No font or
private acceptance-game source is published. Optional `CARGO_HOME` and
`CARGO_TARGET_DIR` overrides must also be present when running the verification
script; it discovers the executable through Cargo metadata.

The runner sets Metal API Validation, requires its diagnostic, imposes a
120-second process deadline and records actual resolved crate versions and input
hashes. It writes captures, logs, a raw report and `verification.json` under ignored
`artifacts/native-html-interop/output`. The experiment uses checkout/Cargo source
files at startup; it makes no standalone executable packaging claim.
The runner also starts a separate process with failure injected after two
submitted frames and requires the expected error plus an explicit cleanup result.

## Remaining gates

- Offscreen Metal only; native presentation, other APIs/platforms, sustained
  rendering, frame pacing and device-loss recovery remain separate tests.
- The shared DOM adapter now includes bounded focus and Document-to-Window
  propagation; see the [focus checkpoint](../../docs/validation/2026-09-18-dom-focus.md)
  for bounded CPU/browser and native-window evidence. Shadow DOM, `on*`
  handlers, general default activation, IME and accessibility remain open.
- Deno 0.290 skips ancestor propagation without a target listener. A temporary
  inert listener adapts `Node.dispatchEvent`, with cleanup in `finally`. Borrowing
  `EventTarget.prototype.dispatchEvent` directly bypasses that adapter.
- Detached wrappers/nodes remain until runtime teardown, and Deno retains empty
  listener arrays per type. Cleanup tests do not prove bounded memory under
  arbitrary node/event-type churn.
- Fonts, filters, clipping, transforms, multiple canvases and arbitrary DOM
  stacking need compatibility fixtures. The AnyRender backend's ignored CSS
  filter arguments are still unsupported.
- WebGL/ANGLE integration and the required browser services remain separate work.
  This does not certify CtF, general Three.js projects or the `3jsn build` workflow.

Track [compositor #26](https://github.com/PANDORMedia/3JSN/issues/26),
[HTML architecture #22](https://github.com/PANDORMedia/3JSN/issues/22) and
[paint #24](https://github.com/PANDORMedia/3JSN/issues/24). They remain open.
