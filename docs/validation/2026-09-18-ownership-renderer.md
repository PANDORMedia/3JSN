# Experimental ownership rendering — 2026-09-18

The explicit ownership renderer matches **136/142** shared cases for geometry
and uniform interior pixels, compared with **87/142** on the preserved legacy
renderer. All **142/142 interior-pixel comparisons** match. The six remaining
combined failures are DOM geometry mismatches, including hidden-node geometry.
These are offscreen Metal box fixtures on Apple M1 Pro, compared with recorded
Chrome 153 references. They do not establish full-image edge fidelity, general
HTML support, native presentation or performance.

The default renderer is unchanged. Candidate adoption and issues
[#52](https://github.com/PANDORMedia/3JSN/issues/52),
[#54](https://github.com/PANDORMedia/3JSN/issues/54),
[#24](https://github.com/PANDORMedia/3JSN/issues/24) and
[#25](https://github.com/PANDORMedia/3JSN/issues/25) remain open.

## What changed

The candidate adds `paint_scene_with_ownership`, with typed preparation and
paint-budget errors. It consumes the immutable post-layout plan, preserves
geometry ownership, and shares the legacy renderer's primitives and checked
scene lifecycle. Decoration, negative descendants, own content and zero/positive
phases now have explicit order. Contribution-specific clips sit inside one
opacity group, whose conservative bounds retain escaping fixed descendants.
Hidden ancestors no longer discard explicitly visible children.

Solid HTML/BODY canvas backgrounds paint once outside root element clips.
Images and custom widgets receive their own rounded content-edge clip without
changing descendant routes. The latter is covered by recorded-command CPU tests;
it is not a new GPU canvas/image integration claim. The capture host selects a
concrete paint callback while sharing resource creation and cleanup. Read the
[module boundaries and eligibility limits](../../experiments/dom-canvas/OWNERSHIP.md).

## Browser comparison

Every existing fixture and ordered mutation remains intact. The new
[16-capture fixture](../../fixtures/ownership-render/README.md) adds phase,
visibility, offscreen/empty opacity-owner, nested opacity, root offset, DPR and
transform restoration controls.

| Fixture | Legacy geometry + pixels | Ownership geometry + pixels | Ownership interior pixels |
| --- | --- | --- | --- |
| Paint ownership | 10/18 | 18/18 | 18/18 |
| Effect clip routing | 8/14 | 14/14 | 14/14 |
| Auto paint | 5/17 | 17/17 | 17/17 |
| Paint order | 19/20 | 20/20 | 20/20 |
| Initial containing block | 19/21 | 20/21 | 21/21 |
| Positioned layout | 13/14 | 13/14 | 14/14 |
| Overflow | 5/22 | 19/22 | 22/22 |
| New phase/bounds controls | 8/16 | 15/16 | 16/16 |

[Comparison receipts](2026-09-18-ownership-renderer/render-comparisons.json),
[browser reference identities](2026-09-18-ownership-renderer/browser-references.json),
and per-fixture reports/PNGs in the `ownership` and `legacy` archive directories
retain individual failures. All 142 legacy case payloads equal their preserved
references, including all 112 cases from the earlier ownership checkpoint and
the 14 clip-routing controls. Shared primitive extraction did not change them.

The six geometry failures are `transformed-root-fixed` in initial containing
block; `transformed-clip`, `hidden` and `transformed-fixed` in overflow; and
`transformed-fixed` in positioned layout and the new fixture. Their pixel
comparisons pass. Geometry and pixels are deliberately reported separately.

## Errors, lifecycle and checks

The [67 focused candidate tests](2026-09-18-ownership-renderer/checks/candidate-tests.txt)
pass: 42 existing ownership/layout controls, five budget controls and 20 new
public renderer tests. The [14 library tests](2026-09-18-ownership-renderer/checks/library-tests.txt)
include eight clip-route transitions and six checked-scene controls. New tests
cover widget phase order, atomic opacity, empty clips, unsupported errors before
commands, root/BODY backgrounds, DPR/offsets, rounded replaced content and recovery.

The [default profile's 11 tests](2026-09-18-ownership-renderer/checks/default-tests.txt),
21 Node tests, formatting, builds and strict host Clippy pass. The existing
upstream `Intrinsic` warning remains. The broad candidate test command is **not
green**: four DOM geometry expectations that pass on the default profile fail here. The same four failures
[reproduce on the pinned prior ten-patch candidate](2026-09-18-ownership-renderer/checks/prior-geometry-tests.txt),
with its patched source hashes verified. They are not hidden by the focused count.

[GPU lifecycle controls](2026-09-18-ownership-renderer/lifecycle/results.json)
verify default and candidate **legacy** canvas payloads remain unchanged: 21
captures and 27 browser contracts each, initialization/retention behavior, and
cleanup after failure injected after two frames. The new ownership renderer has not run that integrated canvas scenario; its
text remains ineligible. No adoption is implied.

Default, candidate legacy and ownership paths each reject attempted layer 1,025
under the default 1,024-layer limit, clean up, and save no failed-frame PNG/report.
Each matches all three browser controls with the explicit 2,048-layer limit.
Metal validation was enabled; no unexpected GPU errors were observed.

[Preparation controls](2026-09-18-ownership-renderer/preparation-checks/preparation-regression.json)
verify exact trees, repeatability, read-only checks and rejection of tampered,
extra, resurrected or symlinked files for all three profiles. The candidate now
has eleven pinned patches, 413 retained tracked files, nine added files and three
removed files. The default and upstream-baseline patch sets are unchanged.
[Source identity](2026-09-18-ownership-renderer/source-identity.json) records 96
inputs, five executables and preparation receipts; the separate baseline identity
pins the preserved pre-change binaries. The archive contains 370 verification PNGs.

## Remaining adoption gates

Text/inline fragments, broader effects/media, unsupported clip geometry,
transformed or hidden DOM queries, scrolling and clip-aware reverse hit traversal
remain open. Replaying a clip independently around overlapping contributions may
accumulate antialias coverage at fractional edges; add discriminating edge
controls before claiming complete clip-path fidelity. Current comparisons test
uniform interiors and permit the documented color-rounding tolerance.

No benchmark, cross-platform GPU certification or unchanged-game executable is
claimed. [Reproduction commands](../../experiments/dom-canvas/POSITIONED.md#opt-in-ownership-capture)
keep the experimental renderer explicitly selectable.
