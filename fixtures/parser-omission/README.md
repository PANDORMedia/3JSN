# Optional-parser capability fixture

These original, redistributable inputs exercise a live native UI with HTML
parsing enabled or explicitly unavailable. They contain no acceptance-game
source or assets. Build and run instructions are in the
[compiled UI runtime README](../../experiments/compiled-ui-runtime/README.md).

| File | Purpose |
| --- | --- |
| `index.html` | Static structure, inline CSS, inert template content and the shared window's `#scene` canvas. Compile it with the existing parse5-based UI compiler before runtime. |
| `behavior.js` | Classic script defining `uiProbe.snapshot()`, `mutate()` and `verify(dynamicHtml)`. Also runs without the Three.js scene for DOM/layout measurements. |
| `app.mjs` | Bundled window entry importing Three.js WebGPU and the behavior script. Animates an original torus knot, reports initial state at frame 3 and performs live mutations at frame 30. |

The positive path changes text/classes/styles, dispatches a click, creates and
reattaches a node, and checks existing and detached wrapper identity. Snapshots
contain the text and CSS rectangles of the four `data-probe` elements. The window
scene requires a hardware WebGPU adapter and throws on GPU errors; requesting
120 presented frames exercises its scheduled mutations. A run is evidence only
after its output and failure status have been checked.

`uiProbe.verify(true)` additionally parses dynamic `innerHTML` and checks that
replaced nodes remain accessible through retained wrappers.
`uiProbe.verify(false)` tries seventeen markup/navigation operations, including
empty/body `innerHTML`, uppercase iframe creation, `outerHTML`, fragment/document
parsers and document navigation. Each must throw an explicit capability error
while preserving the snapshot and retained child's identity/parent. It also
checks that `outerHTML` did not become an inert own property. The corresponding
restricted-runtime stubs are diagnostics, not implementations of those browser
APIs or a security boundary.

The paired measurement runner omits verification and compares the initial
snapshot only. It does not measure the animated scene or certify identical
pixels, native input, arbitrary DOM behavior or framework compatibility. Use the
same compiled JSON, font and behavior bytes for both variants; record build,
dependency/link, CPU behavior and GPU/window evidence separately.
