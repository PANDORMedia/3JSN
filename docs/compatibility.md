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
| Window, swapchain, resize, DPI | Not implemented | M1 |
| TSL custom materials, compute, instancing | Not yet tested here | Add dedicated fixtures |
| WebGLRenderer, raw GLSL ShaderMaterial/onBeforeCompile | Not implemented | Required WebGL/GLSL binding and native translation track; preserve source |
| glTF, animation, textures | Not yet tested here | Native asset I/O and decoding; regression scenes |
| Draco, KTX2/Basis, other Wasm decoders | Not implemented | Worker/Wasm and binary asset integration |
| requestAnimationFrame | Manual scheduler in offscreen probe only | Native redraw scheduling |
| Keyboard, pointer, gamepad | Not implemented | winit events; explicit gamepad service |
| DOM-based controls | Not implemented | Compatible event, focus, geometry and pointer semantics |
| HTML/CSS UI, CSS2D/3DRenderer | Not implemented | Required DOM/layout/text/paint/compositor research and implementation |
| Web Audio / Three.js Audio | Not implemented | Evaluate native mixer/binding |
| WebRTC, microphone capture, MediaRecorder | Not implemented | Required CtF voice track; permissions, device and connection lifecycle |
| fetch, local files, saves | Host implementation not present | Explicit asset/save services and selected web APIs |
| npm packages | Node research tooling only | Bundle runtime-compatible JS; audit native/Node dependencies |
| Workers, SharedArrayBuffer, WebAssembly | Not validated in proposed embedded host | Implement/test as concrete features need them |
| React Three Fiber | Not evaluated | Separate compatibility milestone if demanded |
| WebXR / video / camera | Out of initial scope | Platform-specific later research |

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
