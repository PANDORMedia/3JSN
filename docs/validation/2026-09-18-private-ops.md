# Application access to bootstrap operations

This checkpoint addresses finding 8 in the [PR #64 review](https://github.com/PANDORMedia/3JSN/pull/64#pullrequestreview-5251544972).
Before the change, application code could obtain `op_angle_dispose`,
`op_angle_resize` and `op_webgl_canvas_register` through `Deno.core.ops`.
The reproduction inspected their types without invoking them; its compact
observation is archived in [before-observation.json](2026-09-18-private-ops/before-observation.json).

Both the main runtime and shared HTML host now remove `Deno`, `__bootstrap`
and `__infra` after trusted extension initialization and before application
evaluation. Failure to remove a bootstrap global stops construction. Internal
bindings retain their captured core imports. Application static and dynamic
imports of privileged extension modules are rejected by the existing loader.
This closes the exposed bootstrap entry points; it does not establish a sandbox
for untrusted applications or change the trusted local-module loading policy.
The standalone ANGLE diagnostic remains an explicit host-operation probe.

## Validation

- Shared-source tests: 8 passed, including repeated sealing and failure when any
  bootstrap global is nonconfigurable.
- Runtime unit tests: 3 passed, 1 GPU test initially ignored; execution integration
  tests: 2 passed. Input dispatch, trusted events, animation microtask ordering,
  timers and extension-import rejection remain covered. Privileged input fixtures
  now execute as trusted startup extensions instead of application modules.
- The ignored WebGPU deferred-snapshot test was then run on hardware and passed:
  device creation, submission, readback and destroyed-source rejection still work.
- The actual DOM WebGL canvas test passed on hardware with the sealed realm.
- The unchanged public Three.js demo passed in preserved-parser and parser-omitted
  builds: 60 frames, five checkpoints, four snapshot generations and cleanup in
  each run. Both test realms also assert the missing `Deno` global and rejection
  of an application import of `ext:core/mod.js` before running the fixture.
- Both final 960×640 captures have SHA-256
  `18a45c0715feba788761025143be29d1234ad7e6034a0169a5980e3734c8d041`.
- Strict Clippy covers the changed workspace crates and the preserved-parser
  compiled UI WebGL test targets. Rust formatting and repository source checks pass.

The [evidence directory](2026-09-18-private-ops/) contains CPU/WebGPU logs and
both offscreen reports with executable and fixture hashes. Runs use the local
ANGLE package and Metal validation. They prove offscreen regression behavior,
not native-window presentation, cross-platform support, arbitrary project
compatibility or the other synchronization/context-attribute findings in the review.
