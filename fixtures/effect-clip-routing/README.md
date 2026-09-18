# Effect clip routing controls

These 14 original box-only controls isolate the opacity/clip-path difference in
[paint-ownership](../paint-ownership/README.md). They use a 448×256 CSS viewport
and the shared `clipFixture.prepare(name)` contract. Every call replaces all
seven nodes' inline styles; the connected tree remains
`body → outer (A) → middle (B) → carrier → subject (C)`, with a hidden peer.
There are no geometry reads, frame callbacks, fonts, assets or private inputs.
Native and browser hosts must execute the same files in the recorded order.

C remains `position:fixed`, with authored `(left,top,width,height)` equal to
`(128,72,128,64)` in every control. Its geometry must be measured independently
of its visible pixels. A normally occupies `(32,24,128,80)` and B
`(32,24,160,112)`. The expanded path includes C; changing clipping does not
imply a different containing block.

The controls were first exercised as in-memory mutations of the unchanged
paint-ownership fixture in Chrome 153.0.8010.50, revision
`583c5b4655acea7450a3b5224ea5121ae8caca9b`. Those exploratory captures explain the
predictions below. They are **not captures of these new file identities**;
regenerate browser/native reports from these files before claiming fixture
parity or native support. The subsequent
[official checkpoint](../../docs/validation/2026-09-18-paint-budget.md) captures
these exact fixture inputs: all 14 Chrome visibility predictions match, while
the native renderer matches 8/14 before and after the independent budget fix.

| Case | Observed exploratory subject pixels | Discriminating change |
| --- | ---: | --- |
| `clip-baseline` | 1,024 | Static B's expanded path under A's overflow. |
| `opacity-baseline` | 8,192 blended | One opacity group retains escaping fixed C. |
| `no-effect` | 8,192 | Ordinary fixed overflow escape. |
| `clip-expanded-2000` | 1,024 | A much larger path leaves the same ancestor clip. |
| `clip-on-fixed-subject` | 8,192 | Path is formed in C's fixed context. |
| `clip-on-overflow-ancestor` | 8,192 | A's path precedes A's own descendant overflow. |
| `clip-with-opacity` | 1,024 blended | Adding opacity does not undo the path's clip chain. |
| `clip-with-ancestor-overflow-visible` | 8,192 | Removes the ancestor overflow that the path captures. |
| `clip-with-own-overflow-only` | 8,192 | B's own later overflow does not reach C. |
| `css-rect-absolute-middle` | 8,192 | Expanded CSS rect follows a different fixed clip chain. |
| `clip-absolute-middle` | 1,024 | Absolute B still has A as containing block. |
| `clip-fixed-middle` | 8,192 | Fixed B selects a viewport context before creating its path. |
| `clip-middle-escapes-static-ancestor` | 8,192 | Absolute B escapes static A's overflow. |
| `clip-restored` | 1,024 | Full style reset reproduces the initial state. |

The static-A control deliberately preserves the tested margin behavior: A's
24px top margin collapses through body, so B's measured y becomes 48px while A
stays at y=24px. C stays at y=72px with the viewport as its fixed reference. This
case must not be described as keeping every ancestor rectangle unchanged.
The fixed-B control does preserve B's original `(32,24)` location.

The two opacity cases specify `subjectColor: [240,144,152,255]`; exploratory
Chrome pixels were `[239,143,151,255]`, within the shared two-level tolerance.
All other subjects use `#e02030`. Every capture must retain over 100 subject
pixels. Useful witness points are B outside A at `(180,40)`, C inside A at
`(140,90)`, and C outside A at `(220,90)`. Do not substitute geometry agreement
or a paint return code for actual screenshot comparisons.

## Exact implementation evidence

In the tested revision's
[paint property builder](https://chromium.googlesource.com/chromium/src/+/583c5b4655acea7450a3b5224ea5121ae8caca9b/third_party/blink/renderer/core/paint/paint_property_tree_builder.cc#2847),
`UpdateClipPathClip` parents the new path to the current clip and supplies it to
normal, absolute and fixed descendant clip contexts (lines 2847–2864). Static
B therefore carries A's overflow into C's clip chain without changing C's
geometry. B's own overflow is established later (lines 4337–4347).

[`EffectCanUseCurrentClipAsOutputClip`](https://chromium.googlesource.com/chromium/src/+/583c5b4655acea7450a3b5224ea5121ae8caca9b/third_party/blink/renderer/core/paint/paint_property_tree_builder.cc#1906)
avoids a blanket effect output clip when non-contained positioned descendants
can escape. The corresponding
[opacity/fixed-descendant unit test](https://chromium.googlesource.com/chromium/src/+/583c5b4655acea7450a3b5224ea5121ae8caca9b/third_party/blink/renderer/core/paint/paint_property_tree_builder_test.cc#6481)
checks that distinction. CSS rect has another path: it can clone its shape under
the fixed clip context, preserving that context's eligible ancestors
([lines 3838–3858](https://chromium.googlesource.com/chromium/src/+/583c5b4655acea7450a3b5224ea5121ae8caca9b/third_party/blink/renderer/core/paint/paint_property_tree_builder.cc#3838)).

## Standards boundary

[CSS overflow](https://www.w3.org/TR/CSS22/visufx.html#overflow-clipping) exempts
outside-containing-block descendants and their content from intermediate
overflow clips. [CSS Masking](https://drafts.csswg.org/css-masking/#clipping-paths)
applies paths to descendants and describes cumulative clipping without changing
geometry. Its [clip-path rule](https://drafts.csswg.org/css-masking/#the-clip-path)
creates a stacking context; that alone is not a fixed containing block.
These statements do not explicitly resolve every interaction between an
otherwise escapable overflow clip and a descendant clip-path.

A proposal to make clip and clip-path uniformly follow overflow's hierarchy,
[CSSWG 495](https://github.com/w3c/csswg-drafts/issues/495), moved to
[FXTF 131](https://github.com/w3c/fxtf-drafts/issues/131). The latter closed in 2018
without adopting that uniform rule. The inspected WPT
[fixed nested path](https://chromium.googlesource.com/chromium/src/+/583c5b4655acea7450a3b5224ea5121ae8caca9b/third_party/blink/web_tests/external/wpt/css/css-masking/clip-path/clip-path-fixed-nested.html)
and [fixed scroll path](https://chromium.googlesource.com/chromium/src/+/583c5b4655acea7450a3b5224ea5121ae8caca9b/third_party/blink/web_tests/external/wpt/css/css-masking/clip-path/clip-path-fixed-scroll.html)
tests establish related clip-path ancestry controls, but neither tests this
specific A-overflow/B-path/C-fixed combination.

The recorded expectations identify one Chrome implementation. They do not
establish universal normative behavior or agreement across browsers. Opacity,
CSS rect, clip-path and overflow need distinct clip propagation rules; applying
one blanket ancestor clip around every effect is contradicted by these controls.
Scrolling, filters, masks, fragmented inline effects, hit testing and 3D remain
outside this fixture's scope.
