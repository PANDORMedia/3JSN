# Clip edge composition fixture

Original MIT-licensed, redistributable controls for complete-image clip-edge
comparison. The [recorded checkpoint](../../docs/validation/2026-09-18-clip-edges.md)
finds five of nine proposed invariance groups exact in Chrome and none in the
preserved native renderer. All 22 browser/native geometry and uniform-interior
checks pass; this fixture exposes behavior those interior checks exclude.

The ordinary `clipFixture.prepare(name)` protocol uses a 448 × 256 CSS viewport
and retains the measured `outer`, `middle`, `subject` IDs. Twenty-two capture records
cover fifteen named states and nine equal-scale invariance groups. There are no
fonts, text, images, private assets, timers, geometry reads or scroll mutations.
Every preparation fully replaces each node's style attribute; DOM nodes remain
connected in the same source order.

`underlay` precedes `subject`. Both are opaque 272 × 192 rectangles at the same
position, larger than every clipping region. The later red subject fully covers
the underlay. Its own rectangular edges lie outside the tested clip boundaries.
The single-fill state uses `visibility:hidden` on the retained underlay. Other
states reveal an identical red or contrasting blue underlay. Measured geometry
does not depend on that visibility change. Transparent wrapper backgrounds avoid
adding an accidental extra fill behind the pair.

| Group | Cases and purpose |
| --- | --- |
| Fractional polygon, 1× | Hidden/red/blue underlay variants plus final restoration. Sloped edges and fractional vertices expose coverage accumulation. |
| Fractional polygon, 2× | The same three source states with unchanged CSS geometry at DPR 2; fractional device edges remain. |
| Rounded overflow, 1× | Single versus duplicate red under fractional translation and elliptical corner radii. |
| Rounded overflow, 2× | Same rounded pair at DPR 2. |
| Fractional inset, 1× | Single versus covered blue under an unrounded fractional inset. No unsupported rounded-inset syntax. |
| Opacity group, 1× | Single versus covered blue under the polygon and one 0.5 opacity group, plus restoration. |
| Nested polygons, 1× | Single versus covered blue with a fixed intersection of two different polygons. |
| Rounded overflow with inner opacity, 1× | Rounded overflow belongs to outer A; middle B is an inner 0.5 opacity group containing both fills. Hidden versus covered-blue underlay. |
| Rounded overflow with inner opacity, 2× | Repeat that contained group at DPR 2; no fixed/absolute descendant escapes A. |

`cases.json` is compatible with the existing capture guard. Opaque states retain
a large uniform `#e02030` subject region; opacity states declare canonical
`subjectColor: [240,144,152,255]` for half-opacity red over white. Each is designed
to exceed 100 visible subject pixels; capture must verify that expectation with
the existing guard. There is no sentinel and no relaxed threshold.

`invariants.json` contains proposed pairs/groups, using only
`{schemaVersion:1, backgroundColor:[r,g,b,a], groups:[{name,scale,cases,rationale}]}`. Resolve each name and
scale to its capture, validate dimensions and recorded pixel hashes, then compare
**all RGBA bytes**, including the antialiased edge, within that renderer. Compare
each member to its group's first member. Do not compare different scales, exclude
edges, or replace this test with the existing uniform-interior comparator. The
ordinary browser/native comparison remains useful alongside this new test.

The normative compositing model and the byte-level acceptance rule are distinct:

- [CSS Masking §2](https://www.w3.org/TR/css-masking-1/#module-interactions)
  describes clipping the composed element and descendants. Thus the polygon,
  inset and fixed nested-chain variants have the same abstract pre-clip color
  result: opaque red has covered the underlay. This supports their equivalence,
  but does not prescribe exact edge samples or quantization.
- [CSS Color 3 opacity](https://www.w3.org/TR/css-color-3/#transparency) applies
  opacity to the composed group. The opacity pair keeps the fully covered content
  and that group operation unchanged.
- [CSS Backgrounds §4.3](https://www.w3.org/TR/css-backgrounds-3/#corner-clipping)
  defines rounded overflow geometry. It does not by itself require an offscreen
  buffer or an exact antialias kernel. The rounded pair is a proposed occlusion
  invariance control whose browser behavior must be measured.

Exact complete-image equality is a deliberately strict within-renderer diagnostic,
not a claim that two different renderers must use identical antialiasing. If the
recorded browser changes edge bytes between pair members, preserve that result
and investigate it rather than describing an unobserved invariant as proven or
discarding edge pixels. Browser and native results should be reported separately.

In particular, the abstract clip model does not settle whether a plain clip is
implemented with an intermediate group for antialiased edges. Nonidentical plain
polygon, inset or rounded pairs must not automatically be called standards
violations. The contained inner-opacity pair and path-owner opacity pair are
stronger grouping controls: an unchanged opacity operation must cover all the
opaque fills together. Their exact RGBA equality still remains a hypothesis until
measured. White canvas screenshots provide RGB coverage evidence, not independent
transparent-output alpha evidence.

A possible failure mechanism is independently clipping both fills before
source-over blending. For a fractional clip coverage `a`, two identical fills
can yield `2a - a²` coverage rather than `a`; a covered blue fill can leak into
the edge. This algebra motivates the controls. It is not a predicted pixel count
or a claim about either renderer before capture.

## Reproduction

```sh
node scripts/compatibility/paint-reference.mjs /path/to/chrome artifacts/clip-edges/browser clip-edges
node experiments/dom-canvas/compare-clip-invariants.mjs fixtures/clip-edges artifacts/clip-edges/browser artifacts/clip-edges/browser-invariants.json
```

Run the prepared `threejs-positioned-ownership-paint-probe` with this fixture's
HTML, script, cases and a fresh output directory as its four arguments; see
[build commands](../../experiments/dom-canvas/POSITIONED.md). Run the same invariant
comparator on its capture directory. Exit 1 means at least one proposed group is
nonidentical, which is an expected diagnostic result for the recorded baseline.
Invalid identities, geometry, case coverage, invisible subjects or references
without intermediate edge colors abort before writing a report. The latter guard
assumes these monochrome controls over the declared flat background.

The report's secondary count of channel differences greater than two is diagnostic
only: the exact-equality result always has zero tolerance and excludes no pixels.
Retain the independent `compare-clips.mjs` geometry/interior comparison as well.
