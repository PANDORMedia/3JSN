# Overflow comparison

Status: **partial**. The default prepared renderer matches 3 of 22 cases; an
unadopted research patch matches 16. Both return a nonzero comparison result.
The patch is not applied by `prepare.mjs` and is not a supported renderer fix.
See the [evidence and remaining problems](../../docs/validation/2026-09-18-overflow.md).

From the repository root on macOS with Metal, after the normal dependency setup:

```sh
export CARGO_HOME="$PWD/.cache/cargo"
export CARGO_TARGET_DIR="$PWD/target"
node experiments/dom-canvas/prepare.mjs
cargo build --locked --manifest-path experiments/dom-canvas/Cargo.toml \
  --bin threejs-overflow-paint-probe
node scripts/compatibility/paint-reference.mjs \
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  artifacts/overflow-paint/browser
MTL_DEBUG_LAYER=1 target/debug/threejs-overflow-paint-probe \
  fixtures/overflow-paint/index.html fixtures/overflow-paint/fixture.js \
  fixtures/overflow-paint/cases.json artifacts/overflow-paint/baseline
node experiments/dom-canvas/compare-clips.mjs \
  artifacts/overflow-paint/browser artifacts/overflow-paint/baseline \
  artifacts/overflow-paint/baseline-comparison.json
```

The native executable exits zero when captures and cleanup succeed. It makes no
compatibility decision. The comparator exits one for observed parity failures.
The browser runner launches a disposable profile and loopback fixture server;
it closes both and removes that profile on success, failure or interruption.

To reproduce the rejected prototype, apply it only to the ignored prepared copy:

```sh
git apply --check --whitespace=error --directory=.cache/dom-canvas/blitz \
  experiments/dom-canvas/patches/blitz-overflow-prototype.patch
git apply --whitespace=error --directory=.cache/dom-canvas/blitz \
  experiments/dom-canvas/patches/blitz-overflow-prototype.patch
cargo build --locked --manifest-path experiments/dom-canvas/Cargo.toml \
  --bin threejs-overflow-paint-probe
MTL_DEBUG_LAYER=1 target/debug/threejs-overflow-paint-probe \
  fixtures/overflow-paint/index.html fixtures/overflow-paint/fixture.js \
  fixtures/overflow-paint/cases.json artifacts/overflow-paint/prototype
node experiments/dom-canvas/compare-clips.mjs \
  artifacts/overflow-paint/browser artifacts/overflow-paint/prototype \
  artifacts/overflow-paint/prototype-comparison.json
```

**Restore the default prepared sources afterward**, including if capture fails:

```sh
node experiments/dom-canvas/prepare.mjs
node experiments/dom-canvas/prepare.mjs --check
```

Preparation intentionally rejects the prototype under `--check`. Rebuild before
running another native executable after restoration. The original Cargo registry
and pinned Git checkout remain untouched throughout.
