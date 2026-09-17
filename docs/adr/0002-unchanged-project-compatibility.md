# ADR 0002: Preserve existing Three.js application source

- Date: 2026-09-17
- Status: product constraint accepted; backend choices remain experimental
- Updates: [ADR 0001](0001-rust-native-webgpu.md)

## Decision

The product target is `3jsn build` producing per-platform native applications from
an existing Three.js web project without game-source edits. Configuration and
transparent build-output adaptation are allowed. Support is published as versioned
compatibility profiles; “any project” is the direction, not an initial guarantee.

Rust remains the leading harness language. V8/deno_core and wgpu remain candidates
for JavaScript and WebGPU. WebGL/GLSL compatibility and HTML/CSS/DOM are mandatory
tracks because existing games use them. The native-WebGPU-only design in ADR 0001
is an integration milestone, not the complete product architecture.

## Consequences

- Keep the project's Three.js version and renderer. Do not mandate TSL migration
  or a new UI library to pass the unchanged-project acceptance test.
- Evaluate ANGLE-backed WebGL bindings, including WebGL-specific validation and
  extensions. OpenGL ES support alone is not a complete WebGL implementation.
- Research a maintained HTML/style/layout/paint stack plus JS DOM integration.
  GPU painting is only one stage. A full browser engine is an explicit alternative,
  not an invisible compatibility fallback.
- Preserve application scheduling semantics. Offer fixed-step engine helpers only
  as optional APIs; do not insert them into existing games automatically.
- CtF's client is an acceptance target; its external game/voice services need
  explicit deployment configuration rather than accidental inclusion in a client.
- Use one build entry point with target workers/prebuilt components where needed;
  do not promise universal local cross-compilation or signing.

## Quality requirement

Maintainable architecture, solid behavior, focused modules and useful documentation
are release requirements. Comments explain intent and invariants. Dependency
integration cost is part of architecture selection, alongside speed and compatibility.
See [engineering standards](../engineering.md).
