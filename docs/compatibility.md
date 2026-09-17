# Compatibility boundary

“Uses Three.js” does not mean every existing browser application works unchanged.
Only features with local evidence should become support claims.

| Capability | Evidence now | Planned treatment |
| --- | --- | --- |
| Three.js scene/mesh/camera | Shared JS fixture, used by the Dawn probe | Preserve upstream behavior |
| PBR material and basic lights | Small `MeshStandardMaterial` scene in offscreen probe | Broaden visual fixtures |
| WebGPU renderer | Pinned Three.js 0.186.0, external device/context | First shipping renderer candidate |
| Rust native GPU device | Independent wgpu diagnostic | Integrate with JS-owned device/surface |
| Window, swapchain, resize, DPI | Not implemented | M1 |
| TSL custom materials, compute, instancing | Not yet tested here | Add dedicated fixtures |
| WebGLRenderer, raw GLSL ShaderMaterial/onBeforeCompile | Not targeted by initial WebGPU route | Migration to compatible TSL/node materials or separate compatibility work |
| glTF, animation, textures | Not yet tested here | Native asset I/O and decoding; regression scenes |
| Draco, KTX2/Basis, other Wasm decoders | Not implemented | Worker/Wasm and binary asset integration |
| requestAnimationFrame | Manual scheduler in offscreen probe only | Native redraw scheduling |
| Keyboard, pointer, gamepad | Not implemented | winit events; explicit gamepad service |
| DOM-based controls | Not supported | Small event adapter or engine-native controls |
| HTML/CSS UI, CSS2D/3DRenderer | Out of initial scope | Rendered game UI or separate authoring tool |
| Web Audio / Three.js Audio | Not implemented | Evaluate native mixer/binding |
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
| Windows x64 | D3D12 | None | Planned |
| Linux x64: X11 and Wayland | Vulkan | None | Planned; each window system needs validation |
| Windows/Linux arm64 | Platform native GPU API | None | Later evaluation |
| Android / iOS | Vulkan / Metal where available | None | Later lifecycle, packaging and JS execution-policy research |
| Consoles | Platform-dependent | None | No support promise; SDK access and platform work required |

Desktop support will name minimum OS versions, architectures, drivers and GPUs
after hardware testing. A dependency supporting a platform does not certify 3JSN.
Compilation in CI does not establish native window, input or GPU correctness.
