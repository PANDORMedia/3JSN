# Runtime dependency decision

Status: selected for the M1 integration, provisional for the complete product.
The resolved source graph is pinned by `Cargo.lock`. The public interface remains
3JSN's small runtime contract; Deno/wgpu types stay inside its adapter.

## Tested graph

| Component | Selected version | Role |
| --- | --- | --- |
| deno_core | 0.412.0 | Embedded module loader, V8 realm and async event processing |
| deno_v8 / v8 | 0.4.0 / 150.4.0 | Engine adapter and V8 bindings; executable reports its actual V8 version |
| deno_webidl | 0.259.0 | Shared web binding conversions/brands |
| deno_web | 0.290.0 | Events, timers, encoding, performance and other extension prerequisites |
| deno_webgpu | 0.226.0 | JavaScript WebGPU bindings |
| wgpu-core / wgpu-types | 29.0.1 / 29.0.1 | One native resource registry shared with these JS bindings |
| wgpu-hal / naga | 29.0.4 / 29.0.4 | Resolved native backends and shader processing |
| tokio | 1.49.0 | Current-thread async execution |
| winit / raw-window-handle | 0.30.13 / 0.6.2 | OS event loop and native surface handles |

The integration was compiled and run using Rust 1.93.0 on macOS arm64. See the
[dated runtime evidence](validation/2026-09-17-rust-runtime.md) for executable
versions, binary footprint and hardware results. The workspace requires Rust 1.93;
CI uses 1.93.0.

The original standalone GPU diagnostic retains wgpu 28. It is a different
executable and never supplies resources to the embedded host. Do not solve version
mismatches by passing pointers between these instances. The runtime links the
wgpu-core version exported by deno_webgpu, avoiding a separately selected device.

No upstream patches or vendored forks are needed for the current integration.
Its bootstrap is owned 3JSN code using pinned extension exports. A narrow native
canvas adapter selects a surface-compatible GPU and owns texture acquisition,
expiry and transient surface handling. These operations use the same GPU registry
as Deno's JavaScript objects. The [window contract](native-window.md) distinguishes
implemented behavior from pending presentation evidence.

Extension JavaScript is [embedded at compile time](validation/runtime-embedding-notes.md).
The matched Deno extensions are also build dependencies so their declared source
files can be collected without hard-coded registry paths. This increases build
cost; it avoids a release executable reading JavaScript from its build machine.

## Why this amount of reuse

- Reuse Deno's maintained GPU and web bindings instead of implementing WebIDL,
  promises, buffer conversions and GPU object lifetime from scratch. The cost is
  a larger dependency graph and deliberate extension/bootstrap upgrades.
- Keep Node/Dawn as a separate correctness comparison. Shipping it would select a
  different host ABI and distribution story; it is not transparently embedded
  into this Rust isolate.
- Existing hosts such as Mystral and Deno raw desktop remain useful comparisons.
  Their support claims do not establish our unchanged WebGL/HTML/CtF profile.
  [Initial comparison](research.md) records the alternatives.
- ANGLE remains the leading WebGL translation candidate. The tested headless-gl
  binding has correctness gaps and a Node-specific ABI; the
  [WebGL investigation](investigations/webgl.md) does not adopt it for shipping.
- Blitz's Rust DOM/layout components are promising. Its Boa binding is not adopted
  as a second application realm. [HTML evidence](investigations/html-dom.md) records
  current semantic, GPU and dependency constraints; retain the engine decision gate.

## Redistribution and release artifacts

3JSN's own code is MIT. Deno crates and rusty_v8 declare MIT; wgpu/Naga declare
MIT OR Apache-2.0. This is not a complete binary license inventory. V8 itself and
its bundled libraries have additional notices, including BSD-style conditions.
The rusty_v8 crate package excludes license files from some bundled source paths,
so copying only Cargo metadata cannot create a complete distribution notice file.
Use the source revision matching the selected binary, not whatever happens to be
on an upstream main branch. Primary references: [rusty_v8 license](https://github.com/denoland/rusty_v8/blob/main/LICENSE),
[V8 license and third-party references](https://github.com/v8/v8/blob/main/LICENSE).

Before distributing a player artifact, generate a target-specific bill of
materials, preserve applicable license/copyright notices for Cargo dependencies,
V8 and native libraries, and package those notices alongside the application.
Verify archive provenance/checksums for prebuilt V8 and native libraries. These
are release gates; the current repository publishes source and sanitized evidence,
not native library binaries. The candidate HTML stack also includes MPL-2.0 Stylo;
review source/notice requirements if adopted rather than assuming every component
inherits Blitz's top-level license.

## Upgrade policy

Update the matched Deno group together in a dedicated change. Inspect extension
exports, bootstrap prerequisites, engine artifacts, GPU backend dependencies and
license changes. Keep the prior lockfile reproducible. Run source/module/error
regressions, the GPU pixel fixture and then native window/lifecycle tests when
implemented. Record the resulting versions and hardware evidence before changing
compatibility status. A successful Cargo resolution is not an integration test.

Upstream patches must have a narrow reason, owner, tracking link, removal condition
and a regression fixture. Reassess an adapter whose patch burden grows; do not
quietly accumulate a permanent browser/Three.js fork. Record footprint and startup
changes with comparable release builds. No size or performance target is claimed
until representative game/UI workloads establish a baseline.
