# Positioned layout fixture

This redistributable fixture isolates containing-block ownership and original
static-position anchors in a 448×256 CSS-pixel viewport. It uses ordinary colored
boxes, no text, fonts, images or GPU canvases. The subject is opaque `#e02030`.
Browser captures must contain more than 100 visible subject pixels in every case.
Capture completion alone is not a native compatibility result.

The same HTML and JavaScript run in the browser and native DOM painter through
`clipFixture.prepare(name)`. `cases.json` defines 14 ordered captures, including
two at device scale 2. Each call resets every fixture node's inline style from a
complete base; it does not read geometry, schedule frames or mutate ancestry.
The generated boxes remain in the original DOM hierarchy:
`outer → bridge → middle → spacer, subject`. All three measured IDs (`outer`,
`middle`, `subject`) remain connected and queryable.

HTML and body retain their natural auto height. The first two cases produce
60px of flow content, deliberately less than the viewport; other cases place
the outer box out of flow. No `height:100%` rule makes the document root stand
in for the initial containing block. The bridge is a normal static box, not a
`display:contents` or positioning workaround.

| Case | Question exercised |
| --- | --- |
| `short-root-absolute-bottom` | Does an absolute box with no positioned ancestor use viewport-height initial-containing-block geometry? The 24px subject should end at y=256 despite only 60px of flow content. |
| `short-root-fixed-stretch` | Do top/bottom fixed insets stretch against the 256px viewport? The subject should extend from y=16 to y=240. |
| `absolute-percent-escape` | Do insets and 50% width resolve against the 320px positioned outer box across static ancestors? Translating a wrongly sized box is insufficient. |
| `block-auto-anchor` | Does an absolute box keep the original flow anchor after a preceding 28px block, while its 50% width uses the outer owner? |
| `flex-auto-anchor` | Does the original static flex parent supply end/center alignment after the subject's width resolves against the different containing block? |
| `grid-static-anchor` | Does a static grid parent supply the static-position alignment area without becoming the subject's containing block? Grid placement and self-alignment remain present in the source. |
| `grid-owner-area` | Does an absolute descendant use grid placement at its actual positioned grid owner across static intermediates? Its percentage width depends on that area's width. |
| `viewport-fixed` | Does a fixed subject escape positioned ancestors when none establishes a fixed containing block? |
| `transformed-fixed` | Does adding a transform make the middle box the fixed-position owner, including its percentage-width basis? |
| `viewport-fixed-restored` | Does removing the transform restore viewport ownership on the same nodes? |
| `relative-descendant-escape` | Does a relative child of an absolute ancestor remain visible outside an intermediate overflow-hidden box that the absolute ancestor escapes? |
| `absolute-percent-restored` | Does resetting positioning, overflow and layout modes restore the earlier percentage case on the same nodes? |

The final block/grid repetitions exercise the same source at scale 2. The
browser runner waits for rendering outside the fixture; native evidence should
read the stored layout after one paint, without an extra resolving geometry
call before painting. Compare identical source hashes, case order, viewport and
scale, with geometry and pixels reported separately.

This is a bounded ownership suite. It does not cover positioned inline spans,
vertical writing modes, RTL, scroll offsets, fragmentation, intrinsic text sizes,
all grid/flex alignment rules or arbitrary ancestor effects. The relative-child
case is one overflow-escape control, not general clipping conformance. Root
versus viewport ownership, transform geometry, paint clipping and no-box geometry
remain separate failures when comparing native output.
