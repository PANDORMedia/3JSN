# Paint ownership in the HTML candidate

Status: source audit and proposed next boundary. This is not an adopted renderer
or a claim of HTML compatibility. The [positioned candidate](../../experiments/dom-canvas/POSITIONED.md)
already has correct geometry for the public auto-paint fixture, but its recursive
paint lists cannot express the required order across containing blocks.

## Separate three relationships

| Relationship | Responsibility |
| --- | --- |
| Formatting ancestry | Source order, CSS flex/grid order, anonymous boxes and generated content. |
| Containing block | Layout coordinates, absolute/fixed positioning and overflow escape. |
| Paint owner | Real stacking context, painting phases and atomic effects. |

The failing `effect-auto-order` case puts a Document-owned fixed box in HTML's
normal paint list, while a later relative peer stays beneath static ancestors.
Recursive traversal paints the later peer first. Sorting either existing list
cannot interleave them. Changing the containing block to repair painting would
corrupt otherwise correct geometry.

A relative/absolute `z-index:auto` box needs a positioned painting phase while
its positioned descendants can participate in the enclosing real context.
Explicit zero, fixed/sticky auto, and static transform/effect contexts have
different atomicity. See [CSS Position](https://www.w3.org/TR/css-position-3/#painting-order)
and [CSS painting order](https://www.w3.org/TR/CSS22/zindex.html).

## Proposed collection boundary

Use one post-layout ownership pass in Blitz, replacing the competing list writers.
Reuse the existing formatting ranks and stacking-entry representation. Each
entry must identify its node, geometry owner, real context, paint phase and rank.
Validate exactly-once participation and live, rooted owners before rendering.
Do not maintain a second tree by mutating DOM or layout parent relationships.

Read current computed styles when classifying contexts. An identity transform
still creates a context, and a cached matrix can describe the previous resolve.
The bounded classifier repair precedes any collector change. Ordinary inline
text is fragment-based in the current renderer: do not assign an invented box
to a span and claim its fragments are supported by a box collector.

Within a supported 2D context, a translation bridge between geometry and paint
owners is valid only when it crosses no transform boundary. Enforce that
invariant and retain the child's transform exactly once. Current layout and
entry offsets use CSS pixels; painter affines use device pixels. Root/Document
origin compensation and viewport-fixed scrolling need explicit mappings shared
by forward painting and reverse hit traversal.

Paint bounds must follow paint ownership. Geometry-owned overflow can omit a
visible child that escapes its containing block but remains inside a static
effect group. An incorrect culling bound must not discard that entire group.
Even the existing untransformed stacking bounds must be refreshed after layout:
the upstream style flush calculates them before fresh dimensions exist. Contexts
without an out-of-flow attachment can otherwise keep zero or previous-frame
bounds, suppressing valid input before traversal reaches the child.
Unsupported 3D, singular transforms, scrolling or fragments need diagnostics;
they must not silently become identity transforms or ordinary boxes.

## Clips cannot be inherited as one blanket layer

Overflow clipping depends on containing blocks. A relative child can be clipped
by an intermediate ancestor whose overflow an absolute/fixed child escapes.
Consider overflow ancestor A, static opacity group B, and fixed descendant C:
B's own pixels may be clipped by A while C escapes A, yet both must share B's
single opacity operation. Replaying A's clip around the whole B group is wrong.
See [CSS overflow clipping](https://www.w3.org/TR/CSS22/visufx.html#overflow-clipping).

Retain clip eligibility per painted content/entry and preserve atomic effects
separately. CSS rect clips, overflow clips and clip-paths have distinct rules.
Opacity and alpha masks do not define input exclusion; clip-path does. See
[CSS Masking](https://www.w3.org/TR/css-masking-1/).

Blitz's current hit path does not evaluate overflow or shape clips. Paint's
`CssBox` paths and clip resolvers are private, so copying their radius math into
hit testing would create two implementations. Extract the existing pure geometry
into a shared DOM-side module consumed by paint and hit testing; this preserves
the current dependency direction. Distinguish unsupported clip geometry from
an absent clip. The layer manager's cumulative push limit also needs an observable
failure before any collector starts replaying ancestor clips.

## Validation order

1. Verify fresh style-based transform contexts and repeated promotion/demotion.
2. Produce a diagnostic ownership plan before changing rendering. Check exactly
   one attachment, auto versus zero, real fixed/sticky contexts, static effects,
   CSS order, generated boxes, hidden wrappers and restoration.
3. Replace collection, then verify pixels and reverse hit order against shared
   browser fixtures. Retain every previously passing case and explain changes
   in already-failing cases.
4. Extract shared clip geometry and validate containing-block escape through
   effect groups, rounded corners, CSS clips, input, root offsets and scrolling.
5. Measure traversal and layer costs before introducing invalidation caches.

The [auto-paint fixture](../../fixtures/auto-paint/README.md) records initial
discriminating cases. Its 17 captures are not sufficient for all gates above.
Issues [#54](https://github.com/PANDORMedia/3JSN/issues/54) and
[#52](https://github.com/PANDORMedia/3JSN/issues/52) remain separate adoption gates.
