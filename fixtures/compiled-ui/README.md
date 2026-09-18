# Generic compiled-UI fixtures

These redistributable fixtures exercise the
[compiled initial-tree experiment](../../experiments/compiled-ui/README.md)
without acceptance-game source or assets. HTML remains unchanged between the
browser, interpreted-native and compiled-native construction paths.

| Fixture | Purpose |
| --- | --- |
| `dashboard.html` | Ordered stylesheets, live classes/text, button events, hidden elements, flex layout and a DOM canvas |
| `repaired.html` | Foster parenting, implied table structure, formatting-element recovery and character references |
| `namespaces.html` | SVG/MathML identity, qualified attributes and HTML integration points; not a claim of complete foreign-content layout |
| `templates.html` | Nested inert template fragments; their contents and styles must not leak into the active document |
| `cascade-recovery.html` | Foster-parented style elements whose final document order differs from creation order; exposes stylesheet-order ownership bugs |

`behavior.js` is shared by all CPU/browser observations. It records selected
text, rectangles, template visibility and namespace queries, then tests
create/append/remove, retained node identity, inline style mutation and dynamic
`innerHTML`. The dashboard additionally tests a button listener and class/text
updates. It does not serialize the entire DOM or certify all APIs.

`scene.mjs` adds Three.js/WebGPU rendering to the dashboard for the separate
native-window run. Its `#scene` lookup is fixture code, not a compiled-tree format
requirement. It records initial/mutated DOM observations and rotates a mesh;
presentation counts do not prove browser pixel parity or a speedup.

The [experiment README](../../experiments/compiled-ui/README.md#reproduce) gives
compiler, CPU/Chrome and macOS window commands. The supplied fixture font must be
the same input in native and browser comparisons. Browser/layout differences,
including SVG/MathML and inline layout, remain open evidence rather than being
silently accepted. No private game input is required by these fixtures.
