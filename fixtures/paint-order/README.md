# Paint order fixture

This original colored-box fixture compares painting order independently of
containing-block ownership in a 448×256 CSS-pixel viewport. It contains no text,
fonts, images or canvases. The red subject is opaque `#e02030`; blue and green
controls only partially overlap it, leaving more than 100 red pixels for the
browser runner to verify. Captures and CPU assertions remain research evidence,
not full CSS or native compatibility certification.

Both hosts load the same HTML and call `clipFixture.prepare(name)`. The measured
IDs are `outer`, `middle` and `subject`. Every call resets all seven elements'
styles and the pseudo-element selector attribute. Geometry is never read by the
fixture. The 20 ordered captures include two at device scale 2; the CSS viewport
does not change.

| Cases | Control |
| --- | --- |
| `owners-positive`, `owners-negative` | Earlier absolute blue peer and later viewport-fixed red subject have equal +1/-1 z-index. Different geometry owners merge into one root stacking context; the red subject should cover their overlap. Intermediate backgrounds are transparent. |
| `effect-auto-order` | Root `clip-path:inset(0)` supplies an effect layer without changing fixed ownership. A later relative blue peer must cover the earlier fixed red subject at z-index auto. Both boxes lie inside the root clip and retain opaque colors. |
| `flex-order-forward`, `flex-order-reverse`, `flex-order-reset` | Two real flex items overlap using negative trailing margins. Changing the earlier blue peer's CSS order above/below the red subject must change paint order, then reset it. |
| `flex-oof-order-negative`, `flex-oof-order-positive` | An absolute red child has order -9, then +9. It is not a flex item; its paint position uses order zero against the relative blue item's order 1. Changing the ignored value must not change the image. |
| `grid-order-forward`, `grid-order-reverse`, `grid-order-reset` | Overlapping items explicitly occupy one grid area. CSS order changes painting without moving them to different cells. |
| `grid-oof-order-positive` | The absolute red child has order 9 while the relative grid item has order 1. The out-of-flow box's order-zero behavior is compared to the browser. |
| `contents-flex-order`, `contents-grid-order` | The subject moves into a `display:contents` wrapper that precedes the blue peer. Its own order 1 must sort after the peer's -1; the boxless wrapper's -100 must not replace its child's order. |
| `pseudo-order-ties`, `pseudo-order-flipped` | Empty `::before` and `::after` boxes overlap the real subject. Equal order uses generated-tree order; changing before/after to +2/-2 reverses their order around the subject. No glyphs or font metrics are needed. |
| `dom-peer-last`, `dom-order-restored` | Moving the blue peer after the red subject reverses equal-z painting; restoring their original sibling order restores the positive-owner control. |

The normal hierarchy is `outer → middle → bridge, peer, subject`. The bridge is
empty and hidden except in the contents cases. Those cases keep it under the same
middle node and move the subject inside it. Explicit order cases move the peer
after the subject; the next normal case restores the original tree. DOM mutations
occur only when these tree modes change, so repeated CSS-order changes do not
silently force a sibling rebuild. Every measured node stays connected.

The rules under test are described by
[Flexbox painting](https://www.w3.org/TR/css-flexbox-1/#painting),
[out-of-flow flex children](https://www.w3.org/TR/css-flexbox-1/#abspos-items),
[Grid painting](https://www.w3.org/TR/css-grid-1/#z-order), and
[CSS Masking](https://www.w3.org/TR/css-masking-1/#the-clip-path).
Browser captures determine the observable result for these exact cases; do not
adjust the expected order to agree with the current native algorithm.

Compare matching fixture identities, ordered cases and scale, with one native
paint before geometry inspection. Pixel overlap matters: a geometrically
correct layout can still paint in the wrong order. Public CPU tests inspect the
resolved stacking lists for explicit participants; they do not recreate a sort
algorithm or substitute for the effect-layer and antialiasing comparison.
Accessibility order, fragmentation, writing modes, arbitrary nested effects and
general clipping remain outside this suite.

## Hit targets and lifecycle

The separate `hit.html` fixture is shared by the native Rust tests and
`scripts/compatibility/paint-hit-reference.mjs`. Two overlapping boxes have
different geometry owners but equal positive or negative z-index. Moving each
box to the end of its parent's children changes the expected overlap target.
Three mutation cycles and repeated resolves exercise 48 point/target assertions.
Explicit pointer-event settings let the negative-z boxes receive input through
transparent ancestors. This tests the public `elementFromPoint` result for these
boxes; it does not certify general native input routing.

Additional Rust tests check resolved paint order through flex/grid ancestors,
`display:contents`, pseudo-elements and real anonymous wrappers. Retaining and
reattaching a detached subtree, and hiding/showing mixed inline/block content,
exercise stale stacking lists and wrapper deletion across cached resolves.
