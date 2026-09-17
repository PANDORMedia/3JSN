# 3JSN — Three.js Native

[GitHub project](https://github.com/orgs/PANDORMedia/projects/4) · [Roadmap issues](https://github.com/PANDORMedia/3JSN/issues) · [Milestones](https://github.com/PANDORMedia/3JSN/milestones)

An open-source native runtime and build tool for existing Three.js web games.
The goal is **unchanged game source → `3jsn build` → native desktop applications**.

**Status: research and executable probes. The CLI and integrated game runtime are
not implemented. No platform or unchanged-project compatibility is certified.**

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
- [Research](docs/research.md), [benchmarks](docs/benchmarks.md), and [initial validation](docs/validation/2026-09-17.md).

Maintainability, correctness and measured native performance are design constraints.
Rust owns the host; the selected JS engine executes existing game code. Graphics
and UI components translate their work to native APIs. This implements substantial
web-platform behavior without making Chromium/CEF or an OS WebView the default player.

## Run the research probes

Prerequisites: Node.js 24+ for the JavaScript experiment; Rust 1.92+ and a native
compiler/linker for the Rust diagnostic. GPU commands need access to a real GPU.

```sh
npm ci
npm run check
npm run doctor
npm run probe:gpu

cargo run --locked -p threejs-native-gpu-probe
```

`probe:gpu` renders an animated Three.js scene through Node's Dawn binding to a
native GPU texture, verifies changing pixels, and writes PNGs and a JSON report
to `artifacts/native-webgpu/`. It is an offscreen correctness baseline, **not a
native-window demo or a benchmark**. Node and Dawn are experimental tooling, not
the proposed shipping runtime.

The Rust diagnostic independently opens a `wgpu` adapter and device. It does not
execute JavaScript or render the Three.js scene. These two experiments are not
connected yet.

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
