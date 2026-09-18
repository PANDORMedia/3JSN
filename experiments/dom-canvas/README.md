# DOM canvas on a native GPU

**Research result: partial.** The browser/native canvas contract matches, and a
real DOM canvas paints Three.js among HTML elements. Two upstream HTML paint
failures remain reproducible. The executable exits nonzero after saving them;
this is not an adopted shipping DOM or compositor.

[Recorded hardware evidence](../../docs/validation/2026-09-18-dom-canvas.md) includes
13 captures, both failures, diagnostic controls and failure cleanup. This workspace
is isolated from the shipping runtime and uses a small pinned Deno patch.

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

`run.mjs` runs with Metal API Validation, compares all 27 shared assertions to the
committed Chrome reference, verifies the two expected HTML failures, injects an
error after two submitted frames, and records source/binary/dependency identities.
It prints **PARTIAL** and exits zero only when this known-failure investigation
is reproduced exactly. The underlying executable exits one for the unresolved
paint gates. An unexpected pass must update the investigation and its assertions.
Neither result is a general compatibility certification.

## Ownership and cost

| Module | Responsibility |
| --- | --- |
| `src/canvas.js`, `src/dom_bridge.rs` | DOM canvas identity, bitmap dimensions and genuine Deno GPUCanvasContext objects |
| `src/canvas_texture.rs` | Checked native Metal retain, GPU snapshot and straight-alpha conversion |
| `src/painter.rs` | Canvas widgets inside Blitz's normal paint traversal; Vello texture registration |
| `src/scenario.rs`, `src/evidence.rs` | Lifecycle scenarios, assertions and capture-only readbacks |
| `src/main.rs` | Owners, terminal cleanup and evidence status |

The probe reuses the earlier realm bootstrap, DOM wrappers and Metal bridge.
Those remain research adapters, not a public API. The DOM is authoritative; the
JS wrapper does not shadow its layout or attributes. CSS size and GPU bitmap size
are separate. A persistent host snapshot survives expiry of the JS texture and
DOM removal. Reattachment reconnects the paint widget to that snapshot.

Deno and Vello have separate wgpu registries but retain the exact same native
Metal device and queue. Resource IDs never cross registries. The source texture
is independently retained through submitted copy work; host COPY_SRC permission
does not alter JS usage validation. Every updated canvas performs a native GPU
snapshot copy, an alpha-conversion dispatch, and Vello's atlas copy. There is no
CPU pixel transport between renderers. Readbacks exist only for assertions.
Both registries are flushed/drained before snapshots or atlas registrations retire,
including on error; persistent V8 context roots are cleared before isolate disposal.

## Adoption gates

- Fix and regress the lost ancestor clip and stale stacking-context paint list
  described in the evidence. CSS changes are diagnostic controls, not game fixes.
- Replace the unsafe trusted-full-clear export condition with a generic initialized
  texture handoff. Deno's initialization tracker is private; arbitrary canvas
  contents cannot yet be safely exported through this adapter.
- Upstream or sustain the small Deno extension with explicit upgrade checks.
  `getConfiguration()` copying, full validation, color spaces and tone mapping
  still have upstream gaps. Generic frame/event-loop expiry is not implemented.
- Complete DOM/IDL behavior and reclamation: wrappers and contexts remain strongly
  retained for this bounded process. `release()` is terminal, not canvas GC.
- Validate multiple painted canvases, intrinsic dimensions, borders/padding,
  transforms, DPI, device loss, native input/presentation and other backends.

The shared scene source is unchanged. Its fixture bootstrap deliberately uses
Three.js WebGPURenderer; this does not establish unchanged WebGL game support.
