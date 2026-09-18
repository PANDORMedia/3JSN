# 3JSN — Three.js Native

[GitHub project](https://github.com/orgs/PANDORMedia/projects/4) · [Roadmap issues](https://github.com/PANDORMedia/3JSN/issues) · [Milestones](https://github.com/PANDORMedia/3JSN/milestones)

An open-source native runtime and build tool for existing Three.js web games.
The goal is **unchanged game source → `3jsn build` → native desktop applications**.

**Status: Rust-hosted Three.js/WebGPU offscreen rendering, a native-window adapter
under validation, and compatibility experiments. The build CLI is not implemented.
No platform or unchanged-project compatibility is certified.**

The leading design uses a Rust harness and native GPU APIs. Existing WebGL/GLSL
projects and dynamic HTML/CSS interfaces are part of the target, alongside WebGPU.
Application configuration is allowed; rewriting game code, shaders or UI is not
required by the intended product contract. Support will advance through explicit,
verified compatibility profiles, with CtF as a demanding acceptance application.

## Direction

- [Product contract](docs/product.md): CLI behavior and the meaning of no code changes.
- [Architecture](docs/architecture.md) and [updated decision](docs/adr/0002-unchanged-project-compatibility.md): native host and compatibility boundaries.
- [HTML/CSS research](docs/html-rendering.md): DOM, layout, interaction and GPU composition.
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
[native-window adapter](docs/native-window.md) has separate presentation and
lifecycle gates; offscreen rendering does not certify a visible window.

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

A [native DOM geometry repair](docs/validation/2026-09-18-geometry-positioning.md)
now matches Chrome on 23 shared checks. A separately pinned upstream layout
candidate improves containing-block ownership, but viewport, transformed geometry
and dynamic grid failures keep it outside the default experiment.

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
