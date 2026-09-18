# Own CSS rect and opacity boundary

Original MIT-licensed box-only research input. The
[measured checkpoint](../../docs/validation/2026-09-18-css-rect-effect.md) records
Chrome, prior native and repaired native captures. The same connected DOM
and `clipFixture.prepare(name)` protocol support the existing browser/native
capture tools at a 448 × 256 CSS viewport. The measured IDs are `outer`, `middle`
and `subject`.

Four families each contain a single-red and covered-blue state at DPR 1 and 2:
16 captures and eight equal-scale complete-image comparisons. Every preparation
replaces all six retained nodes' style attributes. There are no geometry reads,
timers, text, fonts, assets, network dependencies or other colored boxes.

| Family | Own polygon P | Own CSS rect R | Opacity |
| --- | --- | --- | --- |
| `rect-alpha-one` | None | Present | 1 |
| `rect-opacity-half` | None | Present | 0.5 |
| `polygon-rect-alpha-one` | Broad nonrectangle | Present | 1 |
| `polygon-rect-opacity-half` | Broad nonrectangle | Present | 0.5 |

The absolutely positioned owner is 240 × 160 CSS pixels at (48,40), with
`transform:translate(0.375px,0.25px)` and
`clip:rect(16px,208px,136px,24px)`. R therefore spans local x=24…208, y=16…136.
Its expected scene edges are x=72.375…256.375 and y=56.25…176.25, retaining
fractional device coordinates at both DPRs. Capture must verify the resulting
geometry and intermediate edge colors; a rounded or snapped implementation may
otherwise make the comparison nondiscriminating.

P is the convex quadrilateral (-16,-8), (256,0), (248,176), (-8,168). It is
nonrectangular and strictly contains all four corners of R. Thus only R supplies
the visible clip boundary. Both opaque child rectangles cover local
x=-16…256, y=-16…176; the later red subject fully covers the toggled blue underlay.
Only underlay visibility changes within each pair. No containing-block escape
or signed-z ordering variation is introduced.

## Composition boundary

At captured Chrome revision `583c5b4655acea7450a3b5224ea5121ae8caca9b`,
[paint property construction](https://chromium.googlesource.com/chromium/src/+/583c5b4655acea7450a3b5224ea5121ae8caca9b/third_party/blink/renderer/core/paint/paint_property_tree_builder.cc#4276)
orders `UpdateClipPathClip`, `UpdateEffect`, then `UpdateCssClip`.
[Effect creation](https://chromium.googlesource.com/chromium/src/+/583c5b4655acea7450a3b5224ea5121ae8caca9b/third_party/blink/renderer/core/paint/paint_property_tree_builder.cc#2164)
captures the current eligible output clip before the owner's CSS rect is added.
This motivates distinguishing incoming/path clipping from the owner's later R.
It does not prove which raster/compositor route these captures will take.

The prior opacity repair capped its common prefix at decoration, whose route
already includes R. Captures show that this incorrectly makes the four
half-opacity groups invariant, while Chrome is noninvariant in all eight groups.
The repaired renderer caps the shared output prefix immediately after P, before
the owner's R. Its eight groups now match Chrome's invariant/noninvariant
classification. This is not full-image cross-renderer equality: edge colors still
differ, and all 16 geometry comparisons retain transformed-CSSOM query errors.
Uniform interiors match in all 16 cases. General polygon grouping remains open.

`invariants.json` records complete RGBA equality as a diagnostic, with no pixel
exclusions or channel tolerance. Record differing-pixel counts, maximum channel
delta and intermediate-color coverage even when exact equality fails. Compare
each renderer separately, then run the independent browser/native geometry and
uniform-interior comparison. Existing transformed-CSSOM limitations must remain
visible rather than being reclassified as clip-composition failures.

Opacity-one cases declare red `[224,32,48,255]`; half-opacity cases declare
`[240,144,152,255]`, canonical red over white. The existing subject-color matcher
allows its normal two-level tolerance for the greater-than-100 visibility guard.
The expected interior area is large, but capture must verify that guard. This
white-background fixture measures RGB composition, not varying-alpha fidelity.
Do not loosen exact comparison, exclude edges, or assume that a nonidentical
pair alone proves a standards violation.
