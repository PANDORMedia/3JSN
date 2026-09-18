# Ownership renderer phase and bounds controls

Original, redistributable MIT-licensed boxes for the experimental ownership
renderer. The [recorded Metal/browser comparison](../../docs/validation/2026-09-18-ownership-renderer.md)
matches all 16 uniform-interior pixel controls; transformed geometry remains
incorrect in one case. The ordinary `clipFixture.prepare(name)` interface and measured IDs
`outer`, `middle`, `subject` use a 448 × 256 CSS viewport. There are 16 captures
and 15 named states. Preparation replaces every fixture node's complete style
attribute. It does not read geometry, fetch resources, set scroll offsets, or
recreate the connected DOM. There are no fonts, private assets or painted text.

| Case | Discriminating expectation |
| --- | --- |
| `negative-before-inflow` | Blue context decoration precedes the negative red child; the green in-flow background then covers part of red. An uncovered red strip remains. |
| `zero-after-inflow` | Changing only red's z-index to zero places it above green. |
| `negative-restored` | Restores the first image after a paint-phase mutation. |
| `hidden-ancestor-visible-child` | Hidden blue/green ancestors suppress their own pixels; explicitly visible red remains painted. |
| `visibility-restored` | Restores the first image after inherited visibility changes. |
| `opacity-fixed-escape` | Blue is clipped to outer overflow; fixed red escapes that clip but shares blue's single opacity group. Their overlap distinguishes group opacity from opacity per leaf. |
| `opacity-relative-clipped` | Red retains the same untransformed rectangle but now inherits the overflow clip. A 32 × 32 region remains visible. |
| `opacity-fixed-restored` | Restores fixed clip escape without rebuilding nodes. |
| `opacity-owner-offscreen` | An opacity owner at (632,424) still owns viewport-fixed red at (128,72); owner-border culling must not remove red. |
| `opacity-owner-zero-size` | A zero-size opacity owner still paints its visible fixed descendant. |
| `opacity-owner-restored` | Restores the earlier clipped-blue/fixed-red image after owner bounds changes. |
| `nested-opacity-fixed` | Red participates in two nested half-opacity groups, including outside outer overflow. Moving red out of either effect or flattening effects changes pixels. |
| `offset-root-fixed` at 1× and 2× | Root margin, border, padding and relative offset do not move viewport-fixed red. Detects duplicated root compensation and incorrect device scaling. |
| `transformed-fixed` | A translated and scaled middle owns fixed red; red's painted rectangle is (76,60,192,96). The transform must be applied exactly once. |
| `all-styles-restored` | Restores the first image after effects, root decoration, DPI and transform mutations. |

Every state is designed to retain more than 100 visible subject pixels at 1×.
The default subject is opaque `#e02030`. Half-opacity states declare canonical
RGBA `[240,144,152,255]`, and the nested state declares `[247,199,203,255]` for
red over white outside the overflow box. The capture protocol allows its
documented two-channel-unit rounding tolerance. Browser capture must verify
these guards; no separate sentinel substitutes for the subject itself.

The transformed case intentionally remains in the shared GPU suite even where
native CSSOM transformed bounds are unsupported. Report paint and geometry
results separately. The fixture does not assert that native geometry is already
correct or infer transform behavior from a successful build.

The companion CPU integration test uses an original recorded custom-widget
scene on a block element. It proves negative descendants paint before the
owner's content while retaining real positioned children. This avoids inventing
browser-visible descendants inside replaced canvas fallback content. It is a
paint-phase contract, not a claim of full Canvas2D or replaced-element support.

The intended phase order follows [CSS 2 painting order](https://www.w3.org/TR/CSS22/zindex.html).
Opacity must composite a group, as described by [CSS Color 3 transparency](https://www.w3.org/TR/css-color-3/#transparency).
Browser pixels remain the reference for this bounded fixture; scrolling, text,
3D transforms, filters and full inline layout remain separate acceptance work.
