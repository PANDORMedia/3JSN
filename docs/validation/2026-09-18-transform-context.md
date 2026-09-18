# Current transform contexts and hit bounds — 2026-09-18

**Research candidate; not adopted.** Two small dependency patches repair current
transform-context classification and post-layout hit bounds. The default prepared
renderer is unchanged. Correct transform removal also exposes an existing clipping
failure that the preceding candidate accidentally hid for one frame. This checkpoint
does not preserve every previous single-frame match.

## Repairs

The stacking classifier previously read a transform matrix cached by the previous
resolve. Identity transforms resolve to no affine, so they never established the
required context. It now reads Stylo's maintained computed-style predicate, with
box-applicability guards for inline, replaced/form, boxless and table cases.
The shared fixture verifies identity, nonidentity, removal and restoration in
both positive and negative stacking orders. This follows
[CSS Transforms](https://www.w3.org/TR/css-transforms-1/#transform-rendering).

Stacking-list bounds were also calculated before layout. Relative descendants
could have correct geometry and list membership but zero or previous-frame hit
bounds. The companion patch refreshes bounds after layout within the existing
collection pass, using the rooted rank guard to exclude retained hidden/detached
contexts. It reuses the existing bounds calculation; no new coordinate model or
paint collector is introduced.

## Observed results

Baseline is repository `de902ac`, with five candidate patches. The new candidate
uses seven patches, pinned to the same Blitz/Taffy revisions.

| Browser comparison | Baseline | Current candidate |
| --- | --- | --- |
| New auto-paint suite | 4/17 | 5/17 |
| Paint-order suite | 19/20 | 19/20 |
| Initial-containing-block suite | 19/21 | 19/21 |
| Positioned-layout suite | 13/14 | 13/14 |
| Overflow suite | 6/22 | 5/22 |

All 17 auto-paint cases retain exact recorded geometry. `static-transform-branch`
is repaired. The three other existing matrices have unchanged case-level results.
Overflow's transformed-clip and transformed-fixed pixels now match, but their
CSSOM geometry still differs in seven/four fields, so neither counts as a pass.

The lost `moved-clip` 1× match is explicit. Its red box remains correctly located
at `(172,100)`, but all 9,000 subject pixels are visible instead of the clipped
1,584. Every one of the 7,416 changed pixels lies outside the expected clip;
there is no displacement. The 2× case already failed identically before this change.

A [four-frame replay](2026-09-18-transform-context/transform-reset/summary.json)
uses the unchanged overflow HTML/script and a separate case list:
`transformed-clip → moved-clip → moved-clip → moved-clip`.
The preserved baseline matches Chrome only on the first moved frame, then exposes
the same 7,416-pixel clipping failure on both repeats. The corrected classifier
exposes it on all three frames. The old pass depended on stale context ownership;
retaining that state would hide the failure rather than implement ancestor clips.
The replay compares against the existing Chrome moved-state reference, not a new
browser capture of the four-frame sequence.

## Evidence and checks

The evidence directory contains 136 PNGs, raw geometry/pixel observations and
source/executable identities. Uniform-interior comparison tolerates two channel
levels and geometry within 0.1 CSS pixel; raster edges are reported separately.
Browser and native hosts use identical fixture inputs and ordered mutations.
Native captures paint once before inspecting stored geometry.

- New matrix: [browser](2026-09-18-transform-context/browser/report.json),
  [baseline](2026-09-18-transform-context/baseline-comparison.json),
  [candidate](2026-09-18-transform-context/candidate-comparison.json).
- Existing matrices: [paint order](2026-09-18-transform-context/paint-order-comparison.json),
  [initial owner](2026-09-18-transform-context/initial-comparison.json),
  [positioned](2026-09-18-transform-context/positioned-comparison.json),
  [overflow](2026-09-18-transform-context/overflow-comparison.json).
- [Baseline identity](2026-09-18-transform-context/baseline-identity.json),
  [candidate identity](2026-09-18-transform-context/candidate-identity.json),
  [GPU capture identity and changed cases](2026-09-18-transform-context/final-capture-identity.json).

All [28 targeted CPU tests](2026-09-18-transform-context/checks/final-tests.txt)
pass. The same [baseline run](2026-09-18-transform-context/checks/baseline-tests.txt)
passes the previous 21 and fails all seven new regressions. These cover first
layout, move/resize, transform ownership, initial authored styles, applicability,
and preserve-3d ownership under overflow-induced flattening.
The [shared Chrome hit reference](2026-09-18-transform-context/browser-hit-reference.json)
matches 228 native expectations across three repeated 19-state sequences in each
z mode, with two samples per state. Additional CPU applicability and bounds
controls are not represented as browser-captured assertions.

The [canvas regression](2026-09-18-transform-context/regression-summary.json)
preserves the entire previous paint report, including 21 captures and initialization,
matches 27 browser canvas contracts, records no unexpected GPU validation errors,
and drains the injected failure after two submitted frames. Its known clipping
failure remains. Strict candidate Clippy, formatting, 16 Node tests and 252
source/config/documentation checks pass;
the upstream `Intrinsic` dead-code warning remains visible.
[Fresh preparation checks](2026-09-18-transform-context/preparation-regression.json)
verify repeatability, 416 tracked files plus two added modules, tamper rejection
and unchanged default dependencies.

## Remaining boundary

The next [paint-ownership change](../investigations/paint-ownership.md) must preserve
applicable clips across geometry owners and atomic effects. Issues #54 and #52
remain open. The current bounds repair does not refresh all inherited hoist offsets
or include transformed/overflowing descendant extents. Full transformed CSSOM,
scrolling, clipped input, inline fragments and general no-box hit handling remain
unverified or failing. Perspective/preserve-3d checks establish planar context
ownership only; their containing-block and 3D rendering behavior is not certified.

Rank construction now also runs on frames without out-of-flow changes or z ties;
its cost is unmeasured. These offscreen Apple M1 Pro Metal results establish neither
visible presentation, Windows/Linux GPU parity, performance nor an unchanged
packaged game. See the [reproduction guide](../../experiments/dom-canvas/POSITIONED.md).
