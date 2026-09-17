# HTML/DOM integration investigation

Research snapshot: 2026-09-17. Tracks [issue #22](https://github.com/PANDORMedia/3JSN/issues/22).
This is integration evidence and a recommendation, not a backend adoption or a
claim that 3JSN runs dynamic HTML. The [product contract](../product.md) remains
unchanged.

Follow-on evidence: the [V8-to-Blitz experiment](../../experiments/html-v8/README.md)
now exercises one Rust-owned DOM from V8, with no Boa or upstream patch. Seven
declared original observations and 15 additional event/mutation checks pass;
[its report](../validation/2026-09-17-html-v8.md) preserves the unsupported APIs
and remaining painting, input and collection gates. The initial findings below
describe the upstream Boa binding rather than this separate adapter.

## Finding that changes the earlier assessment

**Blitz now has JavaScript DOM bindings, but they are tied to Boa, not V8.** Its
README still says there are no language bindings. Source at
[`9d92719b37c801b8b41c81b799a2a474db8b3936`](https://github.com/DioxusLabs/blitz/tree/9d92719b37c801b8b41c81b799a2a474db8b3936)
contains `blitz-vibey-script`, a `ScriptDocument` implementation with live DOM
objects, events, ES module loading and timers. Use the source evidence below
instead of treating the README as a current capability inventory.

This improves component reuse substantially. It does **not** make Blitz a ready
Three.js runtime: canvas graphics bindings are absent from the inspected script
crate, scheduling contains an incompatible RAF approximation, and several DOM
interfaces have deliberately incomplete prototypes.

Recommendation: retain V8 as the **provisional game execution candidate** and
investigate an upstream-friendly V8 binding to Blitz's Rust DOM APIs. Use the Boa
implementation as a behavior comparison and integration reference. Do not embed
Boa for UI while executing the game in V8: that splits node identity, synchronous
calls, callbacks and object graphs across engines. Do not adopt either runtime
until the same dynamic fixture and a game canvas pass in one application realm.
This recommendation is based on source architecture and compatibility gaps;
there is no comparative execution-speed measurement yet.

## Inspected components

| Component | Exact source or version | What it can contribute | Boundary that remains |
| --- | --- | --- | --- |
| Blitz | Git `9d92719b`; workspace `0.3.0-beta.2` | HTML parsing, mutable DOM, Stylo styling, Taffy layout, Parley text, event/default-action plumbing | V8 bindings and target-profile conformance |
| Blitz script crate | Same Git revision; Boa `0.22` | Same-realm DOM wrappers and JS bindings; testable reference | Graphics, scheduling, memory lifetime and interface completeness |
| Blitz GPU example | Same Git revision; wgpu `29`, AnyRender, winit `0.31.0-beta.3` | GPU texture insertion among HTML layers | Sharing the actual JS GPU device; native WebGL interop |
| Deno core | Inspected downloaded crate `0.412.0` | V8 runtime, extension ops, event-loop polling | No browser DOM supplied by `deno_core` itself |
| Servo | Online API docs `0.6.0`; repository HEAD observed as `0f4d68e` | Integrated script/DOM/layout/browser semantics | Different engine choice and an OpenGL/GLES rendering boundary |
| Vello | Blitz's compatible AnyRender backend | GPU painting | No DOM, JS, HTML parser or layout |

The Blitz [workspace manifest](https://github.com/DioxusLabs/blitz/blob/9d92719b37c801b8b41c81b799a2a474db8b3936/Cargo.toml)
also pins Taffy Git `c17b313c`, Stylo `0.21.0`, and Parley `0.11.1`. This is a
moving beta combination. Rust type compatibility requires resolving one tested
wgpu/AnyRender stack; two different `wgpu::Texture` types cannot be passed through
a Rust downcast just because they represent the same native backend. The existing
3JSN diagnostic uses wgpu `28`, so direct adoption of this example is not a
zero-change dependency decision.

## Executed comparison

On macOS arm64 with Rust `1.93.0`, all **26 upstream DOM tests passed** at the
pinned revision. A separate original [fixture](html-dom/fixture.js) was then run
through `ScriptDocument` and Chrome `153.0.8010.48`. The captured
[observation report](html-dom/observation.json) preserves both outputs.

| Observable behavior | Chrome | Blitz Boa |
| --- | --- | --- |
| Node identity and expando preservation | Pass | Pass |
| `innerHTML`, selectors, class/text mutation | Pass | Pass |
| Width mutation followed by synchronous rectangle read | `120`, then `240` | `120`, then `240` |
| Detached node mutation and reinsertion preserve identity | Pass | Pass |
| JS `button.click()` dispatches capture/target/bubble | Expected order | Throws: method not callable |
| `element.classList === element.classList` | `true` | `false` |
| Input element `instanceof HTMLInputElement` | `true` | `false` |
| Canvas `getContext` member | Function | Undefined |
| Worker/WebSocket/AudioContext/MutationObserver constructors | Functions | Undefined |
| Two successive RAF callback timestamps | Increasing | `16`, `16` |

The native clock was advanced manually; headless Chrome used a virtual-time
budget. These results compare API behavior, not speed or real display pacing.
The observer catches individual failures to record them: its process exiting
successfully does **not** mean the fixture passed the compatibility profile.
No HTML paint, GPU composition, native pointer/IME or Servo execution is claimed.

To reproduce without adding Blitz to the 3JSN workspace, clone the pinned upstream
revision into a separate research checkout. Copy [probe.rs](html-dom/probe.rs) to
`packages/blitz-vibey-script/tests/threejsn_investigation.rs` and
[fixture.js](html-dom/fixture.js) to the same directory as `threejsn-fixture.js`.
Run these commands in that checkout with Rust `1.93.0`:

```sh
cargo test --locked -p blitz-vibey-script --test dom
cargo test --locked -p blitz-vibey-script --test threejsn_investigation -- --nocapture
```

Open [browser.html](html-dom/browser.html), keeping `fixture.js` alongside it, in
the comparison browser. Its two JSON outputs use the same JavaScript fixture;
the small host callback only collects observations. The preserved observations
are a research baseline, not a permanent allowlist of acceptable failures.

## Public APIs available for a V8 adapter

These are inspected APIs, not pseudocode names:

| Required operation | Blitz API and consequence |
| --- | --- |
| Parse an entry page | `HtmlDocument::from_html(html, DocumentConfig)`; `into_inner()` yields the `BaseDocument` |
| Mutate nodes | `BaseDocument::mutate()` returns `DocumentMutator`; use `create_element`, `append_children`, `set_attribute`, `set_node_text`, `set_inner_html`, `remove_node` |
| Preserve node handles | `NodeId` is a versioned 64-bit identifier, not a raw node address; `BaseDocument::get_node` returns `None` for invalid handles |
| Query elements | `get_element_by_id`, `query_selector`, `query_selector_all`, `matches_selector`, `closest` |
| Apply style and measure | Mutator `set_style_property`; document `resolve(animation_time)` then `get_client_bounding_rect`, `node_client_rects`, `resolved_style_value` |
| Route native input | `EventDriver::new(document, handler)`, `handle_ui_event`; implement `EventHandler::handle_event` to dispatch JS listeners and cancellation |
| Poll pending work | Implement `Document::poll`; explicit `inner`/`inner_mut` guards give access to the shared document |
| Attach a canvas painter | `set_custom_widget` plus `Widget::can_create_surfaces`, `paint`, `destroy_surfaces`; retain actual canvas element identity in bindings |

Sources: [document ownership and geometry](https://github.com/DioxusLabs/blitz/blob/9d92719b37c801b8b41c81b799a2a474db8b3936/packages/blitz-dom/src/document.rs),
[mutations](https://github.com/DioxusLabs/blitz/blob/9d92719b37c801b8b41c81b799a2a474db8b3936/packages/blitz-dom/src/mutator.rs),
[selector implementation](https://github.com/DioxusLabs/blitz/blob/9d92719b37c801b8b41c81b799a2a474db8b3936/packages/blitz-dom/src/query_selector.rs),
[versioned node IDs](https://github.com/DioxusLabs/blitz/blob/9d92719b37c801b8b41c81b799a2a474db8b3936/packages/blitz-traits/src/node_id.rs),
[event driver](https://github.com/DioxusLabs/blitz/blob/9d92719b37c801b8b41c81b799a2a474db8b3936/packages/blitz-dom/src/events/driver.rs).

A V8 implementation can store an `Rc<RefCell<BaseDocument>>` in the runtime's
`OpState` and expose a small synchronous operation surface through a Deno
extension. JS classes implement the public DOM API in that same realm; node
wrappers carry validated IDs, never Rust references. This is a proposed adapter,
not existing Blitz support. Deno's [`RuntimeOptions::extensions` and runtime
APIs](https://docs.rs/deno_core/0.412.0/deno_core/struct.JsRuntime.html) support that
embedding shape.

Start with a single authoritative DOM. Do not create a parallel JS DOM and try
to synchronize it with a Rust tree: synchronous geometry queries, mutation timing,
form default actions and event targets would require a second correctness model.
Maintain wrapper identity through a registry whose lifetime policy is tested.
Detached nodes must remain usable while JS still references them; unreachable
subtrees, listeners and GPU resources must eventually be reclaimed.

Do not hold a `RefCell` borrow, DOM mutation guard or Rust reference across a JS
callback. Event handlers can synchronously mutate or measure the document again.
The upstream event-driver pattern releases document guards around handler calls;
retain that separation. Flush mutation work before resolving layout. Pass the
host's animation timestamp to layout rather than an unrelated clock.

## What the existing JS adapter proves and does not prove

[`ScriptDocument`](https://github.com/DioxusLabs/blitz/blob/9d92719b37c801b8b41c81b799a2a474db8b3936/packages/blitz-vibey-script/src/document.rs)
provides `from_html`, `execute_scripts`, `eval`, `take_js_errors`,
`take_messages`, `with_fetcher`, `without_timer_thread`, `with_virtual_time`,
`next_timer_deadline` and `advance_clock_to`. It shares the Rust document with its
Boa realm using `Rc<RefCell<_>>`; a separate background timer thread only wakes
the host. Its default script fetcher supports file/data sources and can be
replaced. Fetching scripts/modules is synchronous at that boundary, which must
not stall the shipping OS event loop on network I/O.

There are concrete compatibility and maintenance gaps:

- The [RAF binding](https://github.com/DioxusLabs/blitz/blob/9d92719b37c801b8b41c81b799a2a474db8b3936/packages/blitz-vibey-script/src/runtime.rs#L2084)
  schedules a 16 ms timer and supplies the constant callback timestamp `16.0`.
  This cannot drive an unchanged Three.js animation loop correctly. It also
  cannot represent a 120 Hz display's presentation schedule.
- The same bootstrap gives all element types one prototype. Tag-specific
  constructor stubs intentionally fail `instanceof` checks, including
  `HTMLInputElement`. That is a semantic difference, not merely a missing name.
- A source search of the script crate found no canvas `getContext`, WebGL/WebGPU,
  Worker, WebSocket or Web Audio implementation. Host Rust capabilities are not
  equivalent to the JS interfaces game libraries call.
- The [wrapper registry](https://github.com/DioxusLabs/blitz/blob/9d92719b37c801b8b41c81b799a2a474db8b3936/packages/blitz-vibey-script/src/state.rs)
  retains strong Boa object handles. No registry eviction was found in the
  inspected script crate. Long-lived UI churn needs a detached-node/listener
  collection test; document teardown alone is not sufficient evidence.
- [Geometry bindings](https://github.com/DioxusLabs/blitz/blob/9d92719b37c801b8b41c81b799a2a474db8b3936/packages/blitz-vibey-script/src/dom/element.rs#L1273)
  call `resolve(0.0)` before measuring. This gives a real synchronous layout path,
  but interaction with CSS animation time and transformed coordinates requires
  browser-reference tests.

Boa describes itself as an experimental interpreter. Its MIT/Unlicense availability
and Rust implementation are useful, but neither proves it meets this project's
JS CPU throughput requirement. A runtime switch needs the actual Three.js scene
and UI workloads. [Boa primary source](https://github.com/boa-dev/boa)

## GPU composition and ownership

The [Blitz texture example](https://github.com/DioxusLabs/blitz/blob/9d92719b37c801b8b41c81b799a2a474db8b3936/examples/wgpu_texture/src/demo_renderer.rs)
obtains a `wgpu_context::DeviceHandle` from
`RenderContext::renderer_specific_context()`, creates textures with that device,
and registers a cloned texture using `try_register_custom_resource`. Paint uses
its `ResourceId` as an image brush. Resize unregisters obsolete textures; the
widget lifecycle releases surfaces. This is a concrete GPU composition seam.

It does **not** demonstrate importing textures from Deno's wgpu-core registry or
ANGLE. The source example uses a Rust renderer inserted into an `<object>`;
3JSN must preserve a real `<canvas>` and its `getContext` behavior. Three.js should
submit work before HTML composition samples its canvas texture. Define the queue
submission order and color/alpha contract, and retain texture resources until the
GPU consumer is finished.

The [widget API](https://github.com/DioxusLabs/blitz/blob/9d92719b37c801b8b41c81b799a2a474db8b3936/packages/blitz-dom/src/node/custom_widget.rs)
tracks registered resource IDs through a proxy render context, including pending
removal. Reuse this cleanup mechanism rather than inventing a global texture
registry. Device loss, DOM removal/reinsertion and changes in intrinsic canvas
size still need tests. No executable GPU-composition result is claimed here.

## Full-engine alternative: Servo

Servo has the most direct reuse story for an integrated JS DOM among the compared
candidates. Its public embedding flow is `ServoBuilder`, `EventLoopWaker`,
`Servo::spin_event_loop`, `WebViewBuilder`, and a `WebViewDelegate` that reacts to
`notify_new_frame_ready` by painting and presenting. Input goes through
`WebView::notify_input_event`. [Embedding API](https://doc.servo.org/servo/)

It is not a DOM library to attach to V8: script executes through SpiderMonkey and
Servo's own DOM bindings. Reusing it selects that integrated engine and its
scheduling/resource model. [Servo's engine explanation](https://servo.org/blog/2024/04/15/spidermonkey/)

The current [`RenderingContext`](https://doc.servo.org/servo/trait.RenderingContext.html)
requires OpenGL/GLES interfaces (`gleam_gl_api`, `glow_gl_api`, `make_current`).
`WindowRenderingContext` uses surfman; the offscreen context owns an OpenGL
framebuffer under its parent context and is `!Send`/`!Sync`. An offscreen context
is not a ready wgpu texture. Metal/Vulkan composition would require a supported
translation/interoperability path or renderer changes, with measured cost.
[Offscreen context](https://doc.servo.org/servo/struct.OffscreenRenderingContext.html)

The source/docs review does not establish CtF WebRTC/media conformance. Desktop
media configuration also brings GStreamer into the embedding/distribution plan.
Keep Servo as an explicit comparison candidate, not an automatic fallback when
an API is missing. [Embedding build requirements](https://book.servo.org/embedding/overview.html)

## Dependency and patch budget

Blitz is MIT OR Apache-2.0, but that does not make the entire dependency graph
MIT-only: Stylo `0.21.0` declares MPL-2.0. Servo's repository is MPL-2.0; Boa offers
MIT OR Unlicense. Shipping notices and source obligations need the resolved
application dependency graph, including native libraries and bundled fonts.
These are observed license declarations, not a completed distribution audit.

No release-size or steady-state-memory comparison has been made. The DOM test
build excludes a full window/GPU renderer; its size cannot stand in for the
shipping engine. Measure stripped target artifacts, startup RSS, steady-state
memory and node-churn retention for a fixed feature set before choosing by
footprint.

The maintained modular route still requires a substantial new binding surface.
Prefer upstream public APIs and small upstreamable changes for missing lifecycle
hooks. Keep the adapter separate from `blitz-dom`; do not fork Stylo, Taffy or
Three.js to accommodate prototype shortcuts. A V8 adapter would own its WebIDL
conversions, interfaces, exceptions, wrapper lifetime and event dispatch; list
and test those responsibilities explicitly rather than calling them a polyfill.

## Remaining decision gates

1. Extend the executed browser/Blitz fixture with event cancellation, focus,
   transformed geometry and lifetime stress; run it against the proposed V8
   binding and Servo as well. Correct the observed deviations before claiming
   that the DOM profile passes.
2. Integrate one unchanged Three.js canvas into that same document and JS realm,
   with HTML below/above it; prove the GPU ownership boundary without frame
   readback. Then exercise multiple canvases, clipping, transforms and resize.
3. Compare real dynamic CSS/text/IME/accessibility behavior, memory under UI churn,
   startup size and frame cost against the full-engine alternative.
4. Record exact blockers and upstream patches before accepting a backend ADR.

These gates are not complete. Issue #22 must remain open while they lack runtime
and browser-reference evidence.
