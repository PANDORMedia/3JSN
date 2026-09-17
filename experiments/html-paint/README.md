# V8 → Blitz → native GPU paint probe

This isolated experiment paints the Rust DOM mutated by the existing V8 adapter.
The original [dynamic DOM fixture](../../docs/investigations/html-dom/fixture.js)
runs unchanged. Its document is then painted by `blitz-paint`, AnyRender's Vello
scene adapter and Vello's native wgpu renderer. No browser, Boa realm, second DOM
or upstream patch is involved.

The macOS Metal run passed the declared assertions. See the
[validation and remaining gates](../../docs/validation/2026-09-18-html-gpu-paint.md).
This is not an adopted backend or a general HTML/CSS compatibility claim.

## Reproduce

Use macOS with a Metal GPU, Rust 1.93+, a native compiler and the full repository.
The independent manifest/lockfile does not modify the root Cargo workspace.
Fetch the font used by the pinned upstream Blitz example into the ignored cache:

```sh
mkdir -p .cache/html-paint-probe
curl -fL \
  https://raw.githubusercontent.com/DioxusLabs/blitz/9d92719b37c801b8b41c81b799a2a474db8b3936/examples/wasm_hello/assets/DejaVuSans.woff2 \
  -o .cache/html-paint-probe/DejaVuSans.woff2

CARGO_BUILD_JOBS=2 MTL_DEBUG_LAYER=1 cargo run --locked \
  --manifest-path experiments/html-paint/Cargo.toml -- \
  .cache/html-paint-probe/DejaVuSans.woff2 \
  .cache/html-paint-probe/output
```

Optional `CARGO_HOME`/`CARGO_TARGET_DIR` settings can reuse repository caches. The
font bytes are supplied explicitly; system-font discovery is disabled. The font
is not copied into the public experiment. The actual font's name table identifies
DejaVu Sans 2.37, Bitstream/Tavmjong Bah copyright notices and the embedded license.
These were checked against the [official DejaVu license](https://dejavu-fonts.github.io/License.html),
including its notice requirements for distributing font files. Only rendered PNG
evidence is published here.

The executable fails on missing original DOM observations, wrong geometry/color
pixels, absent text, mismatched restored pixels or GPU validation errors. It
writes six PNG captures and `report.json`. Buffer mapping uses bounded waits;
shader compilation and initial Cargo compilation are not benchmarked. Captures
are assertion readbacks, not a proposed display transport.

## What is connected

`src/dom_bridge.rs` includes the previous experiment's adapter source so its DOM
behavior is not forked. It replaces that adapter's bootstrap file declaration
with compiled JavaScript bytes. The original fixture and additional paint
mutations execute in the same V8 realm. Rust borrows the same `BaseDocument` only
after JavaScript returns, resolves layout, and emits a Vello scene. The document
borrow ends before GPU rendering/readback.

The capture sequence checks:

1. Initial 120 CSS-pixel root with text.
2. Unchanged original fixture: root expands to 240 pixels and reads `Detached`.
3. Additional JavaScript mutation: green background and `Native UI` text.
4. Text removal: glyph commands and white glyph pixels disappear.
5. Text restoration: complete RGBA output matches stage 3 exactly.
6. 2× scale: the logical box stays 240 pixels wide and the GPU image doubles in
   both dimensions.

## Scope limits

The probe has one independent wgpu 29.0.4 device. It neither imports a Three.js or
ANGLE canvas nor shares the current runtime's wgpu-core 29.0.1 registry. Vello
0.10.0 requires the high-level wgpu wrapper `^29.0.3`. An isolated Cargo resolution
succeeded with wrapper 29.0.4, core/types 29.0.1 and hal 29.0.4 alongside the current
Deno binding, without a patch. A [follow-up variant](../html-paint-mixed-probe/README.md)
then compiled and rendered that graph on Metal, producing six byte-identical
captures. The original recorded paint run used core/types 29.0.4. Deno's core/types
requirements are exact, so moving those to 29.0.4 is not a lockfile-only update.
Matching versions also does not supply a public wrapper constructor for Deno's
existing `Arc<Global>` and device/queue identifiers.
`VelloScenePainter::new` also lacks the resource/device context used by custom
widgets. These are separate composition gates.

No window, native input, real frame scheduling, complete DOM bindings, complex
text/font fallback, IME, accessibility, CSS conformance or performance comparison
is established. The selected AnyRender backend currently ignores the filter and
backdrop-filter arguments in `push_layer`; those effects must not be assumed to
work because basic text and backgrounds paint correctly.
