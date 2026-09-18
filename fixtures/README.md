# Redistributable compatibility fixtures

These fixtures are original MIT-licensed code under the repository license. They
contain no CtF code or assets. They establish small, inspectable browser reference
behaviors; they do not certify native support or replace the full acceptance game.

Capture a bounded headless Chrome/Chromium reference using an installed browser:

```sh
node scripts/compatibility/browser-reference.mjs /path/to/chrome all
```

The runner creates a disposable browser profile and loopback-only server that
serves fixture files, the pinned Three.js build and original test network services.
It waits for completed
assertions and prints a JSON report, returning nonzero on failed assertions or
timeout. It does not override the selected GPU backend or enable software fallback.
The final argument selects `webgl-dom`, `webgpu-canvas`, `workers-wasm`, `audio-worklet`, `network`, `dom-geometry`,
or `all`; omitting it retains the original `webgl-dom` behavior. Single-fixture
output is one report; `all` emits a suite containing a `reports` array.

Serve the repository root after `npm ci` and open
`/fixtures/webgl-dom/index.html`. The import map resolves the exact Three.js package
in the root lockfile; no CDN or mutable upstream code is required. Never expose a
server rooted at a private acceptance-game checkout for this public fixture.

`webgl-dom` executes an unchanged `WebGLRenderer` scene with GLSL, two independent
WebGL canvases, a live Canvas 2D texture, dynamic DOM mutation, retained node/event
identity, bubbling, CSS grid/flex geometry and programmatic focus/click checks.
The final page exposes `globalThis.__3jsnFixtureResult` and a matching JSON `<pre>`.
Every assertion must pass; a screenshot or a visible canvas alone is insufficient.
The result explicitly distinguishes programmatic events from real pointer,
keyboard, controller and accessibility validation.

`workers-wasm` exercises module-worker imports, an original Wasm addition module,
structured cloning, transferred ArrayBuffer ownership, request identity and worker
termination. SharedArrayBuffer/Atomics and application-specific decoders are not
covered by this fixture.

`webgpu-canvas` checks genuine canvas/context identity, bitmap versus CSS sizing,
two independent canvases, clear/readback pixels, texture expiry after resize and
reconfiguration, DOM removal/reinsertion, and GPU usage validation. It is shared
with the [native DOM canvas experiment](../experiments/dom-canvas/README.md).
It does not test general HTML paint order, presentation timing or canvas GC.

`audio-worklet` renders Web Audio offline at a fixed sample rate. It checks exact
source start/stop frames, gain automation, completion, and a module AudioWorklet's
sample output, clock and message port. It does not access speakers, microphones or
real-time audio hardware and does not establish latency or permission behavior.

`network` uses the runner's local HTTP/WebSocket service to check relative fetch,
JSON POST, binary bodies, response cloning, HTTP failures, abort, WebSocket text
and binary messages, forced disconnect, application reconnect and clean close.
The service uses the pinned `ws` development dependency; browser code uses native
web APIs. It contacts no game service and tests no TLS, credentials or WebRTC.
Static-only servers cannot run this fixture's service-dependent assertions.

[`dom-geometry`](dom-geometry/README.md) compares box geometry across hide/show,
`display:contents`, detach/reattach and zero dimensions. Its 23 shared checks
match the patched native DOM query. This does not certify transformed geometry
or general browser DOM behavior.

[`react-dom`](react-dom/README.md) uses upstream React DOM over a generic live
native document: asynchronous effects, delegated clicks, keyed updates, style/text
mutation, cleanup and remount. Its separate harness compares browser/native
observations and runs the adjacent Three.js canvas. The
[checkpoint](../docs/validation/2026-09-18-react-dom.md) records the tested scope,
including a generic collection lookup difference; it does not certify React,
physical input or pixel equivalence.

The separate paint runner captures the [overflow](overflow-paint/README.md),
[positioned layout](positioned-layout/README.md),
[initial containing block](initial-containing-block/README.md),
[paint order](paint-order/README.md), [auto paint](auto-paint/README.md), and
[paint ownership/effect clipping](paint-ownership/README.md),
[effect clip routing](effect-clip-routing/README.md), and
[paint layer budget](paint-budget/README.md), and
[ownership renderer phases and bounds](ownership-render/README.md), and
[complete-image clip-edge controls](clip-edges/README.md), and
[opacity-output clipping](opacity-output/README.md), and
[own CSS rect effect boundaries](opacity-css-rect/README.md) matrices:

```sh
node scripts/compatibility/paint-reference.mjs /path/to/chrome artifacts/paint-order/browser paint-order
node scripts/compatibility/paint-hit-reference.mjs /path/to/chrome artifacts/paint-order/browser-hit-reference.json
```

Paint comparisons require matching source identities, viewport and ordered
mutations, plus geometry and visible pixels. The hit reference uses the same
HTML and point expectations as the native paint-order tests.
The separate [transform-context hit fixture](transform-context/README.md) checks
identity transforms, first-resolve context changes and repeated restoration.

The fixture uses the repository's Three.js r186 baseline, not CtF's pinned r168
dependency. Broader version compatibility, post-processing, media/voice,
full lifecycle/failure behavior and physical input fixtures remain required.
Record browser version, OS, GPU/backend and date with executed results;
do not use a browser pass as native integration evidence.

Committed macOS arm64 browser references from Chrome 153 on 2026-09-17:

| Fixture | Passing assertions | Evidence |
| --- | --- | --- |
| WebGL/DOM | 16 | [Report](webgl-dom/reference-macos-arm64.json); ANGLE Metal on Apple M1 Pro |
| Workers/Wasm | 8 | [Report](workers-wasm/reference-macos-arm64.json) |
| Offline audio/worklet | 8 | [Report](audio-worklet/reference-macos-arm64.json) |
| Fetch/WebSocket reconnect | 15 | [Report](network/reference-macos-arm64.json) |
| WebGPU canvas | 30 | [Report](webgpu-canvas/reference-macos-arm64.json); 27 shared contract assertions plus 3 browser checks |
| DOM geometry (2026-09-18) | 23 | [Report](dom-geometry/reference-macos-arm64.json); also compared to the native query |

Reports include fixture/service/lockfile hashes and raw observations. These are
browser baseline results only; no native compatibility is implied. The audio
reference is sample computation, not evidence of real-time or physical audio.
