# WebGL canvas composition boundary

The actual DOM can now create the experimental WebGL2 context and render an
upstream Three.js fixture. Native-window composition is still implemented only
for WebGPU canvases. This document describes the next implementation boundary;
it is not evidence that WebGL frames already reach the window.

## Preserve application rendering state

Keep ANGLE's robust pbuffer as the application's default framebuffer. A host-only
snapshot uses a GPU blit into a private RGBA8 Metal texture, imported into ANGLE
through EGLImage and a hidden framebuffer. This avoids changing the meaning of
application `bindFramebuffer(..., null)` calls. Reuse the existing runtime EGL
owner; do not initialize the standalone interop probe's second global loader.

Save and restore separate read/draw framebuffer bindings, the default framebuffer
read-buffer selection, scissor enablement, and any active texture/bindings touched
during allocation. Do not drain application GL errors with `glGetError` at this
boundary. Check extents, format, completeness and native allocation failures
independently. Normalize origin and premultiplication exactly once in the host's
GPU conversion pass, with asymmetric-corner and transparent-content tests.

## Retain resources through queue completion

One export texture generation can hold one outstanding host lease. Retain its
Metal texture, event, EGLImage, framebuffer and display owner until every consumer
has completed. Signal production after ANGLE's snapshot blit; commit a wait on
the actual host wgpu Metal queue before creating its consuming encoder. Submit
conversion into a persistent host texture, then signal consumption. The next
snapshot waits before overwriting export storage; unrelated application rendering
to the pbuffer does not need that wait.

Use bounded event/sync storage and bounded teardown waits. If consumer completion
cannot be submitted, poison/retain that generation rather than allowing reuse or
reporting successful cleanup. Resize retires the old generation only after both
owners have drained. Keep this protocol inside one Rust adapter so application
JavaScript cannot misuse raw handles or partially release a lease.

## Bootstrap independently of the canvas API

Query ANGLE's actual MTLDevice through EGL device-query extensions. Select a
surface-compatible wgpu adapter/device with that exact native object identity;
adapter names are insufficient. Verify the host queue's device as well. Separate
ANGLE and wgpu queues are valid only with the explicit shared-event protocol.
Do not create a dummy application WebGPU canvas merely to obtain a compositor
device.

`WindowScene` should dispatch the real WebGPU or WebGL source adapter; both return
an ordinary host wgpu image for existing Painter registration and composition.
An ANGLE texture must never masquerade as a Deno GPUTexture. The previous
`native-webgl-wgpu` experiment proves the underlying native mechanisms on one Mac,
not this integrated runtime ownership protocol or image orientation.

## Acceptance evidence

Run the unchanged DOM Three fixture with overlapping transparent HTML, asymmetric
corners, untouched/partial drawing buffers, independent scissor/framebuffer state,
pending GL errors, resize/repeated generations and injected failure cleanup.
Read final composed pixels for assertions only; no producer-frame CPU readback or
upload may be used as transport. Then verify actual native-window presentation.
