# Roadmap

## Product target

Run `3jsn build` against an existing Three.js web project and produce a native
application for each supported desktop target, without editing the game's
JavaScript, shaders, HTML or CSS. Configuration for entry points, build commands,
assets, application identity and service endpoints is allowed. Generated build
artifacts may be transformed; the source tree stays unchanged.

This is the destination, not current compatibility. Start with versioned capability
profiles and independent redistributable fixtures. CaptureTheFrog (CtF) is one
demanding acceptance project; it does not define runtime architecture. Expand
support with evidence. Unsupported APIs must produce useful diagnostics rather than a
misleading successful build. See the [product contract](product.md).

The [GitHub issue index](issues.md) maps each milestone to its epic and work items.
GitHub issues track execution; this page explains sequencing and completion gates.

The latest [native DOM-window checkpoint](validation/2026-09-18-dom-window.md)
combines one Three.js canvas with interactive HTML and resizing on Metal. The
separate [DPR cache repair](validation/2026-09-18-dpr-cache.md) passes its CPU
regressions. Next integration gates are broader DOM/input semantics and project
loading, alongside unchanged WebGL support; these checkpoints do not complete M3.

The [HTML-entry packaging checkpoint](validation/2026-09-18-dom-package.md)
adds an interim DOM profile with embedded runtime sources, manifest validation,
an explicit local font and a relocated Metal run with development-source reads
and networking denied. Existing frontend builds and generic resource loading
remain open. [Webfont bundling](https://github.com/PANDORMedia/3JSN/issues/56)
is planned as an opt-in build capability.

The [compiled UI direction](adr/0003-compiled-ui-and-generic-compatibility.md)
adds static HTML/CSS compilation and evidence-based parser omission to M3/M5.
The runtime retains live UI state and required dynamic parsing. This work is
planned; current HTML experiments still carry their parsers.

## Milestones

| Phase | Deliverable | Completion gate |
| --- | --- | --- |
| M0 — Contract and architecture | Compatibility contract, CtF inventory, boundaries and foundation | Supported semantics, source-preservation evidence and module ownership are explicit |
| M1 — Native Rust host | Embedded JS, native window, GPU surface and lifecycle | Upstream Three.js WebGPU scene runs in a Rust-hosted native window with clean shutdown |
| M2 — Unchanged WebGL projects | WebGL2/GLSL compatibility, post-processing and multiple canvases | Existing WebGL Three.js fixtures run without renderer or shader edits |
| M3 — HTML/CSS on the GPU | DOM integration, layout, text, interaction and composition | Dynamic HTML/CSS UI and 3D canvases compose and receive input correctly |
| M4 — Web services and CtF | Assets, workers, Wasm, storage, networking, audio, controllers, voice | Pinned CtF client passes the complete game flow with unchanged source |
| M5 — CLI and desktop builds | Project detection, build/run/check, artifacts and distribution | One CLI invocation orchestrates builds for supported OS/architecture targets |
| M6 — Performance and developer preview | Profiles, regressions, docs, debug workflow and release gates | Reproducible results and installable artifacts on clean desktop machines |
| Future — Broader platforms and tooling | Mobile, architectures, XR/video, optional engine/editor tooling | Separate evidence-backed proposals; no implied support |

## Sequence and decision gates

1. Establish compatibility contracts and dependency/ownership boundaries.
2. Prove the Rust/JS/native surface path while investigating HTML and WebGL reuse.
   DOM integration and GPU interoperability are early feasibility questions.
3. Prove unchanged WebGL projects and an interactive DOM compositor. A native cube
   alone is not evidence that an unchanged web project can run.
4. Add required services and validate the pinned CtF client, including its network
   worker, menus, audio and voice. Its remote game and voice services remain
   separate unless explicitly configured as packaged services.
5. Complete desktop packaging and clean-machine tests. CLI analysis can start
   earlier; its success claims depend on the runtime compatibility profile.
6. Ship a documented preview after compatibility and performance gates pass.

M1 is a useful integration spike; WebGPU-only support does not satisfy the product
goal. M2 and M3 are mandatory. A no-change build must not silently substitute a
Three.js renderer or require an application rewrite.

## Shared definition of done

Each implementation issue needs observable acceptance criteria, relevant fixtures,
useful errors, documented public behavior, and deliberate dependency boundaries.
Document public APIs, ownership/thread invariants and surprising decisions. Remove
comments that restate the code. See [engineering standards](engineering.md).

GPU claims require hardware evidence; CI compilation is separate. Platform claims
name the OS, architecture, backend and driver tested. Performance claims follow
[the measurement protocol](benchmarks.md). Shipping requires source preservation
and functional compatibility evidence as well as speed measurements.

No deadlines are inferred from issue order. Broad browser API compatibility is
sustained systems work, not a packaging trick.
