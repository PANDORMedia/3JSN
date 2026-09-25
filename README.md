# 3JSN — Three.js Native

[GitHub project](https://github.com/orgs/PANDORMedia/projects/4) · [Roadmap issues](https://github.com/PANDORMedia/3JSN/issues) · [Milestones](https://github.com/PANDORMedia/3JSN/milestones)

An open-source native runtime and build tool for existing Three.js web games.
The goal is **unchanged game source → `3jsn build` → native desktop applications**.

**Status: Rust-hosted Three.js/WebGPU rendering, a visible native Metal demo,
and compatibility experiments. An experimental host-only build CLI packages the
native-window fixture and a restricted HTML-entry demo; existing web-project builds are not integrated.
The experimental Vite adapter can capture a project's emitted web artifact graph,
but it does not create a native package. No platform or unchanged-project
compatibility is certified.**

The leading design uses a Rust harness and native GPU APIs. Existing WebGL/GLSL
projects and dynamic HTML/CSS interfaces are part of the target, alongside WebGPU.
Application configuration is allowed; rewriting game code, shaders or UI is not
required by the intended product contract. Support will advance through explicit,
verified capability profiles and independent applications, with CtF as one
demanding acceptance example. No game-specific behavior belongs in the runtime.

## Direction

- [Product contract](docs/product.md): CLI behavior and the meaning of no code changes.
- [Architecture](docs/architecture.md) and [updated decision](docs/adr/0002-unchanged-project-compatibility.md): native host and compatibility boundaries.
- [HTML/CSS research](docs/html-rendering.md): DOM, layout, interaction and GPU composition.
- [Compiled UI direction](docs/adr/0003-compiled-ui-and-generic-compatibility.md): build-time HTML/CSS processing, live native UI state and proven parser omission.
- [Webfont packaging](docs/web-fonts.md): opt-in static font downloads, pinned offline builds and native face loading.
- [Roadmap](docs/roadmap.md) and [issues](docs/issues.md): milestones and tracked work.
- [Compatibility](docs/compatibility.md) and [CtF inventory](docs/ctf-compatibility.md): requirements and verified gaps.
- [Engineering standards](docs/engineering.md): maintainable boundaries, reliable behavior and purposeful comments.
- [Module contracts](docs/module-contracts.md), [dependency decision](docs/dependencies.md), and [versioned profile](docs/profiles/README.md).
- [Research](docs/research.md), [benchmarks](docs/benchmarks.md), and [initial validation](docs/validation/2026-09-17.md).

Maintainability, correctness and measured native performance are design constraints.
Rust owns the host; the selected JS engine executes existing game code. Graphics
and UI components translate their work to native APIs. This implements substantial
web-platform behavior without making Chromium/CEF or an OS WebView the default player.

## Run the research probes

Prerequisites: Node.js 24+ for the JavaScript experiment; Rust 1.93+ and a native
compiler/linker for the Rust diagnostic. GPU commands need access to a real GPU.

```sh
npm ci
npm run check
npm test
npm run doctor
npm run probe:gpu
npm run probe:runtime
npm run probe:three
npm run probe:window-lifecycle

cargo run --locked -p threejs-native-gpu-probe
cargo run --locked -p threejs-native-player -- examples/runtime/offscreen.mjs
cargo test --workspace --locked
```

`probe:gpu` renders an animated Three.js scene through Node's Dawn binding to a
native GPU texture, verifies changing pixels, and writes PNGs and a JSON report
to `artifacts/native-webgpu/`. It is an offscreen correctness baseline, **not a
native-window demo or a benchmark**. Node and Dawn are experimental tooling, not
the proposed shipping runtime.

The Rust player now embeds V8, loads local JS modules and exposes native WebGPU
through matching Deno extensions. `probe:runtime` builds it in release mode,
verifies triangle pixels on real hardware, and records dependency/adapter/binary
evidence in `artifacts/rust-runtime/report.json`. See the
[Rust integration validation](docs/validation/2026-09-17-rust-runtime.md).

`probe:three` bundles the unchanged shared scene, runs upstream Three.js r186 in
Rust-hosted V8, verifies changing pixels, and saves captures plus input/binary
identities to `artifacts/rust-three/`. Readback is for verification only. The
[recorded hardware evidence](docs/validation/2026-09-18-native-host.md) covers the
scene, texture expiry, GPU frame retention and error cleanup. The
[native-window adapter](docs/native-window.md) now has a [visible macOS/Metal
checkpoint](docs/validation/2026-09-18-visible-window.md): the opaque scene rendered
in a native window and a bounded run presented 120 frames. Transparent
presentation and broader hardware lifecycle gates remain open. Run the window
fixture using the commands in the adapter documentation.

The demo is now [interactive](docs/native-input.md): drag or use arrows to orbit,
scroll to zoom, Space to pause and R to reset. The
[native input checkpoint](docs/validation/2026-09-18-native-input.md) records OS
input reaching V8, visible camera changes, window resizing and clean shutdown.
These events currently target the standalone canvas/global fixture; DOM input,
IME, pointer capture and controllers remain open.

The [experimental build command](docs/build.md) packages that fixture and a local
player into a portable application directory. It records source preservation and
file identities; the executable validates its manifest before startup and finds
its entry independently of the working directory. This is an initial packaging
path, not unchanged WebGL/HTML project support or a signed distribution workflow.
The [relocation checkpoint](docs/validation/2026-09-18-native-package.md) verifies
120 Metal frames after removing the disposable build input, with Node absent
from the native process's PATH, plus corruption and packaged-error diagnostics.

The original Rust diagnostic independently opens a `wgpu` adapter and device.
It does not execute JS. The Node/Dawn scene remains a separate reference.

The [WebGL/ANGLE experiment](experiments/native-webgl/README.md) and
[HTML investigation](docs/investigations/html-dom.md) record working paths and
concrete upstream compatibility failures. They are not adopted shipping backends.

Follow-on experiments now verify [ANGLE-to-wgpu Metal texture sharing](experiments/native-webgl-wgpu/README.md)
without CPU image transport and [V8-to-Blitz DOM behavior](experiments/html-v8/README.md)
with one authoritative DOM. [Native HTML painting](experiments/html-paint/README.md)
now carries that document's JavaScript mutations through layout, text shaping and
Vello GPU rasterization, with pixel and DPI evidence. The [public compatibility corpus](fixtures/README.md)
has browser references for WebGL/DOM, workers/Wasm, offline audio/worklets and
fetch/WebSocket reconnection. These isolated results do not yet constitute an
integrated unchanged-game runtime.

The [shared Metal composition experiment](experiments/native-html-interop/README.md)
now combines that live DOM with the unchanged shared Three.js scene in one V8
realm, using the same native GPU device and queue. Pixel, event, recreation and
failure-cleanup checks pass; native presentation, full browser compatibility and
other-platform compositor validation remain open.

The [DOM canvas experiment](experiments/dom-canvas/README.md) connects real
`HTMLCanvasElement` objects to Three.js and paints them among HTML elements.
Its 27 shared canvas assertions match Chrome; native stacking, resize, retention
and alpha controls pass. A pinned patch repairs duplicate painting after a stacking
change, and [initialized handoff](docs/validation/2026-09-18-canvas-handoff.md) handles
untouched, partially written and discarded render-attachment canvases. Ancestor
clipping still fails, so the integration result remains explicitly partial.

The [native DOM window](experiments/dom-canvas/WINDOW.md) now presents HTML text,
a working HTML button and a real Three.js canvas together through Metal. The
same fixture HTML and bundle run in the browser. Its
[hardware checkpoint](docs/validation/2026-09-18-dom-window.md) covers 120 frames,
canvas retention, animation-error propagation and observed native pause/resize
controls. The [HTML-entry packaging checkpoint](docs/validation/2026-09-18-dom-package.md)
now runs the relocated fixture with development-source reads and networking
denied. It remains an interpreted HTML experiment; generic unchanged HTML/WebGL
applications and build-time UI compilation are not yet supported.

A [native DOM geometry repair](docs/validation/2026-09-18-geometry-positioning.md)
now matches Chrome on 23 shared checks. A separately pinned upstream layout
candidate repairs viewport ownership, dynamic grid state and
[equal-z painting across geometry owners](docs/validation/2026-09-18-paint-order.md).
It matches 19/20 paint-order cases and 19/21 initial-owner cases; effect ordering,
transformed geometry, clipping and input/scrolling gaps still prevent adoption.
The next [transform-context checkpoint](docs/validation/2026-09-18-transform-context.md)
repairs current style ownership and first-frame hit bounds. Its new auto-paint
matrix improves to 5/17, while correct transform removal exposes a prior one-frame
clip pass as unstable. The candidate remains unadopted; the
[paint-ownership investigation](docs/investigations/paint-ownership.md) records the
shared paint/input/clip boundary needed next.
The [ownership checkpoint](docs/validation/2026-09-18-paint-ownership.md) now adds
a read-only diagnostic plan and shared rounded-box geometry. All 112 native
paint case records remain unchanged; the new effect fixture still matches only
10/18 browser cases. Renderer adoption and clip-aware input remain open.
The [paint-budget correction](docs/validation/2026-09-18-paint-budget.md) now
rejects excessive layer use explicitly in both prepared renderers. Raised-limit
Metal captures match Chrome in 3/3 controls; all 112 existing paint case records
remain unchanged. Fourteen new clip-routing controls explain Chrome's distinct
opacity and clip-path behavior, while native parity remains partial at 8/14.

An explicit [ownership renderer](experiments/dom-canvas/OWNERSHIP.md) now fixes
paint phases, escaped clips and opacity bounds in the box fixtures. Its
[Metal checkpoint](docs/validation/2026-09-18-ownership-renderer.md) matches uniform
interior pixels in 142/142 cases and geometry plus pixels in 136/142. The legacy
path is preserved; text, clip-edge fidelity, input, scrolling and backend adoption
remain open.

The [opacity-output repair](docs/validation/2026-09-18-opacity-output.md) now
applies shared clips after opacity-group composition. All 13 targeted groups
retain identical complete images when a fully covered underlay changes; all
48 new geometry/interior comparisons pass, and the earlier 142 case records
remain unchanged. Plain polygon edges, text/input integration and backend
adoption remain open. The [clip-edge diagnostic](docs/validation/2026-09-18-clip-edges.md)
records why uniform-interior checks alone cannot certify composition.

The [own CSS rect correction](docs/validation/2026-09-18-css-rect-effect.md)
keeps that clip inside its owner's opacity effect. New controls match Chrome's
composition classification and uniform interiors, while all 190 prior ownership
captures remain unchanged. Transformed DOM queries and live display-scale
transitions still have recorded failures.

The positioned candidate's [DPR cache repair](docs/validation/2026-09-18-dpr-cache.md)
now passes all three previously failing CPU regressions and 77 selected layout
and ownership tests. Physical display transitions and GPU/input alignment remain
unverified; this repair does not adopt the candidate into the native DOM window.

The probes select Metal on macOS, Vulkan on Linux, and D3D12 on Windows. Drivers
and hardware must support the selected backend. For the JS experiment, an
explicit `THREEJS_NATIVE_BACKEND` environment variable can select one of those
three backends; no WebGL or software-rendering fallback is requested.

Related projects already demonstrate this category, including
[Mystral Native](https://github.com/mystralengine/mystralnative),
[Deno WebGPU window demos](https://github.com/chirsz-ever/deno-webgpu-window-demos),
and [Babylon Native](https://github.com/BabylonJS/BabylonNative). 3JSN aims to earn
its place through a focused Three.js developer experience and measured native
performance. It does not claim to be the first browserless JavaScript renderer.

MIT licensed. Independent project; no affiliation with Three.js or the named
dependencies is implied. The package is private while the design is exploratory.
