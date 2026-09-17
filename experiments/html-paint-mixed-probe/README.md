# HTML paint with the runtime-compatible GPU dependency graph

This manifest compiles the existing HTML paint source unchanged while constraining
the native GPU crates to versions compatible with Deno WebGPU 0.226.0:

| Component | Version |
| --- | --- |
| Deno WebGPU | 0.226.0, compiled but not instantiated |
| Vello / AnyRender Vello | 0.10.0 / 0.14.0 |
| wgpu wrapper | 29.0.4 |
| wgpu-core / wgpu-types | 29.0.1 / 29.0.1, one version each |
| wgpu-hal | 29.0.4 |

The Metal run passed all original DOM, text, geometry and DPI assertions. Its six
PNG captures are byte-identical to the original all-29.0.4 run. Metal API
Validation was observed and no unexpected GPU errors were reported. No source
patches were needed. The manifest and lockfile here are byte-identical to those
used in the isolated validation directory; both locations have the same relative
path depth for the shared source.

Read the [recorded verification](../../docs/validation/2026-09-18-html-compatible-graph.json)
and the [original experiment](../html-paint/README.md) for fixtures, font input and
limits. This establishes dependency compatibility and painting correctness;
the painter still creates its own GPU device. Sharing the runtime's existing
registry, canvas textures, error handling and resource ownership remains open.

## Reproduce

Prepare the pinned font as described in the original experiment, then run from
the repository root on a Metal-capable Mac:

```sh
CARGO_BUILD_JOBS=2 MTL_DEBUG_LAYER=1 cargo run --locked \
  --manifest-path experiments/html-paint-mixed-probe/Cargo.toml -- \
  .cache/html-paint-probe/DejaVuSans.woff2 \
  .cache/html-paint-mixed-probe/output
```

The shared source's raw JSON has hardcoded core/types version labels of 29.0.4
from the original experiment. They are stale for this variant. Use this manifest,
lockfile and the verification report's `actualResolvedVersions` for the actual
mixed graph; do not publish the raw version labels as evidence. Pixel assertions
and image hashes are unaffected. No font or native library binary is published.
