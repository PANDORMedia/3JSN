# Paint ownership and effect clip routing fixture

This original fixture tests the separation of formatting order, geometry owners,
real stacking contexts and contribution-specific clips. It contains only colored
boxes: no text, fonts, images, canvases or private assets. It supplies acceptance
inputs, not a claim of native support. The [ownership investigation](../../docs/investigations/paint-ownership.md)
describes the renderer boundary under test.

Both hosts execute `clipFixture.prepare(name)` on the same HTML. Measured nodes
are `outer` (A), `middle` (B), and `subject` (C). The connected hierarchy is
`body → outer → middle → carrier → subject`, plus a sibling `peer` under `body`.
Every call replaces all seven nodes' inline styles. Only `zero-peer-first` moves
the outer branch after its peer; leaving that state restores their source order.
No nodes are cloned, detached for storage, or recreated. There are no geometry
reads, scroll setters or frame callbacks.

The red subject is always 128×64 CSS pixels with authored color `#e02030`. In the
two opacity cases it belongs to a single 0.5-opacity group over white, so their
case metadata specifies the canonical composited `subjectColor` RGBA
`[240,144,152,255]`. The browser visibility guard must count that color within
two channel levels and require more than 100 pixels. All other cases use the
default opaque red guard. There is no unrelated red sentinel. The smallest
rectangular clip is designed to retain 1,024 subject pixels at scale 1; captures
must verify the actual count. Repeated painting or independently fading the
subject and its blue ancestor can alter these expected colors.

The 18 captures use a 448×256 CSS viewport. One rounded-overflow state repeats
at scale 2, changing physical resolution without resizing the CSS viewport.

| Case | Discriminating control |
| --- | --- |
| `relative-auto-positive` | A relative auto B owns the geometry of positive-z C without containing its stacking context. C must paint above the later zero peer. |
| `absolute-auto-positive` | Making B absolute auto must preserve that non-atomic ownership behavior. |
| `zero-parent-positive` | Explicit zero on B makes its subtree atomic; the later zero peer must cover C's overlap. |
| `fixed-auto-positive` | Fixed B is a real context even at auto. Its positive child must remain below the later zero peer. B's insets preserve the earlier screen location. |
| `sticky-auto-positive` | Sticky B is likewise atomic at auto. This is a zero-scroll ownership control, not a scrolling test. |
| `zero-peer-first` | Moving the zero B branch after its zero peer reverses their overlap order. C stays inside B rather than being independently hoisted. |
| `zero-order-restored` | Restoring source order reproduces the original explicit-zero state on the same nodes. |
| `opacity-fixed-escape` | Overflow-hidden A clips static opacity B's blue background, but viewport-fixed C escapes A. B and C still share one opacity operation. C extends beyond B's border box, exposing incorrectly bounded effect layers too. |
| `opacity-relative-clipped` | Changing C to relative preserves its screen coordinates but makes A's overflow clip apply. Its remaining blended pixels must retain the same color. |
| `clip-group-fixed-escape` | An expanded `clip-path:inset(-80px)` gives B an atomic group and geometrically includes all of opaque C. Despite the case's original hypothesis, the recorded Chrome result clips fixed C at A. This differs from the opacity case and is not a clean opacity-bounds-only control. |
| `clip-group-relative-clipped` | Chrome also clips relative C at A, producing the same 1,024 red pixels as the fixed clip-path case. Retain this pair to investigate the effect-specific difference. |
| `effect-own-overflow-absolute` | A allows overflow, B remains static with its expanded clip-path and hidden overflow, and absolute C is owned geometrically by A. C escapes B's own overflow while remaining in B's effect group. |
| `relative-in-escaping-carrier` | A geometrically owns an absolute auto carrier that escapes B's overflow. C is relative inside it and must escape with it: checking only C's position keyword is insufficient. |
| `css-rect-on-auto-carrier` | Adding `clip:rect(8px,88px,48px,8px)` to that absolute auto carrier clips positive C to an 80×40 rectangle. The carrier's CSS clip must survive extraction of its descendant. |
| `rounded-overflow` | A's 8px border, 8px padding and 32px corner radius clip relative C at the curved padding edge. The subject covers the upper-left clip corner, so a bounding rectangle is distinguishable from the curved clip. |
| `rounded-overflow`, scale 2 | The same curved edge is compared at twice the physical resolution, with unchanged CSS geometry. |
| `clip-group-fixed-restored` | Restoring the expanded group and fixed C after rounded/CSS clips reproduces the earlier Chrome image, including its observed clipping at A. |
| `auto-parent-restored` | Full style reset restores the initial relative-auto positive-child state after all effects, clips and source-order changes. |

For the split-contribution cases, A occupies `(32,24)` with size 128×80; static B
starts there with size 160×112. C occupies `(128,72)` with size 128×64 in both
fixed and relative variants. Only 32×32 of C lies inside A. The recorded Chrome
pixels are:

| Case | B outside A `(180,40)` | C inside A `(140,90)` | C outside A `(220,90)` | Visible subject pixels |
| --- | --- | --- | --- | --- |
| `opacity-fixed-escape` | White | Blended red | Blended red | 8,192 |
| `opacity-relative-clipped` | White | Blended red | White | 1,024 |
| `clip-group-fixed-escape` | White | Opaque red | White | 1,024 |
| `clip-group-relative-clipped` | White | Opaque red | White | 1,024 |
| `effect-own-overflow-absolute` | Blue | Opaque red | Opaque red | 8,192 |

White is RGBA `[255,255,255,255]`, blue `[32,96,224,255]`, opaque red
`[224,32,48,255]`, and the observed blended red `[239,143,151,255]`, within the
declared color tolerance. These are capture-review witnesses, not fixture-side
sampling. The opacity case demonstrates that B's ordinary pixels and fixed C
need different overflow treatment within one atomic group. The expanded
clip-path is large enough to include C, yet its Chrome reference clips C at A.
The reason for this effect-specific difference remains unresolved; these pixels
do not prove a changed containing block or establish behavior across browsers.
All four variants retain the same reported C rectangle. In the own-overflow and
carrier cases A allows overflow to isolate B's clip eligibility.

The three restoration pairs have identical Chrome pixel hashes. At both scales,
the rounded case shows the dark border `[51,51,51,255]` at CSS point `(45,37)`
inside C's bounding rectangle but outside the curved padding clip, while
`(64,40)` is opaque red. Raster-edge samples are not used as exact-color controls.

The distinctions follow [CSS Positioned Layout painting order](https://www.w3.org/TR/css-position-3/#painting-order),
[CSS painting order](https://www.w3.org/TR/CSS22/zindex.html),
[overflow and CSS rect clipping](https://www.w3.org/TR/CSS22/visufx.html#overflow-clipping),
[opacity grouping](https://www.w3.org/TR/css-color-3/#transparency), and
[CSS clip-path](https://www.w3.org/TR/css-masking-1/#the-clip-path).
Browser observations determine the recorded outcomes. Compare identical input
hashes, ordered cases and scale with one native paint before stored geometry
inspection; geometry alone cannot prove order, alpha grouping or clip routing.

The fixture does not claim scrolling, hit-test clip support, arbitrary effects,
3D or transformed CSSOM geometry, inline fragments, font behavior, native-window
presentation or general web compatibility. Existing flex/grid, generated-box
and lifecycle suites remain separate regression controls. No build or browser/
native capture is supplied by these fixture files.
