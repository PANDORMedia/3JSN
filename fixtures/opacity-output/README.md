# Opacity output clip fixture

Original MIT-licensed, redistributable box-only input for a separate opacity
output-clip experiment. The [validation checkpoint](../../docs/validation/2026-09-18-opacity-output.md)
records Chrome and Metal captures of these unchanged inputs. The earlier
`fixtures/clip-edges` remains a separate 22-capture control set.

The ordinary `clipFixture.prepare(name)` protocol uses a 448 × 256 CSS viewport
and retains `outer`, `middle`, `subject` as measured elements. Twenty-six capture
records cover fourteen named states and twelve equal-scale comparison groups.
Every preparation replaces all nine retained nodes' style attributes. The DOM
stays connected in the same source order; no geometry queries, scroll mutations,
fonts, text, private assets, timers or external resources are used.

The hidden blue underlay and later opaque red subject have coincident rectangles.
Toggling the underlay changes no abstract pre-clip opaque image because the red
subject completely covers it. Each pair holds geometry, clips, opacity and paint
order fixed. `invariants.json` proposes complete RGBA equality within that pair;
it does not assume every browser pair will match or compare images across DPRs.

| Family | Captures | Distinction |
| --- | --- | --- |
| Own inset with opacity | Pair at 1×/2×, plus final 1× restoration | The same element owns fractional `clip-path:inset(...)` and opacity 0.5. |
| Ancestor inset, inner opacity | Pair at 1×/2× | The inset belongs to the opacity group's ancestor; all contributions share it. |
| Own rounded overflow with opacity | Pair at 1×/2× | Overflow clipping and opacity belong to one element, separate from the existing ancestor-rounded control. |
| Nested shared prefixes | Pair at 1×/2× | Outer polygon P and opacity 0.5 enclose inner inset Q and opacity 0.5. |
| Nested opacity with fixed escape | Pair at 1×/2×, plus final 1× restoration | The inner effect inherits P+Q, but a fixed descendant retains only P. |
| Signed paint-owned fixed escape | Pair at 1×/2× | The same mixed routes have negative-z blue and positive-z red contributors owned by the inner effect. |

The discriminating partial-prefix tree is:

```text
outer: polygon P, opacity 0.5
  middle: rounded overflow Q, opacity 1
    effect: opacity 0.5, static positioning
      ordinary: absolute red, route P+Q
      underlay: viewport-fixed blue, hidden or visible, route P
      subject: coincident viewport-fixed opaque red, route P
later: ordinary unclipped 4×4 CSS tile outside both clip regions
```

Q is an ancestor of the inner effect, not merely a clip contributed by that
effect itself. The ordinary contribution uses Q, while the viewport-fixed pair
extends beyond Q into P. This is intended to shorten the inner effect's common
clip prefix from P+Q to P. Opacity must still apply twice to all its contributions.
The signed variant assigns underlay `z-index:-2` and subject `z-index:2`; their
geometry owner remains the viewport while their paint owner is the inner effect.
The regular escape pair keeps both at `z-index:auto` to separate that phase change.

The fixed subject occupies x=160…352 and y=16…240 in CSS pixels. It extends
beyond middle's overflow but intersects the outer polygon substantially. A
separate ordinary red fill crosses Q to the left of the fixed pair, leaving a
visible clipped witness. Backgrounds of all intermediate boxes are transparent.
For the first four families, coincident 272×192 fills exceed the clip regions;
their own rectangular boundaries do not produce the tested clip-edge samples.

Opacity 0.5 states declare `subjectColor:[240,144,152,255]`; nested 0.5×0.5 states
declare `[247,199,203,255]`, the canonical quarter-opacity red over white. Both
use the existing tolerance of two for the visibility guard. Each real subject is
required to leave more than 100 matching pixels. The recorded browser, baseline
and repaired-native captures pass that guard. No thresholds were changed.

The later sibling is a solid tile in that same declared composite color at
(408,224), outside every tested clip. It diagnoses leaked clip/effect state in
the independent browser/native comparison. Its integer-aligned 4×4 CSS rectangle
adds no intermediate edge colors and contributes at most 64 subject-color pixels
at 2×; it cannot independently satisfy the greater-than-100 visibility guard.
Pair equality alone cannot detect a leak that affects both members identically.

Use both comparators after capture: complete-image invariance and independent
browser/native geometry/interior checks. All 26 captures occur in exactly one
equal-scale invariant group. The ordinary intermediate-color reference guard
remains meaningful because only red/composite-red content appears in a reference
over its declared white background. Revealed blue is always geometrically covered.

An invariant failure is a recorded classification, not automatically a standards
violation. Quantization may affect exact bytes even with group composition. Do
not discard edges, change tolerance to turn a failure into a pass, or move the
effect to make the case easier. Keep browser and native results separate, retain
restoration results, and treat escape, signed paint order, and later-sibling
visibility as additional browser-reference obligations.

## Recorded result

The previous native renderer has exact equality in 0/12 groups. The bounded
opacity-output repair reaches 10/12, with the same invariant/noninvariant group
classification as Chrome 153.0.8010.50. Own and ancestor inset, shared nested
prefixes, fixed escape and signed paint-owned escape are exact at both scales;
the two restoration captures also match their original states.

Same-owner rounded overflow remains noninvariant at 1× and 2× in both renderers.
Its overflow is a local content clip, after the owner's decoration route, so the
repair intentionally does not promote it to the group's output. Chrome changes
180/356 pixels and native changes 228/456, with maximum channel delta 28 in each
case. Matching this classification does not mean matching those edge pixels.

All 26 repaired-native captures match browser geometry and uniform interiors
under the existing independent comparator. That comparator excludes non-uniform
edge neighborhoods; the exact within-renderer comparisons exclude no pixels and
use no channel tolerance. Both results are needed. These opaque-background
captures establish RGB composition evidence, not varying-alpha fidelity, general
browser conformance, a speedup or backend adoption. See the
[renderer contract](../../experiments/dom-canvas/OWNERSHIP.md) and
[reproduction commands](../../experiments/dom-canvas/POSITIONED.md#opt-in-ownership-capture).
