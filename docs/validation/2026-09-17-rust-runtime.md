# Rust-hosted WebGPU validation — 2026-09-17

Machine: Apple M1 Pro, macOS 26.1 (25B78), arm64. Compiler: Rust 1.93.0.
This establishes a Rust process executing JS through embedded V8 and rendering
through native WebGPU/Metal. It is independent of the original Node/Dawn probe.

## Reproduce

```sh
npm run probe:runtime
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
npm test
```

The probe builds the player in release mode, runs its version command and the
local JS triangle fixture, and records a fresh report under ignored
`artifacts/rust-runtime/`. Compilation alone cannot make this probe pass.
`CARGO_HOME` may point to a local dependency cache; it is not a runtime dependency.

The committed [JSON report](2026-09-17-rust-runtime.json) records the exact dependency
versions, V8 runtime, backend, adapter and binary identity. Result: hardware
Apple M1 Pro, Metal, 64 by 64 target, 1,352 green triangle pixels, expected center
and background RGBA values, and zero captured GPU validation errors.

Release binary: 73,366,912 bytes (about 70 MiB), with the ordinary Cargo release
profile and no extra stripping. `otool -L` showed only macOS system libraries and
Metal/QuartzCore/Foundation frameworks. This is not a packaged application or a
clean-machine distribution test. No size or speed comparison was performed.

## Runtime regression evidence

The Rust integration test exercises local imports, referenced timers, microtask
ordering, text encoding, EventTarget once semantics, global error dispatch,
performance clock initialization, source locations, missing imports and failure
with a still-live interval. Tests consume each realm once and verify that errors
return rather than leaving referenced work running indefinitely.

Adversarial review reproduced two defects before this snapshot: global error
dispatch was incomplete, hiding listener exceptions; `performance.timeOrigin`
was uninitialized. Both have regression cases and are fixed. Extra exploratory
probes covered unhandled rejection, unresolved top-level await and failing dynamic
import. Exploratory checks do not replace the committed regression suite.

The JavaScript foundation suite separately tests compatibility-claim validation
and source/asset preservation, including malformed manifests, mutation/deletion,
exclusions and link boundaries. Its browser fixture evidence is separate from
this native GPU report.

## Limits

There is no window/swapchain, frame scheduler, DOM, WebGL binding, WebRTC or build
CLI in this runtime yet. The fixture uses GPU readback solely to validate pixels.
A future presentation path must remain on the GPU. Local modules are trusted
application code, and the player does not implement a permission sandbox.
Referenced long-lived work keeps the offscreen runner alive; interactive
cancellation belongs to the native host lifecycle work.

The runtime backend is Metal on Apple targets, D3D12 on Windows, and Vulkan on
other current desktop targets. Only the stated Metal hardware run is certified
by this report. CI source/compile/lint/module checks are separate evidence.
