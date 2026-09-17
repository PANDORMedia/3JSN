# CtF compatibility inventory

Read-only source inspection on 2026-09-17. The local checkout had uncommitted work;
this is a capability inventory, not a reproducible compatibility certification.
Acceptance testing must pin a source-and-asset snapshot. No CtF code/assets are
included in this repository and the game was not modified by this investigation.

| Observed capability | Implication for unchanged execution |
| --- | --- |
| npm workspaces, Vite client build and custom asset plugins | Reuse the project's build pipeline; identify client/shared packages and emitted assets |
| Three.js dependency range `^0.168.0`, WebGLRenderer | Preserve the installed version and WebGL API; the r186 WebGPU probe is not a CtF port |
| ShaderMaterial, onBeforeCompile, EffectComposer and bloom | Support GLSL and WebGL post-processing; automatic TSL substitution is not equivalent |
| Multiple Three.js canvases in gameplay and UI | Context lifetimes, compositor order, texture sharing and hidden-canvas lifecycle |
| Canvas 2D procedural textures, maps and game UI | Raster/text/image-data APIs and upload interoperability |
| Dynamic HTML, innerHTML, selectors, classes/style, SVG and geometry queries | Live DOM bindings, CSS/layout semantics and shared object identity |
| Grid/flex, fonts, animations, gradients and layered menus | Style, shaping, paint, hit testing and UI comparison fixtures |
| navigator.getGamepads and keyboard/pointer UI | Native input mapping plus DOM focus/event behavior |
| Module worker for network ownership | Worker loading, messaging and scheduling semantics |
| Colyseus SDK and WebSocket use | Preserve network behavior and reconnect; game server stays separate |
| localStorage, sessionStorage, location/reload and relative URLs | Stable app origin, persistent/session stores, reload lifecycle and asset addressing |
| AudioContext, music timing and Canvas/UI interaction | Native Web Audio semantics and clock/visibility behavior |
| mediasoup-client, getUserMedia, AudioWorklet, Wasm processing and MediaRecorder | Native WebRTC/media/recording and microphone permission/device lifecycle |
| Separate game and voice server workspaces | Explicit endpoint configuration; building a client is not packaging the backend |

## Acceptance journey

Pin a privately accessible snapshot, build it without source edits, and compare
browser/native startup and intro timing, menus, join/lobby, gameplay, settings,
controller navigation, reconnect, microphone grant/deny, mute and voice self-test,
resize/minimize/restore and exit. Include physical audio/controller checks.

Use before/after content hashes and a machine-readable feature report. Publish
sanitized evidence and small redistributable fixtures, not private source, service
credentials, deployment addresses or licensed assets. CtF is not yet supported.
