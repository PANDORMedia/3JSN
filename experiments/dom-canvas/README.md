# DOM canvas on a native GPU

**Research result: partial.** The browser/native canvas contract matches, and a
real DOM canvas paints Three.js among HTML elements. Stacking-context demotion is
fixed by a pinned one-line patch; ancestor clipping still fails. The executable exits nonzero after saving that result;
this is not an adopted shipping DOM or compositor.

The [overflow comparison](OVERFLOW.md) now separates stale paint positions,
missing clips and containing-block layout errors in 22 browser/native cases.
Its prototype patch is deliberately excluded from normal preparation.
The [positioned-layout candidate](POSITIONED.md) evaluates maintained upstream
ownership APIs separately. Its [latest evidence](../../docs/validation/2026-09-18-paint-order.md)
records viewport, grid and equal-z ordering repairs, with remaining adoption gates.
The [geometry fixture](../../fixtures/dom-geometry/README.md)
verifies the maintained no-box query repair against Chrome.

[Current hardware evidence](../../docs/validation/2026-09-18-canvas-handoff.md) includes
21 captures, 576,000 initialization pixel checks, repeated stacking transitions
and failure cleanup. The [original failure evidence](../../docs/validation/2026-09-18-dom-canvas.md)
is retained. This workspace is isolated from the shipping runtime.

## Run

On macOS with Metal, after `npm ci`, use the repository's existing Cargo cache.
The pinned font is the DejaVuSans.woff2 input documented in the
[HTML paint experiment](../html-paint/README.md); it is not redistributed here.

```sh
export CARGO_HOME="$PWD/.cache/cargo"
export CARGO_TARGET_DIR="$PWD/target"
# Fetch unmodified upstream Deno sources if this cache is new.
cargo fetch --locked --manifest-path experiments/native-html-interop/Cargo.toml
node experiments/dom-canvas/prepare.mjs
cargo build --locked --manifest-path experiments/dom-canvas/Cargo.toml
node experiments/dom-canvas/bundle.mjs
node experiments/dom-canvas/run.mjs /absolute/path/to/DejaVuSans.woff2
```

`prepare.mjs` copies cached `deno_webgpu 0.226.0` into the ignored local cache,
checks exact source and patched hashes, and applies the committed patch. It does
not modify Cargo's registry. `prepare.mjs --check` verifies the copy without
changing it. The patch introduces a metadata-only offscreen canvas, explicit
texture expiry and bounded configuration/error fixes. The upstream CPU-image
canvas and native surface paths retain their previous behavior.
The same preparation step archives the pinned Blitz commit into an ignored copy,
applies the stacking-list, no-box geometry and checked layer-budget fixes, and
verifies all 414 tracked files plus the added checked-scene module. Extra files
and symlinks are rejected. The
related workspace crates are patched together so their public types share one
source identity. No Cargo registry or original Git checkout is edited.

Painting uses `paint_scene(..., PaintLimits) -> Result<PaintStats, PaintError>`.
The default permits 1,024 total clip/effect layers and 1,024 open layers. All
producers and subdocuments share that budget. A rejected layer suppresses later
drawing and balances accepted layers; the host discards its fresh scene before
GPU submission. Widget resource side effects still use the existing cleanup
path. Scene fragments must be self-balanced; checks cover the combined stream.
The [budget fixture](../../fixtures/paint-budget/README.md) compares rejection
with successful rendering under an explicitly raised limit.

`run.mjs` runs with Metal API Validation, compares all 27 shared assertions to the
committed Chrome reference, verifies the remaining clip failure and repaired
stacking behavior, checks canvas initialization, injects an
error after two submitted frames, and records source/binary/dependency identities.
It prints **PARTIAL** and exits zero only when this known-failure investigation
is reproduced exactly. The underlying executable exits one for the unresolved
paint gates. An unexpected pass must update the investigation and its assertions.
Neither result is a general compatibility certification.

## Ownership and cost

| Module | Responsibility |
| --- | --- |
| `src/canvas.js`, `src/dom_bridge.rs` | DOM canvas identity, bitmap dimensions and genuine Deno GPUCanvasContext objects |
| `src/canvas_init.rs`, `src/canvas_texture.rs` | Producer-registry initialization, checked Metal retain, GPU snapshot and alpha conversion |
| `src/painter.rs` | Canvas widgets inside Blitz's normal paint traversal; Vello texture registration |
| `src/scenario.rs`, `src/initialization_tests.rs`, `src/evidence.rs` | Lifecycle/initialization assertions and capture-only readbacks |
| `src/main.rs` | Owners, terminal cleanup and evidence status |

The probe reuses the earlier realm bootstrap, DOM wrappers and Metal bridge.
Those remain research adapters, not a public API. The DOM is authoritative; the
JS wrapper does not shadow its layout or attributes. CSS size and GPU bitmap size
are separate. A persistent host snapshot survives expiry of the JS texture and
DOM removal. Reattachment reconnects the paint widget to that snapshot.

Deno and Vello have separate wgpu registries but retain the exact same native
Metal device and queue. Resource IDs never cross registries. The source texture
is independently retained through submitted copy work; host COPY_SRC permission
does not alter JS usage validation. Before export, a load/store pass in Deno's
original registry initializes missing or discarded pixels while preserving existing
contents. This supports ordinary Deno-created render-attachment canvases, without
requiring an application full clear. Every updated canvas performs that pass, a native GPU
snapshot copy, an alpha-conversion dispatch, and Vello's atlas copy. There is no
CPU pixel transport between renderers. Readbacks exist only for assertions.
Both registries are flushed/drained before snapshots or atlas registrations retire,
including on error; persistent V8 context roots are cleared before isolate disposal.

## Adoption gates

- Fix and regress the lost ancestor clip, including positioned descendants that
  legitimately escape intermediate clips. CSS controls are not game fixes.
- Extend initialized handoff to other configured usages without exposing private
  tracker state or silently widening JS permissions. HAL-imported producer textures
  are outside the current contract; measure initialization-pass overhead.
- Upstream or sustain the small Deno extension with explicit upgrade checks.
  Do the same for the one-line Blitz fix; repeated-transition regressions must stay.
  `getConfiguration()` copying, full validation, color spaces and tone mapping
  still have upstream gaps. Generic frame/event-loop expiry is not implemented.
- Complete DOM/IDL behavior and reclamation: wrappers and contexts remain strongly
  retained for this bounded process. `release()` is terminal, not canvas GC.
- Validate multiple painted canvases, intrinsic dimensions, borders/padding,
  transforms, DPI, device loss, native input/presentation and other backends.

The shared scene source is unchanged. Its fixture bootstrap deliberately uses
Three.js WebGPURenderer; this does not establish unchanged WebGL game support.
