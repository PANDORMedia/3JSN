# Ordinary Three.js window fixture

This original MIT fixture uses upstream `WebGLRenderer`, normal/basic materials,
ordinary HTML/CSS, and `requestAnimationFrame`. Its transparent canvas reveals the
HTML background; a translucent HTML badge overlaps animated WebGL shapes. It has
no native imports, application probe globals, or WebGPU request. A supplied native
fallback font or the browser's sans-serif fallback provides its text.

Serve `index.html` through a normal frontend bundler that resolves the bare
`three` import. The layout targets a roughly 960 × 640 window. Rendering continues
past 60 frames so a native harness can observe 120 presentations.

The same application performs deliberate lifecycle exercises:

- Frame 12 increases bitmap resolution while retaining CSS size and context.
- Frame 24 assigns the existing canvas width again, then renders the reset buffer.
- Frame 36 replaces the real `#scene` element and constructs another renderer.
- Frame 60 records completion; animation continues.

Each checkpoint logs a JSON `webglWindow` record with actual CSS/bitmap dimensions,
DOM connection, context identity and replacement identity. Failed identity,
dimensions, shader, context-loss or GL-error checks throw. Canvas replacement
uses ordinary DOM operations and `renderer.dispose()`; native context retirement
belongs to the host, not an application-specific hook.

These timed mutations are public integration inputs, not a claim that arbitrary
Three.js games, all WebGL features, CSS effects or native window lifecycle cases
are supported. Compilation alone does not establish GPU or presentation success.
Pixel/alpha correctness and native teardown require separate hardware evidence.

## Experimental native runner

On macOS, build the compiled UI player with `--features native-webgl` using the
prepared dependencies described in the [composition checkpoint](../../docs/validation/2026-09-18-webgl-composition.md).
With the desktop unlocked, run from the repository root:

```sh
node scripts/probe-webgl-window.mjs \
  target/debug/threejs-compiled-ui-runtime \
  .cache/dom-canvas/blitz/examples/wasm_hello/assets/DejaVuSans.woff2 \
  .cache/native-webgl/node_modules/gl/deps/darwin/dylib \
  .cache/native-webgl/window-preserved-run
```

The output directory must not exist. The runner retains process output, verifies
all five lifecycle checkpoints and 120 presentations, captures the final GPU
composition, and checks fixture source preservation. It records failures as well
as successes. ANGLE and the supplied font remain external inputs; this is not a
packaged application. This runner has not yet passed a native-window run.
