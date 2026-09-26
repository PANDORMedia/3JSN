# Vite native package relocation checkpoint

On 2026-09-26, the `dom-window-v1` CLI built the repository's small Vite example
on one Apple M1 Pro running macOS arm64 with Metal validation enabled. Vite
8.3.0 emitted one HTML input, one JavaScript entry, one source map and a
manifest. The CLI captured that graph, checked its HTML against the DOM profile,
bundled the generated module into the native package and recorded source
identities. The example source snapshot was unchanged.
The DOM host also loads the image and fetch extensions required by the shared
web globals, using the package-only fetch shim for native launches.

The executable passed package verification after relocation to a path containing
spaces and Unicode. The disposable app sources, Vite installation and supplied
font were removed before launch. The native process ran from an unrelated
working directory with network access and reads from the source, dependency,
crate and experiment directories denied. Node.js was absent from its `PATH`.
The native DOM window presented 120 Metal frames, reported 120 canvas snapshots,
and confirmed the native device and queue identities; CPU image transport was
false. This is a relocation and runtime correctness check, not a clean-machine
or performance certification.

Reproduce from the repository root after preparing the pinned DOM experiment
and installing the locked Node dependencies:

```sh
export CARGO_HOME="$PWD/.cache/cargo"
export CARGO_TARGET_DIR="$PWD/target"
cargo +1.93.0 build --manifest-path experiments/dom-canvas/Cargo.toml \
  --bin threejs-dom-window-probe
npm run probe:package:vite -- \
  target/debug/threejs-dom-window-probe \
  .cache/dom-canvas/blitz/examples/wasm_hello/assets/DejaVuSans.woff2 \
  artifacts/vite-native-package-probe
```

The probe writes `report.json` and process logs into the requested new output
directory. It also verifies that the package metadata contains no path to that
temporary directory and that every measured repository input retains its
original hash.

This evidence covers one Vite configuration and the experimental macOS DOM
profile only. The adapter admits one HTML entry and a static JavaScript import
graph. It rejects CSS output, emitted assets, dynamic imports/chunks, workers,
Wasm, public-directory assets, multiple HTML entries and server builds. The
DOM and CSS parsers still run at application startup. Unchanged-project
compatibility, arbitrary Vite plugins, other operating systems and performance
remain unverified; see [issue #37](https://github.com/PANDORMedia/3JSN/issues/37).
