# DOM geometry repair and positioned-layout evaluation

Date: 2026-09-18. Host: macOS arm64, Apple M1 Pro; Chrome 153.0.8010.50.
The default experiment now repairs geometry for elements that produce no boxes.
The larger upstream positioning candidate remains **unadopted**. Neither result
certifies a shipping DOM, native window or unchanged game.

## Maintained geometry repair

The [shared fixture](../../fixtures/dom-geometry/README.md) runs identical HTML
and JavaScript in Chrome and Rust-hosted V8. The pinned Blitz baseline passed
14 of 23 checks. Hidden descendants, `display:contents` and retained detached
subtrees could expose cached positions instead of an all-zero bounding rectangle.

The [small patch](../../experiments/dom-canvas/patches/blitz-boxless-geometry.patch)
checks box participation before reading cached layout or inline fragments.
`display:none` is checked through DOM ancestry; `display:contents` suppresses the
element's own box while leaving its descendants eligible. Detached nodes have no
boxes. Missing node IDs remain distinct from valid elements with no boxes.
An empty native fragment list produces a zero bounding rectangle and an empty
client-rect list. Invisible and zero-size boxes retain their actual origins.
These query rules follow [CSSOM View](https://drafts.csswg.org/cssom-view/#dom-element-getboundingclientrect).

This changes the authoritative native query, without an extra resolve or a
JavaScript geometry override. The existing policy for nodes without computed
styles is preserved. The five Rust tests additionally cover fragment-list
behavior, inline hide/restore, and retained-node identity. They do not certify
all upstream inline fragment generation or JavaScript DOMRect/getClientRects IDL.

| Check | Baseline | Patched |
| --- | --- | --- |
| Shared Chrome/native observations | 14/23 | 23/23, exactly equal |
| Focused native regression tests | 1 passed, 4 failed | 5 passed |
| Existing canvas captures | Reference | All 21 entries unchanged |
| Canvas initialization and 27 shared canvas assertions | Reference | Unchanged / matching |
| Injected failure after two submitted frames | Reference | GPU cleanup passes |
| Ancestor clipping | Fails | Still fails |

Evidence: [Chrome](../../fixtures/dom-geometry/reference-macos-arm64.json),
[baseline](2026-09-18-geometry-positioning/geometry/baseline.json),
[patched](2026-09-18-geometry-positioning/geometry/patched.json),
[identities and comparison](2026-09-18-geometry-positioning/geometry/comparison.json),
[red](2026-09-18-geometry-positioning/geometry/baseline-tests.txt)/[green](2026-09-18-geometry-positioning/geometry/patched-tests.txt)
native tests, and [canvas regression](2026-09-18-geometry-positioning/geometry/canvas-regression.json)
with its [raw report](2026-09-18-geometry-positioning/geometry/canvas-report.json)
and [failure cleanup log](2026-09-18-geometry-positioning/geometry/canvas-failure.txt).
The unchanged images remain in the [canvas handoff evidence](2026-09-18-canvas-handoff.md).

Normal preparation applies the stacking and geometry patches to an ignored
immutable-commit archive. It verifies all 414 Blitz files and the prepared Deno
source. A changed patched file is rejected; fresh preparation reproduces the same
identities. [Preparation check](2026-09-18-geometry-positioning/geometry/preparation-regression.json)

## Maintained upstream positioning boundary

Blitz [PR #805](https://github.com/DioxusLabs/blitz/pull/805) was open when inspected.
The candidate is pinned to `c032f63418097bb82c26077a85c24896c0a96e9d`, based on
our current `9d92719b37c801b8b41c81b799a2a474db8b3936`. It integrates merged Taffy
`dc2fe8bd1ad93e93f0494bdeca2561a420c8f28c`, without changing the Stylo/wgpu versions.

This supplies the needed architectural boundary: preserve formatting ancestry
and original static-position areas, then resolve out-of-flow boxes at their
actual containing block. Taffy's public
[`LayoutContainingBlock`](https://github.com/DioxusLabs/taffy/blob/dc2fe8bd1ad93e93f0494bdeca2561a420c8f28c/src/tree/traits.rs#L202)
and [positioning pass](https://github.com/DioxusLabs/taffy/blob/dc2fe8bd1ad93e93f0494bdeca2561a420c8f28c/src/compute/oof.rs#L57)
carry ownership and cached candidates. Blitz records that owner separately from
`layout_parent`. This is preferable to reparenting DOM/layout nodes or duplicating
block, flex, grid and inline positioning in 3JSN.

The [isolated preparation](../../experiments/dom-canvas/POSITIONED.md) verifies
all 416 candidate source files, derives a separately named manifest and lock,
and applies only the stacking patch. **It excludes the geometry patch and the
rejected overflow prototype**, so its hidden-element failure remains observable.
Its locked offline build and native captures were executed, not inferred from
upstream CI. [Source and executable identities](2026-09-18-geometry-positioning/candidate-identity.json)

## Native results and adoption gates

Every comparison checks identical fixture inputs, case order, viewport, device
scale, recorded pixels, one native paint per case and zero GPU validation errors.
The comparator uses 0.1 CSS-pixel geometry tolerance and channel tolerance 2;
browser-uniform 3×3 interiors exclude raster edges, which are counted separately.
All non-hidden browser subjects have more than 100 visible red pixels.

| Matrix | Result | Interpretation |
| --- | --- | --- |
| Original 22-case overflow matrix | 6/22 matches | Historical stacking-only baseline was 2/22. Absolute/fixed ownership and initial paint positions improve; clips still fail. |
| New 14-case positioned matrix | 10/14 matches | Percentage sizing, original block/flex/grid anchors, owner changes and an escaping relative descendant have positive controls. Four captures fail. |
| Existing canvas regression | All 21 captures and initialization unchanged | 27 shared assertions and injected-failure cleanup pass. Clipping still fails. |

Raw reports and PNGs: [positioned browser](2026-09-18-geometry-positioning/positioned/browser/report.json),
[positioned native](2026-09-18-geometry-positioning/positioned/native/report.json),
[positioned comparison](2026-09-18-geometry-positioning/positioned/comparison.json),
[overflow native](2026-09-18-geometry-positioning/overflow/native/report.json),
[overflow comparison](2026-09-18-geometry-positioning/overflow/comparison.json), and
[canvas regression](2026-09-18-geometry-positioning/candidate-canvas-regression.json)
with its [raw report](2026-09-18-geometry-positioning/candidate-canvas-report.json)
and [failure cleanup log](2026-09-18-geometry-positioning/candidate-canvas-failure.txt).
The overflow reference is the unchanged [published browser capture](2026-09-18-overflow/browser/report.json).

The four positioned failures are actionable:

- **Initial containing block:** with a 60px document in a 256px viewport, an
  absolute bottom-aligned box starts at y=36 instead of 232; a fixed box between
  16px top/bottom insets has height 28 instead of 224. The root fallback uses
  document size. An explicit initial-containing-block area is needed; changing
  game CSS to force full-height roots would conceal the failure.
- **Transformed fixed geometry:** uniform interior pixels match in this case,
  but the native geometry query omits transformed coordinates for the middle
  and subject. Layout ownership alone does not make paint, hit testing and
  CSSOM coordinates agree.
- **Grid-to-block invalidation:** after the outer grid becomes a block, a later
  subject has width104/x104 instead of width160/x76. The final matrix capture
  happens at scale2, but the same failure reproduces entirely at scale1.

The minimal [three-case transition](2026-09-18-geometry-positioning/grid-transition/report.json)
is `grid-static-anchor → grid-owner-area → grid-static-anchor`.
The final rectangle differs from the first. A [separate scale control](2026-09-18-geometry-positioning/grid-scale-control/report.json)
repeats the same grid case at scales 1,1,2,2,1 and remains correct. These two native
diagnostics are not additional browser parity cases.

Source inspection explains the numerical signature: Blitz's
[`get_detailed_layout_info`](https://github.com/DioxusLabs/blitz/blob/c032f63418097bb82c26077a85c24896c0a96e9d/packages/blitz-dom/src/layout/mod.rs#L481)
returns stored grid data after the current display changes. Taffy's
[positioning pass](https://github.com/DioxusLabs/taffy/blob/dc2fe8bd1ad93e93f0494bdeca2561a420c8f28c/src/compute/oof.rs#L223)
uses it as a grid area: the stale 208px width basis yields a 104px half-width.
This is a source-supported diagnosis, not an implemented repair.

Keep issues #22, #23, #24, #26, #52 and #54 open. The next positioning work should
repair initial-containing-block geometry and stale grid metadata at their owners,
then retest transforms, dynamic ownership and the canvas lifecycle before adoption.
Ancestor clips, scrolling and cross-hierarchy paint effects remain separate gates.

## Validation scope

Strict Clippy and formatting passed for the default isolated experiment. All
six native tests passed (five geometry plus the repeated stacking test). All 16
Node tests and 100 assertions across six browser fixtures passed. The existing
upstream `Intrinsic` dead-code warning remains a dependency warning.

Metal API Validation was observed for native GPU captures and failure cleanup.
Readback exists only for evidence. No performance, leak-freedom, visible-window,
Vulkan or D3D12 result is implied. Hosted repository CI excludes these isolated
Metal experiments.
