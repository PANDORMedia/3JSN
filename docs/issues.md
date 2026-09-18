# Roadmap issues

[Repository](https://github.com/PANDORMedia/3JSN) · [Project board](https://github.com/orgs/PANDORMedia/projects/4) · [Milestones](https://github.com/PANDORMedia/3JSN/milestones)

The roadmap contains eight epics and 45 work items. GitHub holds current status,
priorities and dependencies. Each work item has acceptance criteria and a native
parent link; blocking relationships are recorded in GitHub as well as issue bodies.
The additional paint regressions are children of the HTML painting work item;
ancestor clipping still blocks native composition. Verified research increments do not close the wider
shipping integration gates.

## M0 — Contract and architecture

[Tracking epic](https://github.com/PANDORMedia/3JSN/issues/1) · [Milestone](https://github.com/PANDORMedia/3JSN/milestone/1)

- [#9 Establish the OSS repository and executable native GPU research foundation](https://github.com/PANDORMedia/3JSN/issues/9)
- [#10 Specify the unchanged-source compatibility profile and CLI product contract](https://github.com/PANDORMedia/3JSN/issues/10)
- [#11 Pin the CtF acceptance snapshot and create redistributable compatibility fixtures](https://github.com/PANDORMedia/3JSN/issues/11)
- [#12 Define module ownership, public contracts and maintainability rules](https://github.com/PANDORMedia/3JSN/issues/12)
- [#13 Select and pin a sustainable native dependency and license strategy](https://github.com/PANDORMedia/3JSN/issues/13)

## M1 — Native Rust host

[Tracking epic](https://github.com/PANDORMedia/3JSN/issues/2) · [Milestone](https://github.com/PANDORMedia/3JSN/milestone/2)

- [#14 Embed the JavaScript runtime and bootstrap native WebGPU in Rust](https://github.com/PANDORMedia/3JSN/issues/14)
- [#15 Bind a native window surface to the JavaScript GPU instance](https://github.com/PANDORMedia/3JSN/issues/15)
- [#16 Render upstream Three.js in the Rust-hosted native window](https://github.com/PANDORMedia/3JSN/issues/16)
- [#17 Implement native frame scheduling with compatible event and microtask semantics](https://github.com/PANDORMedia/3JSN/issues/17)
- [#18 Handle resize, DPI, device loss, cancellation and deterministic shutdown](https://github.com/PANDORMedia/3JSN/issues/18)

## M2 — Unchanged WebGL projects

[Tracking epic](https://github.com/PANDORMedia/3JSN/issues/3) · [Milestone](https://github.com/PANDORMedia/3JSN/milestone/3)

- [#19 Evaluate native WebGL2/GLSL bindings and ANGLE interoperability](https://github.com/PANDORMedia/3JSN/issues/19)
- [#20 Implement the supported WebGL compatibility profile without renderer rewrites](https://github.com/PANDORMedia/3JSN/issues/20)
- [#21 Validate post-processing, multiple canvases and WebGL visual parity](https://github.com/PANDORMedia/3JSN/issues/21)

## M3 — HTML/CSS on the GPU

[Tracking epic](https://github.com/PANDORMedia/3JSN/issues/4) · [Milestone](https://github.com/PANDORMedia/3JSN/milestone/4)

- [#22 Evaluate the HTML/CSS stack and JavaScript DOM integration strategy](https://github.com/PANDORMedia/3JSN/issues/22)
- [#23 Implement live DOM and event bindings for the compatibility profile](https://github.com/PANDORMedia/3JSN/issues/23)
- [#24 Integrate CSS layout, fonts, text shaping and GPU painting](https://github.com/PANDORMedia/3JSN/issues/24)
- [#25 Connect native input, focus, forms, IME and accessibility to the DOM](https://github.com/PANDORMedia/3JSN/issues/25)
- [#26 Compose HTML, WebGL, WebGPU and Canvas surfaces on the native GPU](https://github.com/PANDORMedia/3JSN/issues/26)
- [#52 Preserve ancestor overflow clips for hoisted canvas paint nodes](https://github.com/PANDORMedia/3JSN/issues/52)
- [#53 Clear stale paint lists when an HTML stacking context is removed](https://github.com/PANDORMedia/3JSN/issues/53)

## M4 — Web services and CtF

[Tracking epic](https://github.com/PANDORMedia/3JSN/issues/5) · [Milestone](https://github.com/PANDORMedia/3JSN/milestone/5)

- [#27 Implement packaged asset loading, image decoding and font/SVG resources](https://github.com/PANDORMedia/3JSN/issues/27)
- [#28 Provide Canvas 2D and texture-upload compatibility](https://github.com/PANDORMedia/3JSN/issues/28)
- [#29 Support module workers, messaging, Wasm and decoder scheduling](https://github.com/PANDORMedia/3JSN/issues/29)
- [#30 Define application origin, storage, reload and permission semantics](https://github.com/PANDORMedia/3JSN/issues/30)
- [#31 Implement fetch/WebSocket compatibility and external-service configuration](https://github.com/PANDORMedia/3JSN/issues/31)
- [#32 Implement Web Audio, media playback and AudioWorklet behavior](https://github.com/PANDORMedia/3JSN/issues/32)
- [#33 Implement gamepad and native input compatibility across desktop targets](https://github.com/PANDORMedia/3JSN/issues/33)
- [#34 Evaluate and implement WebRTC, microphone capture and recording compatibility](https://github.com/PANDORMedia/3JSN/issues/34)
- [#35 Run the pinned CtF client unchanged through the full acceptance journey](https://github.com/PANDORMedia/3JSN/issues/35)

## M5 — CLI and desktop builds

[Tracking epic](https://github.com/PANDORMedia/3JSN/issues/6) · [Milestone](https://github.com/PANDORMedia/3JSN/milestone/6)

- [#36 Implement 3jsn check with actionable compatibility diagnostics](https://github.com/PANDORMedia/3JSN/issues/36)
- [#37 Integrate existing npm/Vite/workspace builds without editing application source](https://github.com/PANDORMedia/3JSN/issues/37)
- [#38 Implement 3jsn run/build orchestration and target configuration](https://github.com/PANDORMedia/3JSN/issues/38)
- [#39 Bring up and validate the native runtime on Windows x64](https://github.com/PANDORMedia/3JSN/issues/39)
- [#40 Bring up and validate Linux x64 on X11 and Wayland](https://github.com/PANDORMedia/3JSN/issues/40)
- [#41 Package reproducible native applications for every supported desktop target](https://github.com/PANDORMedia/3JSN/issues/41)

## M6 — Performance and developer preview

[Tracking epic](https://github.com/PANDORMedia/3JSN/issues/7) · [Milestone](https://github.com/PANDORMedia/3JSN/milestone/7)

- [#42 Establish browser/native compatibility and performance baselines](https://github.com/PANDORMedia/3JSN/issues/42)
- [#43 Optimize measured binding, upload, UI and frame-pacing bottlenecks](https://github.com/PANDORMedia/3JSN/issues/43)
- [#44 Add development reload, source maps and native diagnostics](https://github.com/PANDORMedia/3JSN/issues/44)
- [#45 Automate architecture, compatibility and documentation quality gates](https://github.com/PANDORMedia/3JSN/issues/45)
- [#46 Ship the documented desktop developer preview with release evidence](https://github.com/PANDORMedia/3JSN/issues/46)

## Future — Broader platforms and tooling

[Tracking epic](https://github.com/PANDORMedia/3JSN/issues/8) · [Milestone](https://github.com/PANDORMedia/3JSN/milestone/8)

- [#47 Investigate Android/iOS embedding, lifecycle and JavaScript execution constraints](https://github.com/PANDORMedia/3JSN/issues/47)
- [#48 Evaluate additional desktop architectures and handheld hardware](https://github.com/PANDORMedia/3JSN/issues/48)
- [#49 Assess console port feasibility and platform-specific requirements](https://github.com/PANDORMedia/3JSN/issues/49)
- [#50 Evaluate video, capture and XR compatibility profiles](https://github.com/PANDORMedia/3JSN/issues/50)
- [#51 Evaluate optional physics, engine helpers and editor integration](https://github.com/PANDORMedia/3JSN/issues/51)
