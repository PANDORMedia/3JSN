# Compatibility boundary

“Uses Three.js” does not mean every existing browser application works unchanged.
The product goal is unchanged source within a versioned compatibility profile.
Only features with local evidence become support claims. WebGL and HTML/DOM are
required work, not optional migrations for the application.

| Capability | Evidence now | Planned treatment |
| --- | --- | --- |
| Three.js scene/mesh/camera | Shared JS fixture, used by the Dawn probe | Preserve upstream behavior |
| PBR material and basic lights | Small `MeshStandardMaterial` scene in offscreen probe | Broaden visual fixtures |
| WebGPU renderer | Pinned Three.js 0.186.0, external device/context | First shipping renderer candidate |
| Rust native GPU device | Independent wgpu diagnostic | Integrate with JS-owned device/surface |
| Rust-hosted JavaScript/WebGPU | V8 module/event/error tests and Metal triangle pixels pass | Native surface/presentation and broader WebGPU fixtures remain |
| Window, swapchain, resize, DPI | [Opaque Three.js window presents on macOS/Metal](validation/2026-09-18-visible-window.md); resize/DPI and broader lifecycle gates open | M1; see [window contract](native-window.md) |
| TSL custom materials, compute, instancing | Not yet tested here | Add dedicated fixtures |
| WebGLRenderer, raw GLSL ShaderMaterial/onBeforeCompile | Not implemented | Required WebGL/GLSL binding and native translation track; preserve source |
| glTF, animation, textures | Not yet tested here | Native asset I/O and decoding; regression scenes |
| Draco, KTX2/Basis, other Wasm decoders | Not implemented | Worker/Wasm and binary asset integration |
| requestAnimationFrame | Host-driven scheduler and bounded lifecycle checks | Validate native presentation/input timing |
| Keyboard, pointer, gamepad | Not implemented | winit events; explicit gamepad service |
| DOM-based controls | Bounded V8/Blitz DOM identity, mutations, geometry and programmatic events | Complete compatible event, focus and physical input semantics |
| HTML/CSS UI, CSS2D/3DRenderer | Live HTML GPU paint and [DOM canvas probe](validation/2026-09-18-canvas-handoff.md); ancestor clipping still fails | Shipping integration, full paint/DOM behavior; CSS2D/3DRenderer still untested |
| Web Audio / Three.js Audio | Not implemented | Evaluate native mixer/binding |
| WebRTC, microphone capture, MediaRecorder | Not implemented | Required CtF voice track; permissions, device and connection lifecycle |
| fetch, local files, saves | Host implementation not present | Explicit asset/save services and selected web APIs |
| npm packages | Bounded CLI bundles upstream Three.js and a React DOM fixture; arbitrary package compatibility unverified | Audit browser/Node dependencies and observable APIs |
| Workers, SharedArrayBuffer, WebAssembly | Not validated in proposed embedded host | Implement/test as concrete features need them |
| React DOM | [Bounded upstream React 19.3.0 fixture](validation/2026-09-18-react-dom.md); tested React observations match Chrome and both parser modes present 120 Metal frames; one generic DOM lookup difference remains | Shared generic DOM; broader framework behavior remains open |
| React Three Fiber | Not evaluated | Separate compatibility milestone if demanded |
| WebXR / video / camera | Out of initial scope | Platform-specific later research |

## React DOM checkpoint scope

Upstream React DOM operates on the existing authoritative native document. The
[checkpoint](validation/2026-09-18-react-dom.md) verifies asynchronous renders and
effects, delegated synthetic clicks, keyed mutation and identity, style/text
updates, cleanup and remount. Both relocated parser-mode packages complete React
verification and present 120 Metal frames with network/development reads denied.
The tested React observations match Chrome in CPU and window runs.

The independent generic DOM checks retain one ID/name-collision discrepancy:
native collection lookup returns the first matching element while the tested
Chrome returns the second. `knownDifferences` records this same case four times,
across both parser modes and CPU/window execution. The harness compares other
observations strictly and explicitly reports incomplete overall semantic parity.

This does not certify React, SSR/hydration, Suspense, portals, forms/selection,
accessibility, other web libraries or native OS input. Effect cleanup does not
prove garbage collection: native nodes and wrappers remain retained until realm
teardown. Pixel equivalence, bounded memory across repeated mounts and performance
remain separate gates. A [custom reconciler host](react-ui.md) is a research
option only; the current path uses upstream React DOM and shared generic APIs.

## Platform targets

| Platform | Intended API | Verified locally | Release status |
| --- | --- | --- | --- |
| macOS arm64 | Metal | See dated validation for individual probes | Research only |
| macOS x64 | Metal | None | Planned |
| Windows x64 | D3D12 for WebGPU; WebGL backend/interop to select | None | Planned |
| Linux x64: X11 and Wayland | Vulkan | None | Planned; each window system needs validation |
| Windows/Linux arm64 | Platform native GPU API | None | Later evaluation |
| Android / iOS | Vulkan / Metal where available | None | Later lifecycle, packaging and JS execution-policy research |
| Consoles | Platform-dependent | None | No support promise; SDK access and platform work required |

Desktop support will name minimum OS versions, architectures, drivers and GPUs
after hardware testing. A dependency supporting a platform does not certify 3JSN.
Compilation in CI does not establish native window, input or GPU correctness.

Compatibility extends beyond rendering. See the [CtF inventory](ctf-compatibility.md)
for the source-inspected acceptance target, including WebRTC and separate services.
