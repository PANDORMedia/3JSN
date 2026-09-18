# Initial containing block fixture

This redistributable fixture separates the viewport's initial containing block
from the HTML root's own box in a 448×256 CSS-pixel viewport. It uses ordinary
colored boxes without text, fonts, images or GPU canvases. The subject is opaque
`#e02030`; browser capture must verify more than 100 visible red pixels per case.
Recorded baseline and candidate results are in the
[validation report](../../docs/validation/2026-09-18-initial-owner.md); the candidate
is not adopted.

The browser and native painter execute the same `clipFixture.prepare(name)`.
Each call replaces every fixture node's inline style from a complete base and
the selected overrides. No geometry reads, frame scheduling or viewport emulation
occur in fixture code. All nodes stay connected in
`html#root → body#body → outer → middle → spacer, subject`; `outer`, `middle`
and `subject` are the measured IDs. The root-effect order case moves the existing
spacer after the subject within `middle`; the next case restores their original
order. Other cases do not reorder nodes. Normal ancestors remain real boxes.

The root and body start with natural auto height. Short and tall cases produce
60px and 384px of flow content. Neither document length nor a static root's
margin, border, padding and explicit dimensions should substitute for the
initial containing block. A positioned root can own absolute descendants; a
relative position alone does not make it own fixed descendants. A transform
does establish that fixed owner. These distinctions follow
[CSS Positioned Layout](https://drafts.csswg.org/css-position-3/#def-cb) and
[CSS Transforms](https://drafts.csswg.org/css-transforms-1/#transform-rendering).

| Case | Boundary exercised |
| --- | --- |
| `short-absolute-bottom` | The absolute subject should end at viewport y=256 despite only 60px of document content. |
| `tall-absolute-bottom` | Growing flow content to 384px must not move the subject to the document bottom. |
| `tall-fixed-stretch` | Fixed top/bottom insets use the 256px viewport through the same connected tall tree. |
| `short-viewport-percent` | Absolute percentage insets and both dimensions resolve against the viewport-sized initial containing block. |
| `root-box-absolute-percent` | A static root's 12px margin, 6px border, 10px padding and 300×144 content size do not replace that owner. |
| `root-box-fixed-percent` | Fixed percentages remain viewport-relative despite the sized root and two relatively positioned intermediate ancestors. |
| `relative-root-absolute` | Making the sized root relative transfers absolute ownership to its padding box and applies its relative offset. |
| `absolute-root-absolute` | An absolute root is itself positioned by the initial containing block while its absolute descendant uses the root's padding box; the root must not become its own layout or paint child. |
| `relative-root-fixed` | The same relative root and intermediate positioned ancestors still leave a fixed subject owned by the viewport. |
| `fixed-root-fixed` | A fixed root is itself viewport-positioned; without a transform, a fixed descendant still uses the viewport independently of the root's size and offsets. |
| `transformed-root-fixed` | Transforming the sized root changes fixed ownership, its percentage basis and painted coordinates. |
| `root-fixed-restored` | Removing the transform restores the earlier relative-root fixed state on the same nodes. |
| `viewport-absolute-restored` | Removing root sizing and positioning restores the earlier viewport percentage state. |
| `short-auto-anchor` | Auto insets retain the original flow anchor after a 24px spacer, while the subject's percentage width uses the initial containing block. |
| `root-box-auto-anchor` | Root box decorations move the flow anchor without changing the absolute subject's percentage-width owner. |
| `auto-anchor-restored` | Removing root decorations restores the original auto anchor and percentage width. |
| `root-effect-fixed-auto-order` | A root clip layer preserves tree order: the fixed `z-index:auto` subject precedes a relative `z-index:auto` blue sibling, which must cover their overlap. |
| `root-positive-z-merge-order` | An absolute blue box owned by relative `html` and a later viewport-fixed red subject both have z-index 1; merging them into the same root stacking context must preserve tree order. |
| `root-negative-z-merge-order` | The same owner/order test uses z-index -1, with transparent body and intermediate backgrounds so the later red subject remains visible. |

The root-effect case uses `clip-path:inset(0)`, which creates an effect layer and
stacking context without establishing a fixed-position containing block.
[CSS Masking](https://www.w3.org/TR/css-masking-1/#the-clip-path) applies the clip
after layout. Both overlapping boxes are inside the natural 160px root clip;
this isolates ordering without changing their opaque colors or depending on
fractional-opacity rounding. The red subject remains partially uncovered.
This is one paint-order control, not general clipping conformance.

The last two of 21 captures repeat the sized-root fixed and short-document absolute
cases at device scale 2. Device scale changes physical output resolution; it
does not resize the CSS viewport. This suite does not simulate viewport resizing.
The tall cases use pixel X coordinates and widths so scrollbar-adjusted viewport
width does not become their percentage-sizing question. No CSS hides scrollbars
or suppresses tall-document overflow; any scrollbar rendering remains part of
the recorded browser output.

Capture and compare identical HTML, script and ordered case hashes, viewport
and scales. Native evidence should perform one paint per case, then inspect
stored geometry without a second resolve. Check pixels and geometry separately:
correct ownership does not establish transformed CSSOM coordinates or clipping.
The short/tall and restore sequence is deliberate; capture completion alone is
not a pass.

This is a bounded initial-owner suite. It does not certify scrolling, viewport
resize events, RTL, writing modes, inline containing blocks, fragmented layout,
all effects that establish containing blocks, or general HTML/CSS support.
