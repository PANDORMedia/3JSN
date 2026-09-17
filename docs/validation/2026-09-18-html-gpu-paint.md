# Same-realm dynamic HTML paint — 2026-09-18

**Passed a bounded offscreen Metal paint experiment on Apple M1 Pro.** One V8
realm mutated one Blitz Rust DOM; that exact document's style/layout/text output
was rasterized through Blitz's maintained AnyRender/Vello path. The original
dynamic DOM fixture ran unchanged. No browser, Boa realm, duplicate DOM or
upstream patch was used.

This advances [issue #22](https://github.com/PANDORMedia/3JSN/issues/22) and the
CSS/layout/font/paint work in [issue #24](https://github.com/PANDORMedia/3JSN/issues/24).
It does not close their conformance gates or the GPU compositor work in
[issue #26](https://github.com/PANDORMedia/3JSN/issues/26).
The renderer uses its own native GPU device and has no game
canvas. The probe's DOM wrappers remain the deliberately partial earlier adapter.

## Executed evidence

[Source and reproduction](../../experiments/html-paint/README.md) ·
[Recorded report](2026-09-18-html-gpu-paint.json)

| Observation | Actual result |
| --- | --- |
| Original DOM fixture | Identity, mutation, detached-node retention, class-list identity, input prototype, synchronous widths `120 → 240`, capture/target/bubble order pass |
| Geometry reaches GPU paint | Pixel `(200,130)` changes from white to the red root background after expansion |
| Text reaches GPU paint | `Detached` encodes 8 glyphs and paints 405 near-white glyph pixels at 1× |
| JS color mutation reaches paint | Root sample changes from RGBA `[200,40,60,255]` to `[32,160,96,255]` |
| Isolated text removal | 798 pixels change; glyph count and white text pixels fall to zero |
| Text restoration | Full RGBA output exactly matches the prior `Native UI` image |
| Scale change | 384×192 becomes 768×384; root remains 240 CSS pixels wide; white glyph pixels increase from 331 to 1,924 |
| GPU execution | Metal, Apple M1 Pro, Vello `use_cpu=false`; wgpu validation enabled; Metal API Validation diagnostic observed; no captured validation errors |

![After the unchanged DOM fixture](2026-09-18-html-gpu-paint/after-original.png)

![After JavaScript color/text mutation at 2× scale](2026-09-18-html-gpu-paint/scaled-2x.png)

The font is the pinned Blitz example's DejaVu Sans WOFF2 input, SHA-256
`a75044e4dab293c1ac7f8eba9f20df03f183f41b9319054f43b955959981632a`.
Its decoded name table identifies DejaVu Sans 2.37 and includes the Bitstream
2003/Tavmjong Bah 2006 notices and license permission text. The
[official license](https://dejavu-fonts.github.io/License.html) was also checked;
the font file remains in the ignored cache, with only rendered PNGs published.
`blitz_dom::build_single_font_ctx` registers it with system-font discovery
disabled. The report retains source/font hashes, logical rectangles, per-frame
glyph counts, samples and complete RGBA hashes. The original fixture's unsupported
canvas, Worker, WebSocket, AudioContext and MutationObserver observations remain
in the report; a passed paint probe does not implement them.

Readbacks are solely for assertions and PNG evidence. DOM mutation, layout and
scene encoding run on the host thread; Vello rasterizes to an offscreen GPU
texture. This is a sequence of manually captured states, not a display loop or a
performance measurement. The images were visually inspected as well as checked
programmatically.

## Public API path

The pinned Blitz revision is `9d92719b37c801b8b41c81b799a2a474db8b3936`.
The experiment follows its own
[paint benchmark](https://github.com/DioxusLabs/blitz/blob/9d92719b37c801b8b41c81b799a2a474db8b3936/examples/paint_bench.rs):

1. The reused V8 adapter mutates `BaseDocument` through public `DocumentMutator`
   methods. Rust does not substitute the fixture's DOM mutations.
2. `BaseDocument::set_viewport` and `resolve` update the style/layout state.
3. [`blitz_paint::paint_scene`](https://github.com/DioxusLabs/blitz/blob/9d92719b37c801b8b41c81b799a2a474db8b3936/packages/blitz-paint/src/lib.rs)
   emits painting operations into `VelloScenePainter::new(&mut vello::Scene)`.
4. `vello::Renderer::new` accepts the host-created wgpu device;
   `render_to_texture` accepts its queue, scene and `Rgba8Unorm` storage texture.
5. After GPU completion, a mapped assertion buffer provides RGBA bytes. Each
   buffer is unmapped/destroyed and each output texture destroyed after capture.

No Blitz shell or window event loop is needed for this path. This is useful for
keeping DOM/layout/painting separate from 3JSN's platform host. It does not by
itself solve custom-widget texture registration or the game GPU's ownership.

## Concrete remaining blockers and limits

**Version alignment.** The initial manifest with wgpu 29.0.1 failed dependency
resolution: [Vello 0.10.0](https://docs.rs/crate/vello/0.10.0/source/Cargo.toml)
requires the high-level wrapper `wgpu ^29.0.3`. The recorded experiment uses
wgpu/core/types 29.0.4, matching the pinned Blitz workspace's resolved GPU
generation. The runtime uses core/types 29.0.1; the earlier interop probe also
pinned its high-level wrapper to 29.0.1.

A follow-up checked the published manifests and isolated Cargo resolution:

- [`deno_webgpu` 0.226.0](https://docs.rs/crate/deno_webgpu/0.226.0/source/Cargo.toml)
  requires core and types **exactly** `=29.0.1`. Forcing core/types 29.0.4 fails
  resolution; this cannot be fixed by an ordinary lockfile update.
- [`wgpu` 29.0.4](https://docs.rs/crate/wgpu/29.0.4/source/Cargo.toml) accepts core
  and types `^29.0.1`. Consequently Deno 0.226.0 + Vello 0.10.0 + wrapper 29.0.4
  **resolve together** to one core 29.0.1, one types 29.0.1 and hal 29.0.4, without
  any dependency patch. This is resolution evidence only: that mixed graph has
  not been compiled or GPU-validated by this probe. The recorded paint versions
  and images above remain unchanged.

**Registry ownership.** Version alignment does not wrap Deno's existing device.
The public `wgpu::Instance::from_core` accepts a low-level
`wgpu_core::instance::Instance` and constructs a new `Global`; it does not accept
Deno's existing `Arc<Global>`. There is no public native-wrapper constructor from
that global plus `DeviceId`/`QueueId`. The feature-gated `from_custom` constructors
are extension points for implementing a backend, not a supplied Deno/core adapter.
Both existing wrapper implementations remove device/queue IDs on drop, so any
shared wrapper API also needs explicit lifetime, error and submission ownership.
A common tested registry/device integration or an explicit native texture
boundary remains required. No unsafe handle conversion or upstream patch was
introduced here.

**Offscreen custom-resource API.** In
[`anyrender_vello` 0.14.0](https://docs.rs/crate/anyrender_vello/0.14.0/source/src/scene.rs),
the public `VelloScenePainter::new` sets its renderer, device handle and texture
registry fields to `None`. The fields are crate-private. Consequently that
constructor's `try_register_custom_resource` returns `Unimplemented`, and
`renderer_specific_context` yields no device. The image renderer builds a
resource-aware painter internally but creates its own device and returns CPU
image bytes. The window renderer has the richer device/resource path. A public
constructor for a resource-aware painter using an explicit device, or a carefully
chosen maintained renderer integration, is a concrete next API question. This
probe does not claim game-canvas composition.

**CSS filter gap.** The same adapter's `push_layer` ignores both `_filter` and
`_backdrop_filter`. Backgrounds and text passing is insufficient evidence for
CSS filter parity. Transforms, clipping, alpha/color-space contracts, SVG,
multiple canvases and stacking with game textures remain separate fixtures.

**Font and lifecycle scope.** One bundled-input font and Latin text are tested.
Font fallback/loading failures, emoji, complex scripts, editing/selection, IME,
accessibility, node churn, device loss and sustained rendering are unverified.
No font file or private acceptance-game content is published with this evidence.
The existing adapter retains wrappers/detached nodes until document destruction;
this experiment does not change that lifetime policy.

Issues #22, #24 and #26 remain open. The next integrated proof must use an unchanged
game canvas and this DOM in one realm, compose through the intended shared native
GPU boundary without frame readback, and exercise resource removal/recreation.
