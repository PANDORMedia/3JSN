# Focus navigation, pointer default action, and no-box controls

Original MIT control source, captured with Chrome 153.0.8010.50, revision
`583c5b4655acea7450a3b5224ea5121ae8caca9b`, at 800×600 CSS pixels and DPR 1.
The 19 controls each navigate to a fresh document, call `Page.bringToFront`, and
assert `document.hasFocus()` and initial body fallback before setup. Trusted CDP
keyboard/mouse input is used; this is not physical OS input or native validation.
The existing 44-observation focus fixture was not modified or loaded.

Run from the repository root:

```sh
node artifacts/dom-focus-navigation-01/capture.mjs \
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' report.json
node artifacts/dom-focus-navigation-01/capture.mjs \
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' report-repeat.json
```

The disposable browser helper closes Chrome, its debugging connection, profile,
and loopback service. Actual test documents are self-contained data URLs.
`report.json` and `report-repeat.json` are byte-identical; see
`repeat-agreement.json`. Reports retain every captured event, immediate/default
result, post-task state, and input identity. Listeners stop recording and are
removed before test-tree disposal; event counts do not change during cleanup.

## Observed navigation

The tree deliberately puts tabindex 2 before tabindex 1. General forward order:

`positive-one → positive-two → positive-two-later → natural-a → zero → natural-b`

Reverse navigation follows the reverse sequence. Disabled and inert controls and
all negative-tabindex nodes are skipped when entered sequentially. Tied positive
values retain tree order.

| Programmatically focused start | First Tab | First Shift+Tab |
| --- | --- | --- |
| `negative-before` (before every sequential candidate) | `positive-two` | body / no `:focus` |
| `negative` (between natural A and positive one) | `positive-one` | `natural-a` |
| `negative-after` (after every sequential candidate) | `natural-a` | `positive-two-later` |

After reaching a sequential candidate, further navigation uses its tabindex
order. Ordinary document-edge controls first expose body with no `:focus`, and
the following key reenters at the corresponding opposite end. `hasFocus()`
remains true in this headless session, including that body step. No browser
chrome/location-bar focus behavior is inferred from this result.

The [HTML sequential navigation algorithm](https://html.spec.whatwg.org/multipage/interaction.html#sequential-focus-navigation)
selects in tabindex order when the start is sequentially focusable. Otherwise it
uses the nearest suitable candidate in tree order in the requested direction.
An exhausted search reaches document-edge handling; browsers with their own
controls should transfer there. A host without sequentially focusable controls
may restart from its document. Therefore native immediate wrap is an explicit
host policy, not equality with this captured headless Chrome edge behavior.

The `negative-after` forward result is a Chrome/spec discrepancy for this tree.
The exact [Chromium implementation, `NextFocusableElement`](https://chromium.googlesource.com/chromium/src/+/583c5b4655acea7450a3b5224ea5121ae8caca9b/third_party/blink/renderer/core/page/focus_controller.cc#1333)
first scans following nodes for a negative start. If that scan exhausts, it
continues to the greater-tabindex search using the last visited node's index.
Here the final nonfocusable `outside` has -1, so the first zero-index candidate
wins. `focus_controller.cc` retains the exact retrieved source and its original
license header. This explains the observation; it is not a recommendation to
copy that fallback. A native tree-position path must not blindly pick the first
or last tabindex-sorted candidate for every negative start.

## Observed mouse default action

A starts focused; CDP coordinates come from the actual target's bounding rect.
No script-created event is used to claim a browser default action.

| Mousedown control | After mousedown and after mouseup/task |
| --- | --- |
| Ordinary B | B focused |
| B handler calls `preventDefault()` | A retained |
| B handler removes B | body / no `:focus` |
| B handler disables B | body / no `:focus` |
| Nonfocusable div outside the buttons | body / no `:focus` |
| Negative-tabindex div | negative div focused |

The remove/disable handlers record their before/after state. A remains focused
inside those handlers; the default action then clears it. Mouseup may hit a
different node after removal; the complete event sequence is retained, without
claiming a click target guarantee for that case.

## Observed display: contents eligibility

Computed style is asserted to be `contents` before every attempt. A div with
explicit tabindex 0 and a natural button each fail to acquire focus when their
own display is `contents`; A remains focused and no focus events occur. A normal
button underneath a `display: contents` ancestor remains eligible. This supports
rejecting a candidate's own absent box without rejecting its rendered descendants.

This fixture covers one plain document without shadow DOM, reading-flow,
embedded documents, forms, IME, accessibility configuration, OS keyboard
preferences, or native hit-testing. It does not establish general browser focus
compatibility.
