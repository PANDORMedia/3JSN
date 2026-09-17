# Redistributable compatibility fixtures

These fixtures are original MIT-licensed code under the repository license. They
contain no CtF code or assets. They establish small, inspectable browser reference
behaviors; they do not certify native support or replace the full acceptance game.

Capture a bounded headless Chrome/Chromium reference using an installed browser:

```sh
node scripts/compatibility/browser-reference.mjs /path/to/chrome
```

The runner creates a disposable browser profile and loopback-only server that
serves fixture files and the pinned Three.js build. It waits for completed
assertions and prints a JSON report, returning nonzero on failed assertions or
timeout. It does not override the selected GPU backend or enable software fallback.

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

The fixture uses the repository's Three.js r186 baseline, not CtF's pinned r168
dependency. Broader version compatibility, post-processing, workers, network,
audio/worklets, media, failure/cancellation and physical input fixtures remain
required. Record browser version, OS, GPU/backend and date with executed results;
do not use a browser pass as native integration evidence.

The committed [macOS arm64 browser reference](webgl-dom/reference-macos-arm64.json)
passed all 16 checks on 2026-09-17 in Chrome 153 with ANGLE Metal on Apple M1 Pro.
It includes fixture/lockfile hashes and raw pixel observations. This is browser
baseline evidence only; no native compatibility is implied.
