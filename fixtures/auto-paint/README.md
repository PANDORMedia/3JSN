# Auto paint ownership and clipping fixture

This original box-only fixture separates paint order, stacking-context boundaries
and applicable overflow clips. It has no fonts, text, images, canvases or private
assets. Both hosts load the same HTML and invoke `clipFixture.prepare(name)`.
The measured IDs are `outer`, `middle` and `subject`.

The connected tree stays `outer → middle → subject`, followed by
`outer → branch → peer`. The earlier red subject is always 128×64 CSS pixels
with opaque `#e02030`; the later blue peer is 80×64. Their partial overlap leaves
red visible even when blue paints above. Opacity affects only the blue branch.
The narrowest clipped case is designed to leave 992 exact red pixels at scale 1;
browser capture must independently enforce more than 100 visible red pixels.

Each preparation replaces all seven nodes' inline styles from the base plus the
selected overrides. The tree is not rebuilt between cases. There are no geometry
queries, scroll setters or frame scheduling in the fixture. The 17 ordered
captures use a 448×256 CSS viewport: 16 states at scale 1 and one repeated state
at scale 2. Device scale changes physical output dimensions, not the CSS viewport.

| Case | Rationale and expected distinction |
| --- | --- |
| `root-fixed-auto` | The earlier viewport-fixed red box and later relative blue box both use auto z-index. Blue covers their overlap through otherwise static branches. |
| `root-effect-fixed-auto` | A root `clip-path:inset(0)` adds an effect layer. Both boxes remain inside it; the later blue peer should still cover red. The clip does not replace the viewport as the fixed containing block. |
| `positioned-branches-auto` | Both intermediate branches become relative with auto z-index. Their positioned descendants still participate in the enclosing stacking context; blue remains above red. |
| `auto-branch-positive-child` | Red becomes an absolute z-index 1 child of the relative auto middle. Its positive stacking context participates outside that auto wrapper and should cover the later auto blue peer. |
| `zero-branch-positive-child` | Changing only the middle's z-index to zero creates an atomic context. Its positive red child now remains below the later auto blue peer. |
| `static-opacity-branch` | The static blue branch has opacity 0.5, its child z-index 9, and external red z-index 1. The opacity context contains blue's positive child, leaving red above the overlap without fading red. |
| `static-transform-branch` | Replacing opacity with an identity transform creates a real context on the same static branch. Blue's z-index 9 remains inside it, below external red. Identity translation avoids a transformed-coordinate question. |
| `static-effect-removed` | Removing that effect lets blue's z-index 9 participate in the enclosing context again, above red's z-index 1. This is a restoration control for the same nodes. |
| `relative-auto-clip` | A relatively positioned auto red descendant extends beyond a relative 96×48 middle with hidden overflow. Reordering its paint must preserve this local clip and the later blue overlap. |
| `absolute-contained-clip` | Absolute red has the same bounds, with its containing block at the clipping middle. It must remain clipped. |
| `absolute-escape-clip` | Making the middle static transfers absolute ownership to the outer box. The intervening middle overflow does not clip that absolute descendant; red geometry stays the same. |
| `fixed-escape-clip` | A relative middle cannot contain the viewport-fixed red box. Its overflow must not clip red. |
| `fixed-transform-clip` | An identity transform makes the middle contain fixed red. Local insets preserve the earlier screen coordinates, but the middle's overflow now clips it. |
| `absolute-clip-removed` | Returning to contained absolute red while removing hidden overflow exposes its full bounds. |
| `absolute-clip-restored` | Restoring hidden overflow must reproduce the earlier contained-absolute clip after the fixed-owner and effect mutations. |
| `root-fixed-restored` | All temporary clips, effects, dimensions, positioning and z-index changes are removed; the original fixed-auto state must return. |
| `fixed-transform-clip`, scale 2 | The same fixed-owner clip is captured at twice the physical resolution, with unchanged CSS geometry and ordering. |

The auto-versus-zero distinction follows [CSS painting order, Appendix E.2](https://www.w3.org/TR/CSS22/zindex.html).
[CSS Color opacity](https://www.w3.org/TR/css-color-3/#transparency) defines the
static opacity context; [CSS Transforms](https://www.w3.org/TR/css-transforms-1/#transform-rendering)
defines both the transformed context and fixed containing block.
[CSS overflow and clipping](https://www.w3.org/TR/CSS22/visufx.html#overflow-clipping)
describes the intervening-ancestor exception for absolute descendants.
[CSS Masking](https://www.w3.org/TR/css-masking-1/#the-clip-path) defines the root
clip layer. These references explain the controls; browser observations remain
the authority for the recorded cases.

Capture identical HTML, script and case-list identities with one native paint
before inspecting stored geometry. Compare geometry and uniform interior pixels
separately. The fixture deliberately retains expected native failures rather
than moving elements or suppressing clips to fit the current renderer.
It does not establish general CSS compatibility, scrolling, hit testing,
transformed CSSOM geometry, nested effect composition or native presentation.
Browser and native evidence is kept separately under `docs/validation` so the
fixture remains an independent input to either host.
