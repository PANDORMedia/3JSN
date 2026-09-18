# Upstream Three.js WebGL mesh draws — 2026-09-18

The Rust/V8 ANGLE bridge now renders a Three.js r186 scene with an indexed
`BoxGeometry`, its nonindexed equivalent, `MeshBasicMaterial`, `ShaderMaterial`,
`onBeforeCompile` and `MeshNormalMaterial`. Upstream Three.js source is bundled
without renderer or shader patches. The harness injects a canvas/context through
the public constructor; this remains an offscreen test, not unchanged web-project
packaging or DOM/native-window integration.

![Native MeshNormalMaterial capture](2026-09-18-webgl-mesh/normal.png)

## Verified behavior

On Apple M1 Pro with Metal API validation enabled, rotation changes **1,221 pixels**
in a 128 × 128 frame. Indexed and equivalent nonindexed draws are byte-identical.
The basic material center is `[255,136,34,255]`; custom GLSL produces
`[26,77,229,255]`; `onBeforeCompile` produces `[0,255,0,255]`. The normal material
produces three distinct face colors. [Report](2026-09-18-webgl-mesh/mesh.json).

A separate real-GPU control verifies typed-array and source offsets, actual
`bufferSubData` geometry changes, index-store bounds, ANGLE's rejection of an
undersized enabled vertex buffer, and mandatory native buffer bindings for
pointer-shaped calls. Uniform controls cover context/program identity, relink
invalidation, matrix length/transpose rejection, signed integer subviews,
reentrant value conversion and deferred deletion of the current program.
[Result](2026-09-18-webgl-mesh/draw-boundaries.json).

Nineteen [CPU tests](2026-09-18-webgl-mesh/cpu-tests.txt), strict all-target
[Clippy](2026-09-18-webgl-mesh/clippy.txt) and formatting pass. The earlier
[initialization](2026-09-18-webgl-mesh/initialization-regression.json) and
[ownership](2026-09-18-webgl-mesh/ownership-regression.json) GPU probes also pass.
The pinned ANGLE artifact and robust-initialization assumptions are unchanged
from the [initialization checkpoint](2026-09-18-webgl-runtime.md).

The buffer-subdata error distinction follows the
[Khronos WebGL specification](https://registry.khronos.org/webgl/specs/latest/1.0/):
out-of-store writes report `INVALID_VALUE`; rejected indexed draw ranges report
`INVALID_OPERATION`. Tests retain this distinction rather than accepting any error.

## Remaining scope

No DOM canvas registration, compositor surface, native window, platform executable
build or other-OS GPU evidence is added. The partial API still excludes many
texture/format/extension/render-target paths, context loss and complete WebIDL
behavior. It is not a certified WebGL profile. Uniform location registry entries
remain until context disposal, and pending-deleted shader wrapper queries need
completion. Buffers have a 64 MiB per-store cap; uniform inputs have a 1,048,576
scalar cap. There is no aggregate allocation quota or performance benchmark.

Readback produces these test observations only. The window path must use native
texture sharing rather than CPU pixel transport. Next is connecting the native
WebGL canvas to the existing DOM/window host, while widening the independent
material and lifecycle controls.

[Source identities](2026-09-18-webgl-mesh/source-identities.json) and
[reproduction commands](../../experiments/webgl-runtime/README.md).
