# Generic HTML focus fixture

Original MIT-licensed public fixture for issue #25. `behavior.mjs` exports
`runFocusBehavior()` and installs `focusProbe.run()`. The same source is intended
for a browser and the generic native DOM in either HTML-parser mode; it contains
no React, Three.js, native operations or host-specific fallback. Native support
is not established by authoring this fixture.

Each case records the initial state, synchronous result, microtask boundary,
explicit layout flush, a second microtask boundary, and following timer task. Focus events record document
capture/bubble and target delivery, `relatedTarget`, event phase/flags and
`activeElement` inside each callback. Mutation-return markers and each event's
boundary, target connectivity and parent expose whether dispatch precedes tree
removal. The state also records `:focus` and `:focus-within` query results; three
ordinary-focus controls assert that both pseudo-classes follow the active node.
Setup/reset events are excluded; listeners and the
temporary tree are removed in `finally`.

The cases cover ordinary/repeated focus and blur, body fallback, focus options,
programmatic negative/zero/positive tabindex and parsing/reflection, detached/disabled/inert/hidden/CSS
eligibility, removal/reparenting and eligibility changes while focused, and
reentrant focus from blur/focus/focusout handlers. The `preventScroll` option is
passed on a visible node; scrolling and geometry are outside the comparison.
Attribute/style changes can require style/layout before focus fixup; the explicit
flush boundary prevents recording only an incidental pre-layout state.

`prepareSequentialFocus()` provides separate controls for a browser harness that
sends trusted Tab through CDP. It returns snapshot/focus/reset/dispose functions.
Synthetic keyboard event dispatch does not implement sequential navigation.
Those browser-only observations do not establish native keyboard default actions
or physical OS input. Forms, shadow trees, focus navigation across documents,
selection, IME, accessibility and pointer default actions are outside this probe.
Event constructor, `instanceof FocusEvent` and `isTrusted` are recorded in a
separate `eventInterfaces` field so semantic order/state can be assessed without
claiming complete event-interface compatibility.

Normative references are the [HTML focus model and processing rules](https://html.spec.whatwg.org/multipage/interaction.html#focus),
[focus management APIs](https://html.spec.whatwg.org/multipage/interaction.html#focus-management-apis),
and [UI Events focus events](https://w3c.github.io/uievents/#events-focusevent).
The fixture records actual engine behavior rather than assuming an event-order
table establishes implementation behavior.

## Observed browser reference

`artifacts/dom-focus-reference-01/report.json` records Chrome 153.0.8010.50,
revision `583c5b4655acea7450a3b5224ea5121ae8caca9b`, at an 800×600 CSS viewport
and DPR 1. Its 44 programmatic cases and separate trusted-CDP Tab observations
matched an independent fresh-browser repeat exactly, including source hashes.
There were no browser errors. This is one browser/platform reference, not native
parity or broad DOM conformance.

- Initially `activeElement` was body, while `:focus` and `:focus-within` matched
  nothing. Ordinary A→B focus emitted blur(A), focusout(A), focus(B), focusin(B).
  The old-target callbacks saw body as active; new-target callbacks saw B.
  All four event types were noncancelable. Only focusin/focusout bubbled.
- Repeated focus, blurring an unfocused node, and focusing an ordinary body/div
  caused no change. The visible-node `preventScroll:true` control focused normally.
  Detached, disabled, inert, hidden, display-none and visibility-hidden targets
  were ineligible. Opacity zero remained eligible; `hidden` overridden by
  `display:block` was also eligible.
- Removal and connected reparenting synchronously dispatched blur/focusout
  inside the mutation call. The target was still connected to its old parent
  during both events, with null `relatedTarget` and body active. Setting `hidden`
  also cleared focus synchronously. Disabled/display/visibility/inert changes
  retained A through both microtasks and the explicit layout read, then emitted
  blur/focusout before the following task snapshot. These are measured timing
  observations, not universal scheduling guarantees.
- A blur or focusout listener that focused C prevented the requested B focus.
  A B focus listener that focused C caused B's blur/focusout and C's focus/focusin;
  it did not emit a stale B focusin afterward. The full report retains callback
  ordering and the differing reentrant `relatedTarget` values.
- Programmatic focus reached the tabindex −1 node. Trusted CDP Tab from the
  preceding button skipped it, reached the tabindex 0 node, then the next button.
  All recorded browser focus events were trusted `FocusEvent` instances, despite
  programmatic `.focus()`/`.blur()` calls. Native event branding remains separate.

Parsing was measured on an otherwise nonfocusable div, with A initially active:

| `tabindex` attribute | `.tabIndex` | Focus call result |
| --- | ---: | --- |
| Absent, empty, whitespace, `abc` | −1 | A retained |
| ` +2 `, `2tail` | 2 | Div focused |
| ` -1 ` | −1 | Div focused |
| `2147483647` | 2147483647 | Div focused |
| `-2147483648` | −2147483648 | Div focused |
| `2147483648`, `-2147483649` | −1 | A retained |

The report and repeat both have SHA-256
`8a8b6c1ae2b6e1fd9235aa7a62c2f6b22787592e7367c61f533eb5eaeaa98e38`.
The ignored directory also includes `capture.mjs`, `summary.json` and
`repeat-agreement.json`. From the repository root, after dependencies are installed:

```sh
node artifacts/dom-focus-reference-01/capture.mjs \
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
```

The harness uses the existing bounded `withBrowserSession` helper and closes its
browser, disposable profile and loopback fixture server after each run. No native
build, GPU window or OS input injection is part of this reference.
