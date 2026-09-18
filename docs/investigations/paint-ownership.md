# Paint ownership in the HTML candidate

Status: a read-only ownership plan, shared clip geometry, and an explicit
[experimental paint consumer](../../experiments/dom-canvas/OWNERSHIP.md). Legacy
rendering and hit traversal remain available. The bounded renderer is not adopted
as the default backend; [validation](../validation/2026-09-18-ownership-renderer.md)
separates interior pixels, geometry and remaining fidelity gates.
The [opacity-output checkpoint](../validation/2026-09-18-opacity-output.md)
implements a bounded shared-prefix composition repair in that explicit consumer.
The [positioned candidate](../../experiments/dom-canvas/POSITIONED.md)
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

## Collection boundary

Use one post-layout ownership pass in Blitz, replacing the competing list writers.
Reuse the existing formatting ranks and stacking-entry representation. Each
entry must identify its node, geometry owner, real context, paint phase and rank.
Validate exactly-once participation and live, rooted owners before rendering.
Do not maintain a second tree by mutating DOM or layout parent relationships.

The candidate now exposes `PaintOwnershipPlan::build(&BaseDocument)` as a
read-only precursor to that replacement. Entries record geometry and paint
owners, enclosing real context, phase, formatting rank and coordinate prefix.
The plan borrows its resolved document; callers must also avoid writes through
public interior layout cells while retaining it. Rebuild after the next resolve.
The diagnostic executable consumes this API on the same JavaScript mutations
used for browser/native captures and records the existing lists alongside it.
It does not install its proposed attachments in those lists.

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
The current plan rejects these cases, floats and unsupported computed context
triggers with a node and issue code. It cannot diagnose declarations discarded
by the pinned parser: `transform-box`, for example, is Gecko-only in this Stylo
build, so the candidate still uses the existing border-box transform resolver.
Alternate transform reference boxes remain unsupported. This bounded contract
is deliberate; a successful plan is not a painting pass or a CSS support report.

## Clips cannot be inherited as one blanket layer

