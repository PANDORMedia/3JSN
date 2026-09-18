# Stylesheet-driven focus reconciliation browser control

The exact unmodified `experiments/dom-canvas/tests/fixtures/focus-stylesheets.js`
was evaluated in fresh Chrome 153.0.8010.50, revision
`583c5b4655acea7450a3b5224ea5121ae8caca9b`, at 800×600 CSS pixels / DPR 1.
The empty document was fully ready; `Page.bringToFront` preceded an assertion
that `document.hasFocus()` was true and `activeElement` was body.

All three observed modes—appending a stylesheet, replacing its text, and a
`:focus { display:none }` rule—retain the target immediately, after a microtask,
and after the explicit layout read. After the next task, activeElement is body
and `:focus` finds nothing. These match the proposed native expectations.

Two fresh sessions produced byte-identical reports. No browser error,
unhandled rejection, or CDP evaluation exception occurred. The original script
removed its test tree; the final body has zero children. No additional event
listeners were installed on the tested elements and no script statements were
rewritten or inserted into the tested function.

Run from the repository root:

```sh
node artifacts/dom-focus-stylesheets-01/capture.mjs \
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
node artifacts/dom-focus-stylesheets-01/capture.mjs \
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' report-repeat
```

`report.json` retains source identities, raw returned observations, full CDP
execution result, and the proposed expectations separately. `report-source.js`
preserves evaluated bytes; `report-raw-errors.json` preserves empty error
channels explicitly. The repeat files and `repeat-agreement.json` record the
second session. The helper closes the disposable Chrome/profile/connection and
loopback service; the test page itself is a self-contained data URL.

This is a focused Chrome oracle for programmatic focus timing, not native,
physical-input, paint, or general DOM compatibility evidence. No fixture or
runtime source was changed and no native build or GPU probe was run.
