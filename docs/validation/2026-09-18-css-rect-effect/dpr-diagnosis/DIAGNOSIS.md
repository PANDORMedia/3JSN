# Existing live DPR-transition cache limitation

Read-only diagnosis of the parent's first CSS-rect candidate command test run.
No build, test, preparation or GPU execution performed here. The original failed
log is copied as `initial-candidate-command-tests.txt`; `inputs.json` pins the
source snapshot. The test-file hash records the parent's later fresh-document
rewrite: during the first inspection the document was outside the DPR loop, as
described below. Do not use that later hash as the failed-run test identity.

Observed: 31/32 public ownership tests passed. The new
`own_css_rect_stays_inside_opacity_for_every_paint_phase` reused one document
across DPR 1 then 2 and failed with left bound `103.375 != 103.75`.

The test's viewport setup is correct. `Viewport::new` accepts physical size plus
scale (`blitz-traits/src/shell.rs:95–126`). Updating from 448×256 at DPR1 to
896×512 at DPR2 preserves a 448×256 CSS viewport. For scene offset 7, CSS layout
left 32, clip left 16 and CSS translate .375, the expected physical bound is
`7 + (32 + 16 + .375) * 2 = 103.75`. The observed value is exactly
`7 + (32 + 16) * 2 + .375 = 103.375`: layout and clip dimensions scaled while
the stored transform translation retained the DPR1 value.

## Source mechanism

1. `DeviceChanges::from_viewports` in `stylo_device.rs:47–59` detects SCALE, but
   not VIEWPORT_SIZE when logical dimensions are unchanged.
2. `set_viewport` (`document.rs:1947–1951`) queues those changes.
3. `flush_pending_device_changes` (`document.rs:2049–2078`) rebuilds the Stylo
   device. SCALE calls only `invalidate_inline_contexts`; it does not invalidate
   all device-space transform/overflow caches.
4. `invalidate_inline_contexts` (`layout/damage.rs:383–419`) marks nodes with
   inline-layout data, refreshes input editors, and handles anonymous inline
   parents. Ordinary box-only transformed elements are not marked by this walk.
5. `Node::set_transform` (`node/node.rs:408–434`) is already correct when run:
   it resolves CSS coordinates, then applies S*T*S^-1 by scaling only the affine
   translation coefficients. Scaling the painter matrix again would be wrong.
6. `resolve_transforms` (`resolve.rs:163–189`) uses the cached transform and
   scrollable overflow immediately when RECALCULATE_OVERFLOW is absent, without
   descending into the cached subtree. `resolve_layout` marks the synthetic
   document container for overflow refresh, but this does not force every clean
   descendant cache to refresh. The ownership painter consumes that cached
   device-space matrix after scaling current layout offsets separately.

This mechanism explains the failed numeric result without a viewport misuse or
a CSS-rect cap regression. I did not independently instrument the live stored
matrix coefficients; the runtime evidence here is the parent's failed bound
and the matching pinned source path. Existing upstream
`transform_viewport_scale.rs` constructs a fresh document at each DPR, so its
test design does not cover this transition.

## Recommendation

For the current clipping repair, constructing a fresh document at each DPR
cleanly tests first-render clipping and keeps the exact expected bounds. Preserve
this failed transition as separate evidence; do not loosen tolerance, mutate an
unrelated style to force invalidation, or claim live DPR changes validated.

A future bounded correction belongs in scale-change invalidation: refresh
device-space transforms **and their cached overflow ancestry**, including clean
box-only subtrees. Refreshing transformed leaves alone is insufficient because
an unchanged ancestor can stop traversal before reaching them. Prefer the
existing damage/cache mechanism over an extra matrix conversion in painting.
Device changes can also be flushed by stylist access before resolve, so any
temporary force flag must survive until transform resolution actually occurs.

Minimum regression sequence: one unchanged box-only document at DPR
1→2→2→1, constant CSS viewport, checking both stored affine coefficients and
painted bounds. Include pixel and percentage translations, nonzero transform
origin with scale/rotation, an unchanged ancestor, and overflow bounds. Repeat
fresh-document controls to prove scaling still happens exactly once. This is
separate from the known CSSOM API omission of transforms.
