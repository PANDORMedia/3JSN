# Visible native Three.js window — 2026-09-18

The Rust player visibly rendered the shared Three.js r186 scene in a native
macOS window on the Apple M1 Pro. A separate bounded run exited successfully
after **120 presented Metal frames**, with Metal API Validation enabled and
Three.js using the supplied JavaScript GPU device. This advances the earlier
[offscreen and hidden-window checkpoint](2026-09-18-native-host.md).

The native app screenshot was inspected through the computer-use tool: a turquoise
torus knot and lit platform were visible in the window titled
`3JSN Native — WebGPU integration`. The screenshot observation is recorded in
the [receipt](2026-09-18-visible-window.json), alongside input and executable
hashes; no screenshot file is archived here. The receipt records the observed
tool results, rather than a new automated visual assertion.

## Opaque presentation repair

The initial launch failed on its first animation frame. A validation error scope
around the canvas configuration identified the cause: the native surface
accepts `Opaque` and `PostMultiplied`, while Three.js defaults to `PreMultiplied`.
Three configures the context lazily, so `renderer.init()` had returned before
the rejected configuration. The subsequent texture acquisition reported an
unconfigured surface.

The opaque fixture now explicitly selects `alpha: false`. Its shared scene
source is unchanged. This does not implement transparent canvas presentation,
change Three.js source, or silently coerce the runtime's alpha semantics.
Postmultiplied and premultiplied alpha are not interchangeable conventions.

## Reproduce

```sh
node node_modules/esbuild/bin/esbuild examples/runtime/three-window.mjs --bundle --format=esm --platform=browser --outfile=artifacts/rust-window/three-window.mjs
cargo build --locked --release -p threejs-native-player
MTL_DEBUG_LAYER=1 target/release/threejs-native-player --window artifacts/rust-window/three-window.mjs --frames 120
```

Omit `--frames 120` to keep the interactive window open. The native event thread
and Rust-hosted V8 render to the same GPU surface; this display path does not
read frames back to the CPU or launch a browser. A local unsigned `.app` wrapper
was also used to show the demo conveniently. That wrapper is not output from
the proposed `3jsn build` product.

## Remaining gates

This run establishes visible opaque presentation on one Mac. It does not
measure frame pacing or performance, validate transparent presentation,
resize/DPI changes, minimize/restore, device-loss recovery or other platforms.
Native input, full DOM/WebGL integration, unchanged CtF execution, CLI builds
and clean-machine packaging remain open. The broader acceptance criteria in
issues #15–#18 therefore remain open; see the [window contract](../native-window.md).
