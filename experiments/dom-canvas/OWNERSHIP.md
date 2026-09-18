# Experimental ownership renderer

The positioned candidate exposes `blitz_paint::paint_scene_with_ownership` as an
explicit alternative to `paint_scene`. Both use the same checked scene lifecycle
and element drawing primitives. The default prepared renderer is unchanged.
This is a bounded paint experiment, not the shipping HTML backend.

The [initial validation](../../docs/validation/2026-09-18-ownership-renderer.md)
and [CSS rect effect checkpoint](../../docs/validation/2026-09-18-css-rect-effect.md)
record browser comparisons and remaining gates. The public entry returns
`Result<PaintStats, OwnershipPaintError>`; failures distinguish plan, clip,
unsupported-content and layer-budget errors. It never falls back to legacy paint.
The caller must discard a fresh deferred scene on any error before submission.
Widget resource registration remains part of the host's separate drain/release
lifecycle.

## Boundaries

`render/ownership.rs` prepares one frame from the resolved document: a borrowed
ownership plan, device-space transforms, contribution clips and eligibility.
Preparation finishes before scene commands. No DOM parents, geometry owners,
layout cells or existing paint lists are rewritten. Rebuild after each resolve.

The traversal paints context decoration, negative contexts, ordinary block
decorations, own and in-flow content, then zero and positive contexts. Flex/grid
items and supported atomic inline boxes retain their in-flow atomicity while
positioned descendants retain the plan's real context. The existing primitive
methods provide backgrounds, borders, raster images and custom widgets.

Each opacity context opens one group around all its contributions. Conservative
viewport bounds keep visible fixed descendants when their owner is offscreen or
empty. Visibility hides a node's own contribution; explicitly visible descendants
remain eligible. Zero opacity skips the group. No traversal or GPU-memory bound
is claimed from the layer-command budget.

`render/ownership_clips.rs` maintains distinct normal, absolute and fixed clip
routes. Overflow follows resolved containing blocks. CSS rect can retain its own
shape while an ineligible ancestor overflow is escaped. Clip-path captures its
incoming chain, following the [recorded Chrome controls](../../fixtures/effect-clip-routing/README.md).
This is a bounded compatibility policy, not a universal cross-browser rule.
At an existing group with `0 < opacity < 1`, preparation finds the longest common
prefix of its decoration route and both routes of every entry in its paint-owned
subtree. The fold includes every paint phase, nested groups, hidden entries and
zero-opacity entries conservatively. The output prefix is capped at the route
after the owner's clip-path and before its CSS rect, overflow or replaced-content
clip. Those later clips remain local; incoming ancestor clips remain eligible.
The uncapped summary is retained for enclosing groups. Comparison
uses frame-local shared-object identity (`Arc::ptr_eq`) and order, not equal paths.

That prefix surrounds the existing viewport-bounded opacity layer. Contributions
replay only their local suffixes; nested opacity and atomic in-flow groups retain
the active prefix without replaying it. An escaping fixed descendant can shorten
the prefix, including to empty, while keeping the same opacity operation. Alpha-one
groups retain their existing clipping behavior. Images and widgets also receive
an own-content clip to the shared rounded content edge; that clip does not enter
descendants' routes.

Preparation validates prefix extension and route membership before scene commands;
inconsistency returns `OwnershipPaintIssue::InconsistentClipPrefix`. Helper tests
reject wrong identity/order and overlong prefixes; they do not inject the complete
typed preflight error branch. Empty suffixes remain local to their routes, and
scope cleanup uses the existing checked layer lifecycle.

Transforms combine the plan's CSS-pixel prefix, layout location and node transform
once. Clip paths use local device pixels and the same device affine. The solid
canvas background is propagated from HTML or BODY and painted once over the
viewport, outside root element clips. Its source element's ordinary background
is suppressed. BODY visibility does not prevent propagation; `display:none`
does. Other boxless BODY propagation is explicitly rejected.

The clip capture host accepts a concrete paint callback, so both traversals share
GPU creation, submission, readback and cleanup. The candidate-only executable is
`threejs-positioned-ownership-paint-probe`; the existing overflow executable keeps
legacy traversal. Reports identify `paintTraversal`.

Routes share shape objects but clone vectors of inherited clip references. Frame
storage therefore grows with total inherited clip depth. This simple prototype
has no traversal, recursion or memory budget. Cache design and tighter effect
bounds need measurements; the [dependency adoption gate](../../docs/dependencies.md#upgrade-policy)
also requires reassessing the eleven-patch maintenance burden.

The Metal opacity-output checkpoint records 26/26 new geometry and uniform-interior
matches against Chrome. Exact within-renderer image groups improve from 0/12 to
10/12, matching Chrome's group classification. The two same-owner rounded-overflow
groups remain nonidentical in both renderers; this does not mean their edge pixels
match each other. The earlier 22-case clip-edge set remains 22/22 for geometry and
interiors, while native exact invariance improves from 0/9 to 3/9. All 142 earlier
case payloads remain unchanged in each traversal.

The own-CSS-rect follow-up retains all 190 earlier case payloads and PNGs exactly.
Its 16 captures match uniform interiors but retain four transformed-CSSOM query
differences per case. All eight within-renderer groups are noninvariant, matching
Chrome's classification; this does not assert equal edge colors.

Validation includes 79 host tests (42 layout, 5 budget, 32 ownership), 22 private
painter tests and 36 Node tests. These checks and the GPU captures establish the
bounded change, not a speedup, memory bound or complete clip-edge parity.

## Current limits

- Text, nontrivial inline fragments, tables, list markers, form controls, embedded
  documents and unsupported replaced/foreign content are rejected. SVG rejection
  is independent of whether the dependency was built with SVG support.
- Filters, masks, shadows, outlines, root opacity/hidden-root effects, active
  overlays, 3D/singular transforms and scrolling are outside this path.
- Supported clip geometry is shared rounded boxes, unrounded inset, nonzero
  polygon and CSS rect. URL/circle/ellipse/path shapes, rounded inset, evenodd,
  margin-box, axis-only overflow, `overflow:clip` and BODY viewport-overflow
  propagation return errors. An empty supported clip remains an empty clip.
- Root/propagated background images and transformed widgets with nonzero content
  offsets are rejected. Broader media and image behavior is not certified by the
  recorded command tests.
- Alpha-one polygon and nested-polygon edges still fail the
  [covered-underlay controls](../../docs/validation/2026-09-18-clip-edges.md).
  Plain inset and rounded clips also vary in Chrome; grouping every clip is not
  justified. Chrome's ancestor-rounded/inner-opacity 2× pair retains 11 changed
  pixels with maximum channel delta 1, while the new native pair is exact. Neither
  result establishes cross-renderer antialias equality. Current white-background
  captures provide RGB composition evidence, not varying-alpha validation.
- Live DPR changes on a resolved box-only document can retain stale transform
  and overflow caches. Fresh-document DPR 1/2 clipping tests do not validate a
  display-scale transition; the checkpoint preserves the failing observation.
- Hit testing still consumes the older lists and lacks these clip routes. DOM
  geometry, scrolling, native presentation, other GPU backends and performance
  remain separate adoption gates.

See [preparation and commands](POSITIONED.md). The patch is isolated to the
candidate, pins its resulting files, and introduces no new dependency.
