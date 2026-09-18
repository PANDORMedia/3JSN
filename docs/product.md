# Product contract: existing web project to native application

## Intended user experience

Intended complete workflow (not implemented yet):

```sh
3jsn check ./my-game
3jsn run ./my-game
3jsn build ./my-game --targets windows-x64,linux-x64,macos-arm64
```

The first [experimental build path](build.md) now packages an explicit
`native-window-v1` fixture and a supplied host player. A read-only
[project inventory](check.md) now implements the static inspection portion of
`check`, with explicit unresolved behavior. Full analysis/tracing, `run`, existing
frontend build integration and multiple target workers remain open.

`check` identifies entry points, the existing build system, renderer, browser APIs,
assets and services. Static analysis reports uncertainty; it cannot prove dynamic
JavaScript never uses an unsupported API. Runtime tracing and fixtures complement it.

`run` uses the existing frontend build workflow and launches a native player.
`build` produces target-specific executables/app bundles and required assets and
libraries. A portable application directory is acceptable; single-file packaging
is optional. Existing build tools may require Node on the developer machine. The
shipped client should need no separately installed Node, browser or development server.

One invocation may orchestrate target build workers or obtain verified prebuilt
runtime components. It does not imply every host can locally compile, sign and
test every target without its toolchains, platform SDKs or target runners.

## No game-source changes

Preserve JS/TS, the project's Three.js version, renderer selection, GLSL/TSL, HTML,
CSS and behavior. Do not require switching to WebGPURenderer, rewriting the UI or
changing imports to a fork. CLI/configuration can select workspace, entry page,
build command, assets, endpoints, app identity and native permissions.

Normal frontend transforms and documented compatibility adapters may operate in
generated output. They must preserve behavior and source maps. Hash the original
source and assets before/after to verify that 3JSN did not edit them.

## Meaning of “any Three.js project”

This is the long-term ambition. Releases support explicit, versioned profiles,
with known gaps and tested hardware. Unsupported APIs fail analysis/build or are
reported as unresolved dynamic dependencies. A rendered main scene does not
establish application compatibility.

Arbitrary browser apps require browser-like semantics: DOM/events, CSS layout,
canvases, URLs/origins, storage, workers, audio and network APIs. This is a major
subsystem, not a small polyfill. Advance through smaller verified profiles while
keeping source preservation as the acceptance criterion.

## Native rendering and HTML

The architecture is application-independent. CtF is one acceptance example;
standard capabilities and independent fixtures define compatibility. Runtime code
must not require that game's element IDs, UI structure or dependencies.

The [compiled UI direction](adr/0003-compiled-ui-and-generic-compatibility.md)
moves static HTML/CSS processing into the build where semantics can be preserved.
A live native UI tree and compatible JavaScript APIs remain at runtime. Dynamic
markup and CSS may still require parsers; parser omission is a proven property of
a particular artifact, not a requirement imposed on every unchanged application.

The intended player is a Rust application using native GPU APIs. Chromium/CEF and
OS WebViews are not the default runtime. Reusing HTML, CSS, text and layout
libraries is compatible with that direction; those components still implement
parts of a web engine.

GPU painting alone does not implement DOM scripting, layout queries, hit testing,
focus or accessibility. The [HTML investigation](html-rendering.md) covers the
complete path. A full engine such as Servo is an explicit alternative with
architectural consequences, never a silent fallback.

## CtF acceptance

The local inventory found a Vite/npm-workspace client using Three.js WebGL,
GLSL/post-processing, dynamic HTML/CSS, multiple canvases, Canvas 2D, storage,
workers, Web Audio, Wasm audio processing and WebRTC-based voice.

Its game and voice servers remain separate. Building the native client does not
turn those services into an offline game. Configure endpoints/origin behavior;
packaged services require explicit supervision and distribution support.

Acceptance covers startup, menus, join/lobby, gameplay, controller navigation,
settings, reconnect, microphone permissions, mute, voice playback/self-test,
resize and shutdown. Preserve audio-linked intro timing and input behavior. Pin
the source snapshot and assets without publishing private game code or assets.
