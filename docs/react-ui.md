# React on the native UI tree: research options

Status: a research comparison prompted by the React-renderer idea, not an adopted
architecture change. The product goal remains unchanged application source,
including required HTML/CSS and browser APIs. See the [product contract](product.md)
and [compiled UI decision](adr/0003-compiled-ui-and-generic-compatibility.md).

## Two integration boundaries

| Approach | Boundary and ownership | Main question |
| --- | --- | --- |
| Upstream `react-dom` over generic native DOM bindings | React calls ordinary DOM APIs; those bindings mutate the authoritative native document already used by non-React code. | Can the shared browser-facing APIs preserve the application's observable behavior? |
| A custom renderer using upstream `react-reconciler` | A new host configuration translates React's instance creation and commits into operations on that same native document. | Can a different React host preserve the required React DOM and web-library behavior at an acceptable maintenance cost? |

The current fixture explores the first route. The second could reuse React's
reconciliation rather than fork React, but it would still introduce a renderer
owned by 3JSN. The [official reconciler README](https://github.com/facebook/react/blob/main/packages/react-reconciler/README.md)
labels the package experimental, warns that its API is less stable than React DOM,
and explains that host configuration changes frequently between releases. It is
not a stable replacement interface that can be adopted without version-specific
work and regression tests.

Either route should feed **one authoritative live document, one style/layout/text
path and one GPU composition path**. React's internal component tree is not a
second layout document. A custom host must not create an independent visual tree
whose identity, measurements or event ownership diverge from nodes visible to
ordinary JavaScript.

## Compatibility and performance questions

Replacing an import is not enough to preserve an existing web application. Refs
may expose real element methods and identity; portals target existing containers;
focus, selection and measurement can occur during effects. React event semantics
interact with ordinary listeners, cancellation and propagation. Animation, UI and
accessibility libraries may read or mutate the DOM directly. Those behaviors still
need a coherent implementation even when React commits use a different entry point.
Maintaining the generic DOM therefore remains necessary for the unchanged-source
contract. Omitting an HTML string parser is a separate capability choice.

A commit-oriented host might reduce calls across the JS/native boundary or batch
style invalidation. That is an **unmeasured performance hypothesis**. Generic DOM
bindings may also permit safe batching, provided synchronous queries and mutation
ordering retain their meaning. React reconciliation, JavaScript effects, style
evaluation, text shaping and layout still require CPU work; native GPU painting
does not eliminate them. Compare the same workload and build settings before
claiming a speed, memory or frame-time improvement.

## Bounded evidence first

The [public React task-board fixture](../fixtures/react-dom/README.md) uses upstream
React DOM to construct a dashboard under an initially empty container. Its intended
checks cover asynchronous render/effect completion, delegated synthetic clicks,
state/class/style/text updates, keyed insertion/reordering/removal, retained node
identity, cleanup and remount. The companion window places an ordinary Three.js
canvas beside the dashboard through the existing composition path.

The [React DOM checkpoint](validation/2026-09-18-react-dom.md) is the destination
for recorded browser/native comparisons, executable identities and native-window
results. The fixture and harness define acceptance checks; their existence alone
does not establish that those checks pass. A window must report completed React
verification as well as presented frames. Semantic comparison does not establish
pixel equivalence, and dispatched clicks do not establish native OS input.

Even a passing run would cover this client-rendered fixture only. SSR/hydration,
Suspense, transitions, portals, forms/selection, accessibility, arbitrary web
libraries, broader CSS/layout, physical input and other platforms remain separate
compatibility work. The experimental bindings retain node wrappers until realm
teardown; effect cleanup is not a memory-reclamation result. Repeated creation and
unmounting can therefore grow retained memory with the cumulative number of nodes,
even when application references have been dropped. Long-running React sessions
remain unverified.

Live child collections also rebuild the native child/sibling description on each
length or indexed read. Iterating a collection of `n` children performs repeated
`O(n)` work, so a full traversal can be `O(n²)`. This is source-level complexity,
not a measured benchmark. Caching must preserve synchronous liveness and mutation
visibility; the small fixture does not establish large-list performance.

This note neither implements a custom renderer nor redirects the roadmap. A
custom-host experiment would need an explicit scope, shared-tree invariants and
an observable benefit before becoming an architectural choice.
