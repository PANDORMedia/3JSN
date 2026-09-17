# Proposed runtime architecture

Status: design for M1, not an implemented engine. See [ADR 0001](adr/0001-rust-native-webgpu.md).

## Responsibility boundaries

| Layer | Owns | Does not own |
| --- | --- | --- |
| Game JS/TS | Gameplay, Three.js scenes, materials, animation | Native pointers, surface lifetime |
| Three.js | Scene traversal, render graph, shader generation, GPU commands | OS event loop or packaging |
| JS WebGPU bindings | GPU object identity, promises, typed array conversion, errors | Independent second GPU device |
| Rust host | Windows, events, scheduling, services, shutdown, GPU surface integration | A reimplementation of Three.js |
| wgpu-core / native backend | GPU resources, validation, command submission, platform API translation | Game objects or HTML layout |

Embed V8 via `deno_core`; reuse a matching `deno_webgpu` extension and its required
bootstrap dependencies. This is library reuse, not a decision to launch the Deno
CLI. The prototype must establish exactly which web/runtime extensions are
required before we promise a small distribution size.

## Surface ownership is the first hard problem

The host creates the native window on the platform event thread. It registers a
surface in the **same wgpu-core instance used by the JavaScript binding**. Adapter
selection must account for that surface. The JavaScript GPU device and surface
context refer to the same resource registry and compatible backend.

Expose a minimal canvas-like object for Three.js: dimensions, `getContext('webgpu')`,
and the events we explicitly support. Its GPUCanvasContext wraps the acquired
surface texture. A small JS object with this shape does not require HTML or a DOM.

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

Use a bounded fixed-step simulation accumulator with an explicit catch-up cap,
and render once per redraw. Measure before moving rendering to a worker. A
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
are not part of the shipping rendering path; use rendered UI or a separate tool.

## Repository growth

Current code is intentionally two small probes. When M1 starts, add:

```text
crates/runtime/           V8 and extension bootstrap, async lifecycle
crates/platform/          winit, surfaces, input, frame scheduling
crates/player/            native executable and application options
packages/runtime/        documented JavaScript surface and types
examples/                portable Three.js scenes and reference game
benchmarks/              identical workloads for browser and native hosts
```

Create each module when it gains real responsibility. Defer public package names,
a stable plugin ABI, and engine API promises until the integrated spike works.
