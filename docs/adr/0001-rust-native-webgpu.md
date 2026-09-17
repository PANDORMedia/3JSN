# ADR 0001: Rust harness, JavaScript gameplay, native WebGPU

- Date: 2026-09-17
- Status: proposed WebGPU integration track; product scope amended by [ADR 0002](0002-unchanged-project-compatibility.md)
- Priority: native performance while retaining Three.js and web development technology

## Decision

Use Rust as the leading host language. Evaluate embedded V8 through `deno_core`
and reuse `deno_webgpu` over `wgpu-core`. Use winit for native window lifecycle
and basic input. Preserve upstream Three.js `WebGPURenderer` and TSL initially.

The supported desktop targets we intend to establish are macOS/Metal,
Linux/Vulkan, and Windows/D3D12. The shipping host should contain no browser,
WebView or mandatory local frontend HTTP server. HTML/layout components are now
required by ADR 0002; the original rendering-only scope has expanded.

An independently installed Node/Dawn experiment is retained as a correctness
reference. It is not the Rust host, nor a commitment to shipping Node.

## Why

Rust gives the project explicit ownership and useful compile-time checks around
platform state. The wgpu ecosystem supplies native graphics backends, while V8
keeps the actual Three.js implementation and JavaScript tooling usable. Reusing
a functioning WebGPU binding is a more tractable starting point than writing
hundreds of API bindings and their promise/resource semantics.

This is a maintainability and integration choice. Language alone is not evidence
of better runtime performance than a C++ implementation.

## Conditions before acceptance

1. A matched set of Rust dependencies builds on all three desktop platforms.
2. A JS-owned GPU device renders upstream Three.js into a native surface from the
   same native GPU instance; no CPU readback is used to display frames.
3. Resize, DPI changes, minimization, close, device loss and shutdown have explicit
   ownership rules and observable error behavior.
4. A profile separates JavaScript scene work, binding overhead, GPU work and present
   latency. Compare with browser WebGPU and at least one existing native host.
5. The implementation and upkeep needed are justified against contributing to or
   embedding an existing runtime, especially Mystral or Deno raw desktop.

## Alternatives and escape hatches

Use Dawn from Rust via FFI if concrete driver/compatibility evidence favors it.
Use an existing runtime if it meets the timing/control requirements. Consider a
custom Three.js renderer backend only after standard WebGPU bindings are proven
to be the limiting factor. Keep those alternatives out of the first host's code
until needed; do not build multiple production backends in parallel.

## Consequences

We own the host lifecycle, surface bridge and deliberate web API subset. We must
track upstream versions and avoid a broad Three.js fork. Mobile platforms need
their own lifecycle and JS execution policy evaluation. Console support requires
platform-specific access and cannot be promised by choosing Rust or WebGPU.
