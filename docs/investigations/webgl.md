# WebGL2 / GLSL native integration investigation

Date: 2026-09-17. Tracks [issue #19](https://github.com/PANDORMedia/3JSN/issues/19).
Status: rendering and ANGLE/native Metal texture composition demonstrated on one
Mac; no shipping backend selected. Rust/JS/wgpu integration remains unverified.

## Recommendation

Keep the application boundary at `HTMLCanvasElement.getContext('webgl2')` and the
standard WebGL objects. Preserve upstream Three.js and its generated/custom GLSL.
Use ANGLE as the leading GLES/native translation candidate. Evaluate reuse of
headless-gl's JS validation/object layer before writing a complete replacement,
but do not adopt its current experimental Node binding as the shipping runtime.

The concrete next gate is a Rust/V8 context with a native-owned output texture
that the selected compositor reads on the GPU. The separate native Metal proof
below settles a useful low-level ownership path, but does not show that wgpu or
the JS binding implements it. Keep the shared GPU contract open while the WebGPU
host and HTML renderer are investigated.

## Executed evidence

The original [probe and instructions](../../experiments/native-webgl/README.md)
are committed; downloads and compiled candidate libraries stay in ignored cache.
The [sanitized report](../validation/2026-09-17-webgl-metal.json) records hashes,
versions, native renderer identity and individual test results.

| Observation | Result | What it establishes |
| --- | --- | --- |
| `gl@9.0.0-rc.10` small Node addon build | Completed on Node 24.13.0 / macOS 26.1 arm64 | Candidate can load its packaged ANGLE libraries here |
| Explicit Metal selection | ANGLE Metal Renderer: Apple M1 Pro | This run used ANGLE's Metal backend |
| GLSL ES 3.00 shader using `gl_VertexID` | 16,384 expected pixels | Native ES3 shader/draw/readback path works |
| Upstream Three.js r186 WebGLRenderer PBR cube | 4,096 foreground pixels; 4,824 pixels changed between frames | A small Three.js WebGL workload works without renderer edits |
| `getBufferSubData` after uploading `[3,5,7,9]` | Returned `[0,0,0,0]`, with `NO_ERROR` | Real API incompatibility, not a successful readback |
| Public context/shader version strings | Still report WebGL 1 / GLSL ES 1 | Capability reporting is incorrect for the ES3 context |

The initial default backend was OpenGL 4.1. Setting `ANGLE_DEFAULT_PLATFORM=metal`
selected Metal; the probe rejects a mismatched renderer. ANGLE supports this
environment selection in its [display implementation](https://github.com/google/angle/blob/f93135b2e16e9d6bec15a9059c5ce3864adc59b2/src/libANGLE/Display.cpp).
Production should choose the backend through explicit EGL display attributes
and return structured failure instead of relying on a process environment default.

These are offscreen correctness measurements with a synthetic host canvas. They
do not prove DOM integration, native presentation, CtF compatibility, Windows or
Linux support, WebGL conformance, or a speed advantage. The known failing checks
are recorded as failures even though the exploratory process completes normally.

## Reuse options

| Candidate | Useful component | Integration cost / decision |
| --- | --- | --- |
| ANGLE | Maintained GLES, GLSL validation/translation, native backends and EGL | Leading translation candidate. It does not implement JS WebGL or the DOM. |
| headless-gl 9 prerelease | Existing WebGL wrappers, object ownership checks, extensions and native ES3 binding | Experimental baseline and potential upstream collaboration. Audit incomplete semantics; separate the Node ABI from any reusable JS. |
| Babylon Native | Native JS hosting, resource and engine integration experience | Not a Three.js WebGL binding. Its graphics boundary is Babylon's `NativeEngine`, above WebGL. |
| Mystral Native | Native JS/WebGPU host and Three.js experience | Useful WebGPU comparison; inspected tree exposes WebGPU binding/context code, not a WebGL2 binding. |
| A full web engine | Existing DOM, canvas and WebGL semantics in one engine | Architectural alternative if component integration is too costly; requires reevaluating JS engine, embedding and distribution. |

Babylon's [NativeEngine design](https://github.com/BabylonJS/BabylonNative/blob/bb01e283d83da8c043000862c76d9315f76c7a67/Documentation/NativeEngine.md)
explicitly chooses a Babylon-specific boundary and bgfx. Replacing Three.js's
renderer with a similar proprietary protocol would create another renderer to
maintain and would not satisfy arbitrary WebGL use. The inspected
[Mystral tree](https://github.com/mystralengine/mystralnative/tree/fd2d1260206c25bb7137954cbe9563210947232c/src/webgpu)
is relevant to a different binding path.

headless-gl's current [README](https://github.com/stackgl/headless-gl/blob/7f7338de35889e7c51c3f495a956bf5a110d4b51/README.md)
calls WebGL2 experimental. Its generic conformance statement must not be read as
evidence that this prerelease passes WebGL2. Source inspection found
`getBufferSubData` unimplemented, context loss reporting fixed to false and
compressed image upload methods empty. The first is also reproduced above.
See the [native binding](https://github.com/stackgl/headless-gl/blob/7f7338de35889e7c51c3f495a956bf5a110d4b51/src/native/webgl.cc)
and [JS wrapper](https://github.com/stackgl/headless-gl/blob/7f7338de35889e7c51c3f495a956bf5a110d4b51/src/javascript/webgl-rendering-context.js).
These pinned upstream files were inspected separately from the tested npm
artifact; the report identifies that artifact and its bundled ANGLE revision.

## Proposed Rust / V8 boundary

This is a proposal, not implemented support:

1. The DOM owns canvas identity, dimensions, events and context-mode selection.
   Repeated `getContext` returns the same compatible object; incompatible mode
   requests fail according to the web contract.
2. A small WebGL extension owns JS object wrappers, argument conversion,
   per-context state and errors. A V8/Rust op layer holds native resources behind
   generation-checked handles. No raw pointer or numeric GL name escapes to games.
3. The native WebGL module owns EGL display/context and GLES entry points. It
   explicitly requests ES3, WebGL compatibility and robust resource initialization
   where available. ANGLE owns GLSL translation and driver workarounds.
4. Each drawing buffer yields a compositor frame with size, format, alpha/color
   meaning and a synchronization/lifetime lease. GL's default framebuffer maps to
   that drawing buffer, not directly to an independently presented window.
5. The platform module owns presentation. Context loss, resize, GPU completion,
   GC and explicit disposal must converge on one native teardown owner.

The candidate uses NAN and `NODE_MODULE`, plus Node module loading. An embedded
V8 isolate in `deno_core` does not automatically host that Node addon ABI. Reuse
would require extracting/adapting the wrapper and replacing native methods, or
choosing an embedded Node host explicitly. The latter is a real architecture
tradeoff, not a small package import. Keep a bounded upstreamable adapter and
measured call/typed-array costs; avoid a broad fork or a second command protocol
before evidence shows it necessary.

## WebGL semantics that GLES does not supply

ANGLE's [WebGL-compatible context mode](https://github.com/google/angle/blob/f93135b2e16e9d6bec15a9059c5ce3864adc59b2/extensions/EGL_ANGLE_create_context_webgl_compatibility.txt)
adds GLES validation relevant to WebGL. It cannot provide JavaScript object
identity, DOM uploads, canvas presentation or event semantics. The
[WebGL 1 specification](https://registry.khronos.org/webgl/specs/latest/1.0/)
and [WebGL 2 specification](https://registry.khronos.org/webgl/specs/latest/2.0/)
remain the behavior reference; these latest pages are editor's drafts and must
be pinned when selecting a conformance corpus.

The binding/profile needs explicit tests for:

- WebIDL overloads/coercions, typed-array view offsets and lengths, detached data,
  nullable values and correctly typed results.
- Context-owned resource identity, cross-context rejection, deletion while bound,
  program relinking and uniform-location invalidation.
- Error flags versus JavaScript exceptions; limits, extension discovery and
  extension availability consistent with enabled native support.
- Buffer initialization/range validation, framebuffer completeness, default
  framebuffer attributes, multisampling and `preserveDrawingBuffer` behavior.
- Image/canvas/ImageBitmap upload sources, unpack alignment/rows, flip-Y,
  premultiplication, color conversion and origin-clean restrictions.
- Queries/sync/readback, context loss/restoration and canvas resize behavior.

These are required compatibility work. A passing Three.js scene does not authorize
removing validation that a different unchanged application depends on.

## GPU composition: native Metal evidence and remaining integration

The [native interop reproduction](../../experiments/native-webgl-interop/README.md)
uses the already downloaded ANGLE libraries without upstream patches. It queries
ANGLE's exact Metal device, imports a private `MTLTexture` as an EGLImage/GL
framebuffer, then runs a native Metal compute pass on an independent queue to
read that texture and blend into another private texture. Producer/consumer reuse
is protected by bidirectional GPU shared-event waits/signals; eight alternating
frames are queued before CPU verification. The host explicitly enables the
requestable image extension inside ANGLE's WebGL-compatible GLES context.

The [recorded result](../validation/2026-09-17-webgl-metal-interop.json) passed 96
frames, 12 texture generations over three extents, and 155,648 final pixels with
Metal API Validation reporting that it was enabled. Only final composed pixels
were read back for assertions. There was no CPU image transport between producer
and consumer. This Objective-C++ probe does not embed Rust, wgpu or the JS binding;
none of those integrations is inferred from the native result.

| Target | Source-supported route | Integration that still needs execution evidence |
| --- | --- | --- |
| macOS / Metal | Verified private `MTLTexture` import, native compute composition and bidirectional shared-event handoff | Rust/JS/wgpu adoption, full format/color-space policy, presentation and failure recovery |
| Linux / Vulkan | Query ANGLE's device/queue; EGLImage import/export of `VkImage`; GL texture acquire/release layout handoff | Device creation/features accepted by both libraries, queue synchronization, layout/state tracking, and X11/Wayland presentation |
| Windows | ANGLE's supported D3D11 or Vulkan paths | D3D11 and the WebGPU host's D3D12 do not automatically share resources; compare an explicit cross-API sharing design with using Vulkan for both |

ANGLE's [Metal texture extension](https://github.com/google/angle/blob/f93135b2e16e9d6bec15a9059c5ce3864adc59b2/extensions/EGL_ANGLE_metal_texture_client_buffer.txt)
requires the imported texture to use the device queried from the display when
the Metal device extension exists. Its
[shared-event synchronization extension](https://github.com/google/angle/blob/f93135b2e16e9d6bec15a9059c5ce3864adc59b2/extensions/EGL_ANGLE_metal_shared_event_sync.txt)
defines explicit native completion and ownership. Having the same physical GPU
is insufficient to skip these checks.

The [Vulkan image extension](https://github.com/google/angle/blob/f93135b2e16e9d6bec15a9059c5ce3864adc59b2/extensions/EGL_ANGLE_vulkan_image.txt)
requires the same `VkDevice` for image import. The
[device extension](https://github.com/google/angle/blob/f93135b2e16e9d6bec15a9059c5ce3864adc59b2/extensions/EGL_ANGLE_device_vulkan.txt)
exposes device/queue information and queue locking, while
[texture acquire/release](https://github.com/google/angle/blob/f93135b2e16e9d6bec15a9059c5ce3864adc59b2/extensions/ANGLE_vulkan_image.txt)
addresses GL/Vulkan layout handoff. None establishes that an unrelated wgpu device
can consume an arbitrary image handle. The wgpu version selected by the runtime
must be audited for device-import, texture-import and external synchronization
contracts before implementing unsafe interop.

ANGLE also contains a WebGPU backend and
[device-query extension](https://github.com/google/angle/blob/f93135b2e16e9d6bec15a9059c5ce3864adc59b2/extensions/EGL_ANGLE_device_webgpu.txt).
Its presence does not establish readiness: the inspected
[support matrix](https://github.com/google/angle/blob/f93135b2e16e9d6bec15a9059c5ce3864adc59b2/README.md)
does not list a completed platform for that backend. Do not build the initial
compatibility promise around it without conformance and performance evidence.

Extend the verified Metal path into the selected Rust/compositor stack while
preserving its ownership and synchronization requirements. Test presentation,
window resize and loss/recovery separately; texture allocation at several sizes
does not establish those lifecycle behaviors. The native proof uses asynchronous
GPU fences without claiming their overhead or a performance gain. Presentation
must not shuttle frames through CPU readback.

## Build, licensing and upkeep

ANGLE's standalone [build instructions](https://github.com/google/angle/blob/f93135b2e16e9d6bec15a9059c5ce3864adc59b2/doc/DevSetup.md)
use Python, depot_tools/gclient, GN/Ninja and platform SDKs. Disable unused native
backends deliberately, pin the complete dependency graph and record the compiler,
SDK and build arguments. Cache signed/hashed target runtime artifacts for CLI
users instead of making every game build compile ANGLE. No full source build,
build-time measurement or minimum-OS verification was performed here.

The tested package's universal macOS ANGLE libraries contain 490,880 bytes of EGL
and 15,068,592 bytes of GLES; the locally built arm64 addon is 658,184 bytes.
That is 16,217,656 bytes before JS engine, DOM, assets, packaging or compression.
It is an observation about this artifact, not a size forecast for the runtime.
Its ANGLE reports revision `ac6cda4cbd71`, distinct from current upstream inspected
revision `f93135b2e16e9d6bec15a9059c5ce3864adc59b2`.

ANGLE has a [BSD-style license](https://github.com/google/angle/blob/f93135b2e16e9d6bec15a9059c5ce3864adc59b2/LICENSE);
headless-gl records [BSD-2-Clause and bundled ANGLE notices](https://github.com/stackgl/headless-gl/blob/7f7338de35889e7c51c3f495a956bf5a110d4b51/LICENSES).
Retain notices and audit transitive/runtime artifacts for each actual build.
This source inventory is not a completed distribution-license audit. The
candidate's published dependency installer also warns that `prebuild-install`
is unmaintained; future reuse must own a reproducible packaging strategy rather
than depending indefinitely on that installer.

## Remaining issue gates

The [follow-on Rust experiment](../../experiments/native-webgl-wgpu/README.md)
also consumes the ANGLE texture through wgpu-core 29.0.1 on Metal, with exact
native-device identity and explicit ordering on wgpu's own queue. Its
[96-frame validation](../validation/2026-09-17-webgl-wgpu-metal.json) proves an
isolated Rust import path. It does not yet use Deno's actual registry or expose
WebGL to the shipping JS realm.

1. Replace or extract the Node-specific binding into the selected JS host without
   changing the Three.js fixture. Bound the adapter and document its ownership.
2. Adapt the verified native Metal texture handoff into the selected Rust/JS/wgpu
   ownership model. Keep the isolated native result separate from that still
   unproved integration and evaluate other backends independently.
3. Turn observed API defects into regression fixtures and decide upstream fixes
   versus a maintained alternative before adopting the JS layer.
4. Exercise CtF's pinned Three.js version, custom shaders, post-processing,
   multicanvas and texture uploads. r186 PBR evidence does not cover those features.
5. Run target-specific Windows and Linux probes and relevant WebGL conformance
   tests before updating the supported-platform/profile tables.
