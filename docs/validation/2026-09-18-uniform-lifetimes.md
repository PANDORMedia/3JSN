# Uniform location lifetime checkpoint

This addresses the uniform-registry growth finding in the
[PR #64 review](https://github.com/PANDORMedia/3JSN/pull/64#pullrequestreview-5251544972).
Previously every successful `getUniformLocation` inserted another native registry
entry, including repeated lookups. Invalidated locations remained until context
teardown. Long-running applications that query or relink programs repeatedly could
therefore keep increasing host storage.

Each program/link generation now owns a cache keyed by the native uniform location.
Array names and their `[0]` aliases share one host entry, while JS still receives
fresh wrappers. This avoids caching arbitrary input strings or missing names.
Context and program identities keep equal native location numbers isolated.

Every link attempt invalidates and removes the previous generation's entries.
Deleting a noncurrent program also removes them immediately. A deleted current
program retains its executable and locations until a successful program switch or
unbind; failed switches leave it usable. Registry IDs remain monotonic, so an old
wrapper cannot acquire a newly issued location after reclamation. These entries
contain borrowed native location values, not independently deleted GL resources.

## Verified behavior

- Twenty-two CPU tests pass. New registry-backed controls exercise 128 generations
  with 1,000 repeated lookups each, distinct context/program ownership, stale
  handles, and deleted-current retention until switch/unbind.
- The native V8/ANGLE Metal test retains fresh JS wrappers from 4,096 repeated
  array/alias lookups and queries 4,096 missing names. The complete registry contains
  exactly two shaders, one program and two uniform entries afterward.
- Sixty-four successful native relinks each reduce that registry to the three
  shader/program entries before new locations are acquired. Actual uniform-driven
  pixels remain correct after every relink; stale locations raise `INVALID_OPERATION`.
- A failed link also reclaims locations. Recovery, deletion while current, a
  rejected switch to an unlinked program, successful unbinding, direct replacement
  by a linked program, noncurrent deletion, and cross-context use all pass with
  actual pixel/error checks. Final context
  teardown leaves zero registry entries.
- The unchanged public Three/HTML demo passes 60 offscreen frames in the preserved
  parser build, including resize, replacement and cleanup. Its final capture matches
  the prior checkpoint. Strict scoped Clippy, formatting and source checks pass.

[Archived logs and demo report](2026-09-18-uniform-lifetimes/) identify the actual
test executables and fixtures. Native checks use `MTL_DEBUG_LAYER=1` and the pinned
local ANGLE package. Run CPU checks with `cargo test --manifest-path
experiments/webgl-runtime/Cargo.toml`; the ignored
`uniform_registry_tracks_live_program_generations` test also needs
`ANGLE_LIBRARY_DIR` pointing to its `deps/darwin/dylib` directory. Building requires
`THREEJS_NATIVE_ANGLE_PACKAGE` pointing to the package root.

This measures live registry entries and rendering behavior, not process RSS, JS
garbage collection or driver allocation totals. Uniform locations of live programs
remain cached until relink or program/context retirement. Other resource-finalizer,
context-loss, GPU failure, native-window and platform gates remain open.
