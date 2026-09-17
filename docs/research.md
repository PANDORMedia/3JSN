# Native Three.js research

Research date: 2026-09-17. This document separates upstream capabilities from
what has actually been verified in 3JSN. The latter is recorded in
[validation](validation/2026-09-17.md). Links to development branches can change.

## What already exists

| Project | Evidence from the project | Consequence for 3JSN |
| --- | --- | --- |
| [Mystral Native](https://github.com/mystralengine/mystralnative) | Native JS runtime; a Three.js WebGPU example; V8/JSC/QuickJS and Dawn/wgpu options; SDL3 platform integration. Described as early alpha. | Closest precedent and a useful comparison target. Audit reuse/contribution before duplicating its work. |
| [Deno native WebGPU](https://docs.deno.com/runtime/desktop/webgpu/) | Current desktop docs describe raw windows and explicit GPU presentation. | A practical reference for surface integration and an alternative host to measure. |
| [Deno window demos](https://github.com/chirsz-ever/deno-webgpu-window-demos) | Existing Three.js examples in a native-window environment. | Browserless Three.js is already possible; delivering a reliable engine is the larger task. |
| [Babylon Native](https://github.com/BabylonJS/BabylonNative) | JavaScript graphics framework adapted to native applications across desktop and mobile. | Architectural precedent, not a drop-in Three.js backend. |
| [Dawn Node binding](https://github.com/dawn-gpu/node-webgpu) | Native WebGPU in Node; texture rendering/readback, without browser canvas integration. | Small, independent test of Three.js rendering on native GPU APIs. Does not solve window presentation. |

Deno's desktop default is a WebView. Only the documented
[`raw` backend](https://docs.deno.com/runtime/desktop/backends/) is appropriate
for this project's browserless requirement. Reusing Deno's Rust libraries also
does not require embedding its desktop WebView backend.

## Define “native” precisely

The game is a native process with an embedded JavaScript engine, native input,
native window presentation, and GPU commands executed through the platform's
graphics API. JavaScript remains JavaScript. TypeScript is transformed to
JavaScript during development/build. TSL generates shaders; the GPU backend
compiles/translates them for the target GPU.

This does not imply arbitrary JavaScript becomes an ahead-of-time Rust/C++ game,
nor that a packaged executable has zero runtime dependencies.

## Architecture choices

| Route | Advantages | Main cost / uncertainty | Recommendation |
| --- | --- | --- | --- |
| Rust + V8/deno_core + deno_webgpu + winit | Rust resource ownership; established JavaScript engine; existing WebGPU bindings; native graphics backends. | Extension bootstrap, dependency churn, surface sharing, native lifecycle integration. | Leading design; prove the integration in M1. |
| Existing native runtime, especially Mystral | Short route to an integrated playable demo and existing platform services. | Need to measure compatibility, frame scheduling, maintenance, and extension constraints. | Benchmark and audit before building equivalent services. |
| Deno raw desktop | Available host with WebGPU and standard runtime services. | Need to evaluate game-oriented input/audio, scheduling control, and deployment footprint. | Reference implementation and alternative baseline. |
| C++ + V8 + Dawn + SDL3 | Mature building blocks and close alignment with Dawn. | Bindings, ownership, build system and cross-platform distribution remain substantial work. | Viable alternative; not inherently faster or slower than Rust. |
| Rust + custom Three.js renderer backend over wgpu/SDL GPU | Could reduce boundary calls or expose native features. | Must maintain renderer/material/shader compatibility with Three.js. | Only if profiling proves a bottleneck the standard binding cannot fix. |
| WebGL2 compatibility over ANGLE | Potential migration route for existing GLSL-heavy projects. | Extra API binding and compatibility surface, with its own performance behavior. | Separate future track, not the first renderer. |
| General JavaScript-to-native source translation | Attractive promise of “compile my game.” | Dynamic language semantics, npm compatibility and debugging; effectively a compiler project. | Outside the initial scope. |

The [wgpu project](https://github.com/gfx-rs/wgpu) provides native Metal,
Vulkan and D3D12 backends. [wgpu-native](https://github.com/gfx-rs/wgpu-native)
exposes a C API; a Rust host does not need that wrapper merely to use wgpu.
[Dawn](https://github.com/google/dawn) is a separate native WebGPU implementation.
Neither is a browser.

[SDL GPU](https://wiki.libsdl.org/SDL3/CategoryGPU) is another cross-platform
graphics API, but it is not the WebGPU JavaScript API expected by Three.js.
Substituting it requires an adapter or a custom renderer. For the leading Rust
route, [winit](https://github.com/rust-windowing/winit) handles windows/events;
audio and gamepads need additional services later.

## Rust and JavaScript integration

[rusty_v8](https://github.com/denoland/rusty_v8) provides Rust access to V8.
`deno_core` adds runtime facilities around V8. Its
[former repository](https://github.com/denoland/deno_core) redirects development
to the Deno monorepo; it should not be mistaken for an abandoned technology.

[deno_webgpu](https://github.com/denoland/deno/tree/main/ext/webgpu) is the useful
bridge: JavaScript GPU objects backed by `wgpu-core`. Inspection of its extension
registration found dependencies on `deno_webidl` and `deno_web`. Its native code
also depends on related Deno/image/runtime crates. Embedding it is more involved
than adding `wgpu` and exposing a few functions.

The [surface implementation](https://github.com/denoland/deno/blob/main/ext/webgpu/canvas.rs)
uses a shared native GPU instance and surface identity. The M1 spike must reuse
that ownership model. A texture from an independently created `wgpu::Device`
cannot simply be handed to this JavaScript API. Pin a matched set of Deno crates,
V8, and wgpu dependencies and test the exported surface hooks before choosing
whether a small upstream change is needed.

## Three.js compatibility

[WebGPURenderer](https://threejs.org/docs/pages/WebGPURenderer.html) is the
appropriate upstream renderer. The local probe pins `three@0.186.0`; its source
accepts an externally supplied GPU device/context. That avoids a permanent
Three.js fork for the first experiment. Internal integration points can change
between releases, so keep a compatibility fixture and deliberate upgrades.

Existing WebGL-specific materials and integrations are not automatically
portable. The migration target is node materials/TSL and WebGPU-compatible
addons. DOM controls, HTML/CSS overlays, image loading, audio, workers, and
compressed assets each need an explicit runtime implementation or alternative.
See the [compatibility plan](compatibility.md).

## Performance hypothesis, not a result

A native host may improve frame scheduling, browser-process overhead, deployment
control, and data movement. Browsers already use native GPU backends, and both
routes still pay for Three.js scene processing, shader work, GPU execution and
JavaScript garbage collection. More FPS is not guaranteed.

Measure CPU-heavy and GPU-heavy scenes separately. Prefer shared buffers,
resource reuse, fewer calls and warm pipelines before inventing an alternate
renderer. Keep correctness validation enabled in the initial implementation.
Use the [benchmark protocol](benchmarks.md) to decide what deserves optimization.

## Product ideas to explore

1. A native player: run a bundled Three.js game with predictable input and frame pacing.
2. An SDK: asset loading, saves, audio, gamepads, fixed-step simulation, optional physics.
3. Build tooling: one project, per-platform executables and asset packages, source maps,
   reload/restart in development, native GPU captures and useful crash reports.
4. A reference game: a small playable scene that exercises the whole shipping path.

Start with the player. An editor, full DOM, networking framework, console SDKs,
and a custom ECS are separate decisions; none is required to prove the renderer.
