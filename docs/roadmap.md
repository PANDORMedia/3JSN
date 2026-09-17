# Roadmap

The goal is a performant native player for Three.js games, then a usable engine
around it. Milestones are acceptance gates, not release dates. The first integrated
spike is a bounded investigation; a portable engine with assets, audio, tooling
and reliable distribution is a months-scale project.

## M0 — Establish the foundation

- [x] Research existing runtimes and graphics backends using primary sources.
- [x] Record the Rust/WebGPU architecture proposal and compatibility limits.
- [x] Add independently runnable JS rendering and Rust GPU-device probes.
- [x] Pin dependencies and provide a local Git/OSS repository foundation.
- [ ] Run both probes on Windows and Linux hardware.

Exit: reproducible local evidence, honest support status, and a concrete M1 task.
See [initial validation](validation/2026-09-17.md) for the exact evidence.

## M1 — One native window, actual Three.js, Rust host

Do this next, in order:

1. Select compatible published `deno_core`, `deno_webgpu`, web extension and V8
   versions. Compile a minimal embedded JS runtime. Record build footprint and
   any required upstream patches. Do not independently choose incompatible wgpu
   versions for the surface and the binding.
2. Expose `navigator.gpu`, required GPU constants, promises, performance timing,
   console output and the minimal bootstrap needed by Three.js. Run one offscreen
   scene in Rust/V8 to prove the JS bridge before adding presentation.
3. Create a winit window and register its handles with the binding's own GPU
   instance. Prove the surface lifecycle with a clear frame.
4. Wrap that surface as a canvas/context for upstream Three.js. Render the shared
   fixture, acquire/present entirely on GPU, and drive animation from native redraw.
5. Handle resize, scaling, zero-size/minimized windows and clean close. Report
   unsupported adapters, device loss and shader/validation failures clearly.

Acceptance:

- One command opens an animated Three.js scene in a native macOS window.
- No browser/WebView process, local HTTP server, or CPU frame readback in presentation.
- The GPU device used by JS is the one that renders to the window.
- Logs identify engine/dependency versions, native backend and adapter.
- A 10-minute run with repeated resize/minimize/restore/close shows no validation
  errors, crash, or unbounded resource growth.
- JS exceptions reach the console with a useful source location.

Decision gate: accept ADR 0001 only after the bridge works. If integration needs
an extensive fork, compare the cost with embedding/contributing to an existing host.

## M2 — Establish and improve performance

Implement the [benchmark protocol](benchmarks.md), plus native captures and CPU
profiles. Test draw submission, instancing, dynamic uploads, shader warmup, large
scenes and GPU-bound rendering. Compare identical settings in a browser, the Rust
host and an existing native host. Retain raw measurements.

Acceptance: explain the leading bottleneck of each scene and publish repeatable
p50/p95/p99 timings. Decide whether binding optimization, frame-loop changes or
a custom renderer is warranted. Do not declare success on an isolated FPS number.

## M3 — Desktop portability and a playable vertical slice

Bring up Windows/D3D12 and Linux/Vulkan, including X11 and Wayland. Add local glTF
and texture loading, keyboard/pointer input, gamepads, audio, a save directory and
an optional physics integration. Build a small playable example, not just a cube.

Acceptance: the same game source and assets work on all three desktop systems;
only platform packaging/configuration differs. Verify real controllers and audio
devices, resize/fullscreen, asset paths and errors. CI builds all target variants,
while hardware checks validate runtime behavior separately.

## M4 — Developer preview

Provide a CLI to run/build games, documented APIs and compatibility tables,
source maps, restart/reload during development, per-platform artifacts, asset
bundling and dependency notices. Decide versioning and project governance before
publishing packages. Add signing/notarization where distribution requires it.

Acceptance: a contributor can clone a starter, develop locally, produce a game
artifact and run it on a clean target machine without Node or a browser installed.
Record what remains experimental. Keep performance regression workloads in CI or
dedicated hardware jobs, with stable hardware and explicit tolerances.

## Later decisions

Mobile lifecycle/embedding, touch and platform JS constraints; native UI/text;
editor integration; multiplayer/networking; advanced GPU-driven rendering;
console ports where SDK access is available. Choose these from demonstrated game
needs rather than promising every engine subsystem at launch.

## Suggested first issues

1. Embed matched Deno core/WebGPU extensions in a minimal Rust executable.
2. Render the shared Three.js fixture through the Rust JS bridge offscreen.
3. Bind a native winit surface to the same GPU instance.
4. Add redraw-driven animation, resize/DPI handling and deterministic teardown.
5. Create browser/native comparison scenes and record the initial performance baseline.

Each issue should name its acceptance evidence, dependency versions and the exact
platform tested. These are local planning items, not remotely created issues.
