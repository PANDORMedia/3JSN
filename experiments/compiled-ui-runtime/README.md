# Compiled UI runtime with optional HTML parsing

This macOS/Metal experiment loads compiled UI data into the same live Blitz
DOM used by the native HTML window. Its default `dynamic-html` Cargo feature
retains Blitz's HTML parser; `--no-default-features` omits that optional
provider and installs explicit runtime capability failures. This is a restricted
research artifact, not a shipping package profile or an unchanged-project
compatibility claim. See [ADR 0003](../../docs/adr/0003-compiled-ui-and-generic-compatibility.md).

The runtime shares the existing DOM bindings (`html-v8/src/dom_ops.rs`), canvas
bridge, native realm, Metal texture transport, painter and window modules.
`src/dom_bridge.rs` supplies a parser callback only when the feature is enabled.
There is no alternate DOM or copied renderer. Live node identity, mutations,
selectors, CSS parsing, style evaluation, text shaping and CPU layout remain.
HTML-parser omission does not imply omission of CSS, selector or shader parsers.

Without the feature, initial compiled data containing a native iframe hook is
rejected before document construction, including inert template content and
foreign-namespace `iframe` nodes that reach the pinned native hook. Native DOM
operations reject `innerHTML` before detaching existing children and iframe
creation before allocation. Ordinary creation, text, attributes, styles, events
and tree mutations still use the shared bindings. Detached wrappers retain the
existing experimental lifetime policy.

`src/restricted.js` adds explicit failures for other markup/navigation entry
points so assignments cannot silently become expando properties. Its `DOMParser`,
`Range` and related methods are diagnostic stubs, not browser implementations.
These capability checks are not a security sandbox. Enabling `dynamic-html`
restores the implemented fragment-parser path; it does not implement every
browser markup API named by those stubs.

From the repository root, complete the [DOM canvas dependency preparation](../dom-canvas/README.md)
and `npm ci` first. The commands below require the dependencies in the local
Cargo cache. Use two fresh target directories and identical toolchain, target,
profile and environment settings when comparing builds:

```sh
export CARGO_HOME="$PWD/.cache/cargo"
export CARGO_INCREMENTAL=0
PARSER_RUN=$(mktemp -d "$PWD/.cache/parser-omission.XXXXXX")
PARSER_FONT="$PWD/.cache/dom-canvas/blitz/examples/wasm_hello/assets/DejaVuSans.woff2"
PARSER_TARGET=aarch64-apple-darwin
PARSER_ENABLED="$PARSER_RUN/enabled/$PARSER_TARGET/release/threejs-compiled-ui-runtime"
PARSER_DISABLED="$PARSER_RUN/disabled/$PARSER_TARGET/release/threejs-compiled-ui-runtime"

CARGO_TARGET_DIR="$PARSER_RUN/enabled" cargo rustc --offline --locked --release -vv \
  --manifest-path experiments/compiled-ui-runtime/Cargo.toml \
  --bin threejs-compiled-ui-runtime --target "$PARSER_TARGET" -j2 -- \
  -C link-arg=-Wl,-map,"$PARSER_RUN/enabled.map" -C link-arg=-Wl,-t \
  > "$PARSER_RUN/enabled.stdout" 2> "$PARSER_RUN/enabled.stderr"
CARGO_TARGET_DIR="$PARSER_RUN/disabled" cargo rustc --offline --locked --release -vv \
  --manifest-path experiments/compiled-ui-runtime/Cargo.toml \
  --bin threejs-compiled-ui-runtime --target "$PARSER_TARGET" --no-default-features -j2 -- \
  -C link-arg=-Wl,-map,"$PARSER_RUN/disabled.map" -C link-arg=-Wl,-t \
  > "$PARSER_RUN/disabled.stdout" 2> "$PARSER_RUN/disabled.stderr"

node experiments/compiled-ui/compiler.mjs \
  fixtures/parser-omission/index.html "$PARSER_RUN/ui.json"
node_modules/.bin/esbuild fixtures/parser-omission/app.mjs \
  --bundle --platform=browser --format=esm --outfile="$PARSER_RUN/app.mjs"
```

The explicit font is an upstream dependency input; its preparation and license
are documented in the [HTML paint experiment](../html-paint/README.md). The
compiler reads HTML at build time; runtime commands accept the resulting JSON,
font and JavaScript, without a source-HTML argument.
Cargo's offline flag does not prevent the V8 build script from downloading its
prebuilt archive. For an offline build, set `RUSTY_V8_ARCHIVE` to the matching
cached release archive for both variants and record its hash.

