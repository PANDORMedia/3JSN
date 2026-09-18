# DOM box geometry

The same `geometry.js` runs in Chrome and the Rust/V8 DOM probe. Its 23 checks
cover hidden ancestors (including fixed descendants), `display:contents`, retained
detached subtrees, reattachment, and boxes with zero dimensions. Invisible,
transparent, clipped and offscreen boxes retain their geometric bounds.

The fixture uses only original HTML and JavaScript, with no fonts or assets.
It does not exercise painting, transforms, scrolling, SVG, DOMRect branding or
JavaScript `getClientRects()`. Separate Rust tests exercise the underlying native
fragment query, including inline hide/restore. An empty upstream fragment list is
not evidence that upstream generates all browser inline fragments correctly.

From the repository root:

```sh
node scripts/compatibility/browser-reference.mjs /path/to/chrome dom-geometry
CARGO_HOME="$PWD/.cache/cargo" CARGO_TARGET_DIR="$PWD/target" \
  cargo build --locked --offline --manifest-path experiments/dom-canvas/Cargo.toml \
  --bin threejs-dom-geometry-probe
target/debug/threejs-dom-geometry-probe fixtures/dom-geometry/index.html \
  fixtures/dom-geometry/geometry.js /tmp/native-geometry.json
```

Prepare the experiment dependencies as described in the
[DOM canvas guide](../../experiments/dom-canvas/README.md) first. This probe
requests no GPU device, but its experiment dependency graph currently targets
macOS. A successful run is not cross-platform runtime certification.

Both processes save raw observations. Native failure returns nonzero after
writing its report; compare the complete `result` and input hashes with the
[recorded Chrome reference](reference-macos-arm64.json).