Overflow clipping depends on containing blocks. A relative child can be clipped
by an intermediate ancestor whose overflow an absolute/fixed child escapes.
Consider overflow ancestor A, static opacity group B, and fixed descendant C:
B's own pixels may be clipped by A while C escapes A, yet both must share B's
single opacity operation. Replaying A's clip around the whole B group is wrong.
See [CSS overflow clipping](https://www.w3.org/TR/CSS22/visufx.html#overflow-clipping).

The [effect fixture](../../fixtures/paint-ownership/README.md) verifies this
opacity counterexample. Its expanded clip-path variant behaves differently in
the recorded Chrome reference: fixed C remains clipped at A despite unchanged
reported geometry. The [clip-routing controls](../../fixtures/effect-clip-routing/README.md)
now trace this difference to the tested Chrome revision: the path captures B's
incoming clip chain and propagates it to fixed descendants. CSS rect can instead
reuse its shape beneath the descendant's fixed clip chain. Moving the path to C,
moving it to A before A's own overflow, or removing A's overflow distinguishes
these routes. All 14 controls preserve C's fixed geometry. This is evidence for
a bounded Chrome compatibility policy, not a universal cross-browser rule.

Retain clip eligibility per painted content/entry and preserve atomic effects
separately. CSS rect clips, overflow clips and clip-paths have distinct rules.
Opacity and alpha masks do not define input exclusion; clip-path does. See
[CSS Masking](https://www.w3.org/TR/css-masking-1/).

Blitz's current hit path does not evaluate overflow or shape clips. The candidate
moves the existing `CssBox` and corner-radius implementation from paint into
`blitz_dom::geometry`; painting imports that one implementation. Shared padding
and content path predicates are available for future hit traversal. They use
nonzero winding and close every open subpath, matching filled-path semantics.
They do not decide which ancestor clips apply. Clip-path resolution, clip
eligibility and hit traversal remain separate work. Distinguish unsupported clip
geometry from an absent clip. The checked paint boundary now makes layer-budget
failure observable before rasterization; every future traversal helper must use
that same boundary. It counts actual clip/effect commands, including replayed
fragments and nested documents, rather than estimated DOM complexity.

## Renderer integration boundary

Replacing `draw_children` alone is insufficient: the current element traversal
draws its own image, canvas or text before visiting negative-z children. Split
decoration, negative contexts, ordinary content, and zero/positive phases while
reusing existing paint primitives. Apply opacity once around a group's content.
The first implementation replayed each contribution's full clip route inside
that group; the [clip-edge controls](../validation/2026-09-18-clip-edges.md)
exposed repeated edge coverage. The current explicit consumer factors an eligible
common output prefix at fractional opacity, retaining contribution-specific
suffixes inside the group. Retain separate
normal, absolute and fixed clip references with explicit shape coordinate spaces.
Never change DOM or layout parents to obtain paint order.

Geometry-owned overflow culling must not discard an escaping paint contribution.
An initial bounded implementation can use conservative viewport effect bounds;
tight bounds and caching need separate evidence. Combine the plan's CSS-pixel
prefix and local location once, convert to device coordinates, then apply the
element transform once. Reusing the old root-offset compensation on top of that
prefix would double the adjustment. Inline fragments, unsupported effects and
scrolling remain explicit eligibility gates before applying the plan.

## Validation order

1. Verify fresh style-based transform contexts and repeated promotion/demotion.
2. Produce a diagnostic ownership plan before changing rendering. Check exactly
   one attachment, auto versus zero, real fixed/sticky contexts, static effects,
   CSS order, generated boxes, hidden wrappers and restoration.
3. Share clip geometry and validate containing-block escape through effect
   groups, rounded corners, CSS clips, input, root offsets and scrolling.
4. Replace collection, then verify pixels and reverse hit order against shared
   browser fixtures. Retain every previously passing case and explain changes
   in already-failing cases.
5. Measure traversal and layer costs before introducing invalidation caches.

The [auto-paint fixture](../../fixtures/auto-paint/README.md) records initial
discriminating cases. Its 17 captures are not sufficient for all gates above.
Issues [#54](https://github.com/PANDORMedia/3JSN/issues/54) and
[#52](https://github.com/PANDORMedia/3JSN/issues/52) remain separate adoption gates.

<a id="next-clip-composition-experiment"></a>

## Implemented opacity-output boundary

The complete-image controls distinguish polygon, inset and ordinary rounded
overflow behavior in the tested Chrome revision. Do not infer that every
`clip-path` needs the same isolated group. The implemented repair activates only
at an existing effect with `0 < opacity < 1`. A bottom-up fold computes the longest
common prefix of its decoration route and both routes of every entry in the
paint-owned subtree. It includes negative/in-flow/zero/positive phases, nested
effects and conservatively hidden/zero-opacity entries. Shared `Arc` pointer
identity and order define equality; equal geometry is insufficient. The decoration
cap prevents promoting a descendant's clip or the owner's later content overflow.
An escaping fixed descendant can shorten the prefix, including to empty.

Normal-blend output layers surround the existing viewport opacity layer. Nested
effects open only prefix clips not already active; contributions remove the
entire active prefix from their local routes. Both in-flow traversals and atomic boxes
preserve that prefix. Empty route suffixes stay local, and the propagated canvas
background stays outside all element groups. There is still exactly one opacity
operation per active opacity owner. The change neither rewrites DOM/layout
ownership nor introduces texture transport.

Frame preparation validates prefix extension and contribution membership before
scene commands. Inconsistency returns the typed `InconsistentClipPrefix` issue;
there is no legacy fallback. Private helper tests exercise wrong identity/order,
overlong-prefix rejection and empty suffixes, but do not inject that complete
preflight error branch. Public command tests cover nested and atomic traversal,
partial escape, own overflow/content clips, hidden/zero-opacity behavior, root
backgrounds, offsets, DPR, restoration and checked budget cleanup. The checkpoint
records 76 host tests, 18 private painter tests and 36 Node tests passing.

On Metal, exact within-renderer invariance improves from 0/9 to 3/9 in the earlier
22 captures and from 0/12 to 10/12 in the 26 new opacity controls. Chrome also has
10/12 in the new set; same-owner rounded-overflow groups remain noninvariant in
both. All 48 browser/native geometry and uniform-interior comparisons pass, and
all 142 older payloads remain unchanged in each traversal. This is not complete
edge equality: the older Chrome ancestor-rounded/inner-opacity 2× pair still has
11 differing pixels with maximum channel delta 1, while native is now exact.

Ordinary alpha-one polygon and nested-polygon grouping remain unresolved and
unchanged. Plain inset/rounded controls retain Chrome's nonidentical pairs.
Conservative route summaries may leave additional clips local; storage, traversal,
layer cost and tighter effect bounds have no performance evidence. Text, input,
scrolling, other backends and the maintenance/adoption decision remain separate
gates.
