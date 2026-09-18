# Experimental ownership renderer

The positioned candidate exposes `blitz_paint::paint_scene_with_ownership` as an
explicit alternative to `paint_scene`. Both use the same checked scene lifecycle
and element drawing primitives. The default prepared renderer is unchanged.
This is a bounded paint experiment, not the shipping HTML backend.

The [validation checkpoint](../../docs/validation/2026-09-18-ownership-renderer.md)
records browser comparisons and remaining gates. The public entry returns
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
Each contribution applies its route inside the opacity group. Images and widgets
also receive an own-content clip to the shared rounded content edge; that clip
does not enter descendants' routes.

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
- Independently replayed clip edges fail the
  [covered-underlay controls](../../docs/validation/2026-09-18-clip-edges.md):
  native polygon and opacity-group edges change where Chrome preserves the image.
  All 22 new interior/geometry checks pass, so those checks alone miss this defect.
  Plain inset and rounded clips also vary in Chrome; a blanket grouping rewrite
  is not justified by this evidence.
- Hit testing still consumes the older lists and lacks these clip routes. DOM
  geometry, scrolling, native presentation, other GPU backends and performance
  remain separate adoption gates.

See [preparation and commands](POSITIONED.md). The patch is isolated to the
candidate, pins its resulting files, and introduces no new dependency.
