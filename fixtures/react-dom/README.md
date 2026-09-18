# React DOM task-board fixture

Original, redistributable application code using the pinned React 19.3.0 and
React DOM 19.3.0 packages. React constructs every dashboard node under the empty
`#root`; the one static `#scene` canvas serves the existing experimental window
and package contract. There is no React Three Fiber, alternate DOM, framework
patch, host-specific shim, `flushSync`, hydration, or pre-rendered dashboard.

`application.mjs` uses `createRoot().render()`, `useState`, passive `useEffect`
setup/cleanup and React event delegation. Commits are observed from effects;
bounded promises wait for them without forcing synchronous rendering. Missing
React scheduler/event-loop support must fail or time out. The fixture is not
wrapped in StrictMode, so intentional development-mode effect replay is outside
its exact lifecycle counts.

`behavior.mjs` is the CPU entry. Bundle it as a browser IIFE to obtain the classic
script expected by `--measure-layout` or `--measure-app`; it installs
`uiProbe.snapshot()` and `uiProbe.verify()` returning promises. Both use exactly
the same application functions in a browser and the native realm. The snapshot
contains observable text, attributes, styles, list order, event observations and
effect logs, without assuming any text width or rasterization result.

Before mounting, `dom-contract.mjs` checks the same public APIs independently of
React: live collection enumeration and named lookups, Text identity/coercion,
safe insertion errors, document-root replacement, unusual tag names, and CSS
attribute reflection/removal. This is a focused contract, not full DOM/CSSOM
conformance; it does not cover fragments, observers or `getPropertyPriority`.
Mixed ID/name collisions are recorded separately: this native implementation
returns the first matching element, while the tested Chrome 153 returns an ID
match ahead of an earlier name match. The harness retains that difference and
compares the remaining observations exactly; a pass does not mean full DOM parity.

Verification performs these steps once per fresh page/realm:

1. Wait for the asynchronous initial render and passive effects.
2. Dispatch a bubbling, cancelable `click` at a span inside the advance button.
   React's button and ancestor handlers must observe their own `currentTarget`,
   the original span target, and cancellation of the native event.
3. Update state, class, numeric inline styles, a custom CSS property, removal of
   an inline property, and mixed Text/element content without replacing its nodes.
4. Insert, reverse and remove keyed rows, retaining surviving DOM identity and
   component effects. Check the removed wrapper and its cleanup.
5. Unmount the root, check DOM/effect cleanup, then create a new root on the same
   container. The remount must reset state and use new DOM nodes while retained
   detached wrappers remain readable.

`app.mjs` adds an ordinary Three.js/WebGPU torus knot beside the dashboard. It
logs `reactPhase:initial` and starts the same verification at animation frame 20,
logging `reactPhase:verified` only after completion. A window harness must require
that record and `result.passed:true`, not infer success from a frame count. It
must also fail on exceptions, timeout or missing completion. Automated verification
expects an untouched dashboard; do not click its controls before it runs.

The repository pins dependencies. From the repository root, after `npm ci`, a
CPU behavior bundle can be made with:

```sh
node_modules/.bin/esbuild fixtures/react-dom/behavior.mjs \
  --bundle --platform=browser --format=iife --outfile=.cache/react-dom-behavior.js
```

The HTML's module entry requires bundling for both browser and native execution;
raw browser loading of bare npm imports is not claimed. `3jsn.json` explicitly
selects the existing compiled DOM package profile. The CLI still requires an
explicit matching player and fallback WOFF2 font. No dynamic HTML string parsing
is used by the authored application.

Run the complete comparison on macOS arm64 with:

```sh
node scripts/probe-react-dom.mjs \
  --preserved /path/to/parser-preserved-runtime \
  --restricted /path/to/parser-restricted-runtime \
  --font /path/to/DejaVuSans.woff2 \
  --browser '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --out artifacts/react-dom-new-run
```

The output directory must be new. The harness uses development React for browser,
CPU and window checks, bundles with the real CLI, verifies unchanged source,
relocates packages, removes disposable input and configures a sandbox policy to
deny network and development-file reads. Negative file-read controls are included;
no independent network-denial control is run. `--cpu-only` omits native-window
validation. Exact recorded outcomes belong in the [checkpoint](../../docs/validation/2026-09-18-react-dom.md).

A pass covers only this client-rendered tree and its tested APIs, not React certification, SSR/hydration,
Suspense, transitions, forms/selection, portals, synthetic pointer events,
accessibility, native OS input, general frontend tooling or arbitrary projects.
Synthetic dispatched clicks do not establish native input behavior. GPU
presentation and browser/native DOM comparison require separate recorded runs.
The experimental host retains wrappers and native nodes until realm teardown;
effect cleanup and detached identity checks do not establish garbage collection
or bounded memory across repeated mount/unmount cycles.