| Command | Behavior |
| --- | --- |
| `--describe` | Prints the compiled feature flag, target and Metal backend; it is not dependency/link proof. |
| `--compiled-ui UI.json FONT BUNDLED_APP [--frames COUNT]` | Opens the shared native window. A positive frame limit closes after that many successful presentations; omission runs until close. |
| `--measure-layout UI.json FONT BEHAVIOR.js [--verify]` | Creates the native realm and live DOM, evaluates a classic script providing `uiProbe`, and reports its initial snapshot. |

For each binary, run the fixture's positive behavior and feature-specific checks:

```sh
"$PARSER_ENABLED" --measure-layout \
  "$PARSER_RUN/ui.json" "$PARSER_FONT" fixtures/parser-omission/behavior.js --verify
"$PARSER_DISABLED" --measure-layout \
  "$PARSER_RUN/ui.json" "$PARSER_FONT" fixtures/parser-omission/behavior.js --verify
"$PARSER_DISABLED" --compiled-ui \
  "$PARSER_RUN/ui.json" "$PARSER_FONT" "$PARSER_RUN/app.mjs" --frames 120
```

The window command requires a usable window server and GPU. The shared window
currently expects the fixture's `#scene` canvas and uses Three.js WebGPU;
these are host-fixture constraints, not compiler grammar rules. Its empty
package-resource allowlist rejects undeclared linked stylesheets/fonts. General
resource packaging, WebGL, framework coverage and existing HTML/paint gaps remain
separate work.

The combined native harness copies both executables and inputs out of the
development tree, denies source-HTML reads and networking, and checks 120-frame
presentation plus DOM mutation and rejection behavior. Use a fresh output under
`artifacts`, since its sandbox deliberately denies `.cache` reads:

```sh
node scripts/probe-parser-omission.mjs --enabled "$PARSER_ENABLED" \
  --disabled "$PARSER_DISABLED" --font "$PARSER_FONT" \
  --out artifacts/parser-omission-run \
  --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

The optional Chrome comparison checks sampled rectangles at 0.25 CSS-pixel
tolerance and exact text/interaction observations. Differences produce a partial
report and a nonzero exit; they are not hidden by native-to-native equivalence.
`--cpu-only` skips both native windows and explicitly reports
`nativeWindowValidated: false`. It is useful for DOM/layout diagnostics when a
desktop session is unavailable and cannot satisfy the presentation gate.

`--measure-layout` measures elapsed time from Rust `main` entry through argument
handling, input reads, IR validation/construction, font and realm initialization,
behavior-script execution and completion of the first `uiProbe.snapshot()`.
This includes the style/layout work triggered by its rectangle reads. It excludes
process launch before `main`, verification, final reporting and teardown. The
supplied CPU behavior fixture makes no GPU-device request; this is not a GPU
startup, window, cold-start or per-frame layout benchmark. `--verify` runs after
the recorded interval and changes the document.

[`scripts/measure-parser-runtime.py`](../../scripts/measure-parser-runtime.py)
accepts `ENABLED DISABLED IR FONT BEHAVIOR NEW_OUTPUT_DIR` on macOS. It runs three
warmup pairs and twenty measured pairs in alternating order, without `--verify`,
requires matching initial snapshots, and records binary/input hashes. Its parent
lifecycle time includes process launch through termination; Darwin `wait4` peak
RSS covers the whole child lifetime, not steady-state or private memory. The
runner cannot establish that the supplied binaries used comparable build flags.

Build provenance, runtime behavior and omission evidence must be recorded
separately. Save the resolved normal/build dependency graph for each feature
variant and inspect final-executable linkage/symbol evidence for `blitz-html`,
`html5ever` and `xml5ever`. Shared `markup5ever` name/types may remain required.
The lockfile can contain disabled optional packages; `--describe`, source searches
and absent names in a stripped symbol table alone do not prove parser omission.
Fresh matched release builds and successful execution do not by themselves
establish a size reduction, speedup, memory saving or GPU equivalence.

[`scripts/probe-parser-linkage.py`](../../scripts/probe-parser-linkage.py) collects
those graph, compiler, link-map and symbol records with enabled positive controls:

```sh
python3 scripts/probe-parser-linkage.py \
  --enabled-exe "$PARSER_ENABLED" --disabled-exe "$PARSER_DISABLED" \
  --enabled-target-dir "$PARSER_RUN/enabled" --disabled-target-dir "$PARSER_RUN/disabled" \
  --enabled-link-map "$PARSER_RUN/enabled.map" --disabled-link-map "$PARSER_RUN/disabled.map" \
  --enabled-build-log "$PARSER_RUN/enabled.stderr" \
  --disabled-build-log "$PARSER_RUN/disabled.stderr" --out "$PARSER_RUN/linkage"
```

Keep every attempt's build log if a build is resumed; repeat its build-log flag
in chronological order. The proof checks the mapped executable's identity and
requires unstripped symbol records; it never builds or executes a runtime.
