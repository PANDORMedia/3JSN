# Ordinary Three.js DOM fixture

`main.mjs` uses upstream Three.js, lets the renderer create its own HTML canvas,
sets its size, appends it to the document and renders a normal-material box. It
contains no native host imports or test hooks. Use a normal frontend bundler to
resolve the bare `three` import when serving `index.html` in a browser.

The native integration test currently executes a bundle of `main.mjs` in the
actual DOM host with an initial document. It does not yet load this HTML entry,
create a window, or package this directory via `3jsn build`.

```sh
node_modules/.bin/esbuild examples/webgl-dom/main.mjs --bundle --format=iife \\
  --platform=browser --outfile=.cache/native-webgl/dom.js
```

The optional `native-webgl` test in `experiments/compiled-ui-runtime` runs this
bundle on Metal, verifies canvas modes/resizing/native pixels, and repeats with
dynamic HTML parsing omitted. See that experiment's validation record.
