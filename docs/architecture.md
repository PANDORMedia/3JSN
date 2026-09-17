# Proposed runtime architecture

Status: the offscreen JS/WebGPU runtime is implemented; the native-window adapter
is under validation and the wider engine remains proposed. [ADR 0002](adr/0002-unchanged-project-compatibility.md) requires unchanged
WebGL projects and dynamic HTML/CSS support too.

## Responsibility boundaries

| Layer | Owns | Does not own |
| --- | --- | --- |
| Game JS/TS | Gameplay, Three.js scenes, materials, animation | Native pointers, surface lifetime |
| Three.js | Scene traversal, render graph, shader generation, GPU commands | OS event loop or packaging |
| JS WebGPU bindings | GPU object identity, promises, typed array conversion, errors | Independent second GPU device |
| Rust host | Windows, events, scheduling, services, shutdown, GPU surface integration | A reimplementation of Three.js |
| wgpu-core / native backend | GPU resources, validation, command submission, platform API translation | Game objects or HTML layout |

The WebGPU prototype embeds V8 via `deno_core` and reuses a matching
`deno_webgpu` extension with its bootstrap dependencies. This is library reuse,
not a decision to launch the Deno CLI. Its [dependency record](dependencies.md)
and [validation](validation/2026-09-17-rust-runtime.md) establish the initial graph
and binary footprint. The HTML/DOM decision may change the JS engine;
do not cement this candidate into public runtime contracts before that gate.

## Compatibility components

Keep JS/WebGPU execution, WebGL compatibility, HTML/DOM rendering and platform
services behind explicit boundaries. Evaluate ANGLE for WebGL/GLSL; the host must
also implement the required WebGL semantics and bindings. Evaluate maintained
HTML/style/layout components plus a JS DOM bridge. All application canvases and
UI surfaces feed a native compositor; cross-backend texture sharing must be proved.
See [HTML rendering](html-rendering.md) and [engineering standards](engineering.md).
The [module contracts](module-contracts.md) define dependency direction, ownership,
errors, cancellation and teardown responsibilities.

## Surface ownership is the first hard problem

The host creates the native window on the platform event thread. It registers a
surface in the **same wgpu-core instance used by the JavaScript binding**. Adapter
selection must account for that surface. The JavaScript GPU device and surface
context refer to the same resource registry and compatible backend.

For the M1 integration spike, expose a minimal canvas-like object for Three.js:
dimensions, `getContext('webgpu')`, and supported events. Its GPUCanvasContext
wraps the acquired surface texture. The product then needs real canvas/DOM
integration and composition; this minimal object does not establish compatibility.

The host coordinates acquire → game update → render/submit → present. Never
read the frame back to CPU memory to display it. Readbacks belong only in captures,
debugging, and tests. Do not pass raw handles from an unrelated wgpu instance or
pretend that an offscreen texture is a presentation surface.

Retain the window while the surface references its handles. Invalidate per-frame
textures after presentation. Reconfigure on nonzero drawable-size changes; skip
acquisition while minimized. On lost/outdated surfaces, recover deliberately.
Expose device loss to the application and fail visibly until resource recreation
is implemented. Shut down callbacks, GPU work and surfaces before destroying
windows and the JS isolate.

## First frame loop

Keep winit and the V8 isolate on the main/event thread for the first integration.
Poll the JS async work without blocking the OS loop. Drive a compatible
`requestAnimationFrame` from the host redraw cycle and give all callbacks in a
frame the same monotonic timestamp. A callback requested during a frame belongs
to a later frame; cancellation must work.

Preserve the existing game loop, event and microtask semantics. Fixed-step
simulation helpers can be optional engine APIs; never insert them automatically
into an unchanged project. Measure before moving rendering to a worker. A
dedicated JS thread requires event handoff, surface constraints and a clear
ownership protocol; threads are not a free performance improvement.

Choose present mode and frames in flight explicitly. Record display refresh rate,
drawable pixel dimensions, and scaling. DPI changes must affect the GPU target,
camera aspect and input coordinates consistently. Limit work while hidden or
unfocused according to an explicit application policy.

## Performance policy

- Keep GPU resources and pipelines alive across frames; dispose deterministically.
- Pass typed data in bulk. Avoid JSON serialization and per-object cross-language
  messages in rendering hot paths. Measure unavoidable upload copies.
- Profile the existing binding before implementing a command stream or custom
  renderer. A second command buffer format adds maintenance and validation work.
- Compile known material variants before interactive play. Treat disk shader/cache
  reuse as backend/driver/version-specific, with safe invalidation.
- Use Three.js instancing, batching, culling and material sharing first. Keeping
  Three.js means its scene traversal and JS allocations remain real costs.
- Bound the render queue. More queued frames can increase throughput while making
  input latency worse. Optimize both according to [the protocol](benchmarks.md).
- Keep native GPU validation for correctness checks; record validation settings in
  performance results. Do not claim speed by silently disabling correctness checks.

## Web technology boundary

Support JavaScript modules and a TypeScript/npm build workflow first. A bundle
is the initial deployment unit; arbitrary Node modules are not guaranteed to run
in the embedded host. Preserve source maps and useful JS stack traces.

Add local assets, image decoding, `fetch` for supported protocols, text encoding,
timers and input incrementally. Use an explicit asset root or package scheme so
games do not depend on the process working directory or a web server. A native
asset service should expose decoded bytes to compatible Three.js loaders.

Wasm physics and decoders are candidates. Workers, audio, networking and gamepads
each need an API contract, lifecycle behavior and platform tests. HTML/CSS menus
are required by the compatibility target. Their DOM, rendering and interaction
contracts are covered by the dedicated HTML investigation.

## Repository growth

Current code includes the offscreen runtime/player and separate GPU probes.
As implementation proceeds, use this responsibility map; add modules only when
they have real work:

```text
crates/runtime/          JS engine and extension bootstrap, async lifecycle
crates/platform/         winit, surfaces, input, frame scheduling
crates/player/           native executable and application options
crates/webgl/            explicit native WebGL compatibility adapter
crates/dom/              selected HTML stack and JS DOM integration
crates/compositor/       native composition of canvas and UI surfaces
crates/cli/              project analysis and target-build orchestration
packages/runtime/        documented JavaScript surface and types
examples/                portable Three.js scenes and reference game
benchmarks/              identical workloads for browser and native hosts
```

Create each module when it gains real responsibility. Defer public package names,
a stable plugin ABI, and engine API promises until the integrated spike works.
