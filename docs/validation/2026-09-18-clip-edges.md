# Clip-edge composition diagnostic

The ownership renderer changes clipped edge colors when an earlier opaque fill
is completely covered by a later opaque fill. Chrome preserves the complete
image for the polygon and several opacity controls. This is a reproducible
composition gap beyond different antialias kernels: each pair is compared within
one renderer, holding its geometry and visible opaque source image constant.

No runtime code, dependency or patch changes in this checkpoint. The preserved
`0ba4dee23eec0eb778e1355df99a08e8a27b2cb5` ownership binary is tested directly.
It remains the unadopted eleven-patch candidate. No issue is closed.

## Controls and results

The original [fixture](../../fixtures/clip-edges/README.md) contains 22 ordered
captures, 15 states and nine proposed image-invariance groups. A hidden underlay
becomes red or blue beneath a coincident opaque red rectangle. Both extend beyond
the clip; their own edges cannot account for the changed clipping boundary.
Geometry, clip and opacity remain fixed within each pair. DPR 1/2 and restored
initial styles are included. No text, assets, fonts or private game material.

Chrome 153.0.8010.50, revision `583c5b4655acea7450a3b5224ea5121ae8caca9b`,
and native offscreen Metal on Apple M1 Pro each ran twice in fresh processes.
All 22 case payloads, pixel hashes and comparison groups repeat exactly within
each renderer. Native paint runs once per case, with no GPU errors; the repeat
log confirms Metal API validation. All images are opaque over white: this is RGB
composition evidence, not independent output-alpha evidence.

| Proposed group | Chrome identical? | Native identical? | Changed pixels, Chrome / native | Largest channel change, Chrome / native |
| --- | --- | --- | --- | --- |
| Polygon, 1×, covered blue | Yes | No | 0 / 669 | 0 / 56 |
| Polygon, 2×, covered blue | Yes | No | 0 / 1,339 | 0 / 56 |
| Rounded overflow, 1×, duplicate red | No | No | 180 / 224 | 56 / 56 |
| Rounded overflow, 2×, duplicate red | No | No | 360 / 456 | 56 / 56 |
| Fractional inset, 1×, covered blue | No | No | 696 / 696 | 52 / 55 |
| Polygon with opacity 0.5, 1×, covered blue | Yes | No | 0 / 677 | 0 / 28 |
| Nested polygons, 1×, covered blue | Yes | No | 0 / 650 | 0 / 56 |
| Rounded overflow around inner opacity, 1×, covered blue | Yes | No | 0 / 228 | 0 / 28 |
| Rounded overflow around inner opacity, 2×, covered blue | No | No | 11 / 456 | 1 / 28 |

Counts compare the named variant against its single-fill reference, not between
renderers. The reports also retain duplicate-red polygon and restoration pairs.
Chrome has **5/9 exact groups**, native **0/9**. Both native restoration captures
are byte-identical to their initial states. Every single-fill reference has
intermediate colors as well as more than 100 visible subject pixels.

Chrome's last row differs only at x=96, y=205…215 by one channel value:
`[239,144,152,255]` becomes `[239,143,151,255]`. This repeats in both sessions.
It remains an exact-equality failure; its cause is not established. The secondary
greater-than-two count is zero for that browser pair and 396 for native. No
tolerance is used to convert the exact result into a pass.

The existing independent comparator reports **22/22 geometry and uniform-interior
matches**. Its deliberate raster-edge exclusion explains why it misses these
differences. This does not retroactively change the prior 142-case interior
result, and no full-image browser/native parity is claimed.

## Evidence and safeguards

- [Browser captures](2026-09-18-clip-edges/browser/report.json) and
  [native captures](2026-09-18-clip-edges/ownership-baseline/report.json).
- [Browser groups](2026-09-18-clip-edges/browser-invariants.json),
  [native groups](2026-09-18-clip-edges/ownership-baseline-invariants.json), and
  [geometry/interior comparison](2026-09-18-clip-edges/ownership-baseline-comparison.json).
- [Repeatability](2026-09-18-clip-edges/repeatability.json), with complete second
  capture sets, and [source/binary identity](2026-09-18-clip-edges/source-identity.json).

The new [comparator](../../experiments/dom-canvas/compare-clip-invariants.mjs)
checks fixture hashes, ordered capture identity, physical dimensions, decoded
RGBA hashes, visible subject, native paint/GPU records, equal pair geometry,
distinct group members and complete capture coverage. It compares every RGBA
byte with zero tolerance. Its intermediate-color guard is specific to these
monochrome controls over the declared flat background, not a general edge finder.
Reports include changed counts, maximum channel delta, inclusive difference bounds
and the first differing pixel. Invalid evidence aborts without writing a report;
a valid but nonidentical group returns exit 1.

Fifteen comparator tests cover exact equality, outermost/alpha-only one-byte
changes, aliased references, stale pixels/source, invisible subjects, changed
geometry, GPU errors, duplicate members, omitted captures, difference bounds and
missing scales. Source/document checks and all 36 JavaScript tests pass. The first
sandboxed suite attempt blocked three existing loopback-server tests with
`listen EPERM`; the full rerun with loopback access passed. The prepared candidate's
read-only identity check also passes using the pinned `CARGO_HOME`. Rust is unchanged and was not
rebuilt. The previous checkpoint's source CI passed macOS, Linux and Windows;
that does not certify GPU rendering on those platforms.

## Interpretation and next boundary

The [CSS Masking model](https://www.w3.org/TR/css-masking-1/#module-interactions)
describes effects on composed content, without specifying a byte-exact antialias
kernel. The tested Chromium source has both ordinary anti-aliased raster clips
and compositor mask groups: see its
[raster conversion](https://chromium.googlesource.com/chromium/src/+/583c5b4655acea7450a3b5224ea5121ae8caca9b/third_party/blink/renderer/platform/graphics/compositing/paint_chunks_to_cc_layer.cc#573)
and [synthetic clipping effects](https://chromium.googlesource.com/chromium/src/+/583c5b4655acea7450a3b5224ea5121ae8caca9b/third_party/blink/renderer/platform/graphics/compositing/property_tree_manager.cc#840).
This supports investigating distinct composition paths; it does not prove which
optimization produced each screenshot. Plain rounded and inset differences are
recorded browser behavior, not automatically standards violations.

The native traversal currently opens and closes the full clip route for every
contribution inside an opacity group. Vello's
[pinned fine shader](https://github.com/linebender/vello/blob/fc0baddd06c63287ef516180d276333aa2401e6e/vello_shaders/shader/fine.wgsl#L1120)
applies coverage when a layer closes;
moving that scope changes compositing semantics. The next bounded proposal is
to factor a proven common clip prefix at existing opacity effects, preserving
escape eligibility, one opacity operation and paint order. Alpha-one polygon
grouping is a separate follow-up. The
[design boundary](../investigations/paint-ownership.md#next-clip-composition-experiment)
lists required controls. Neither repair is implemented here. Text, input,
scrolling, geometry failures, native presentation and the maintenance decision
remain open alongside this defect.
