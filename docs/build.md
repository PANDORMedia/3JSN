# Experimental native application packaging

`3jsn build` has initial local packaging paths for the `native-window-v1` and
`dom-window-v1` fixtures. It bundles JavaScript/TypeScript and an explicitly supplied native player
into a portable application directory. The shipped executable runs without Node,
esbuild or a development server. This is not the unchanged-web-project pipeline:
general HTML/CSS, WebGL, frontend build commands, assets and full browser services
still need integration. Do not port a game to these fixtures as a compatibility workaround.

| Profile | Entry and payload | Supplied player |
| --- | --- | --- |
| `native-window-v1` | JS/TS entry and source map | Current-host native-window player |
| `dom-window-v1` | Bounded HTML entry, one bundled module/map and explicit WOFF2 font | Experimental macOS Metal DOM-window player |

The DOM profile still parses HTML/CSS at runtime. The
[compiled UI architecture](adr/0003-compiled-ui-and-generic-compatibility.md) is a
separate planned path; neither parser omission nor generic project compatibility
is implied by this packaging checkpoint.

## Build the example

From the repository, install the locked development dependencies and build a
player for this machine:

```sh
npm ci
cargo build --release --locked -p threejs-native-player
mkdir -p artifacts
node packages/cli/cli.mjs build examples/spinning-scene --runtime target/release/threejs-native-player --out artifacts/packaged-demo --experimental
```

On Windows, use `target/release/threejs-native-player.exe`. The npm bin entry is
`3jsn`; the direct Node invocation above works from an uninstalled checkout.
Output must not already exist, its parent must exist, and it must be outside the
project directory. No overwrite switch, automatic runtime download, package
installation or project build-script execution is provided.

The example has a `3jsn.json` configuration:

```json
{
  "schemaVersion": 1,
  "profile": "native-window-v1",
  "name": "3jsn-demo",
  "entry": "native.mjs"
}
```

All four fields are required; unknown fields are rejected. Names are lowercase
letters/digits/hyphens, begin with a letter or digit and contain at most 64
characters. Reserved Windows device names and package-directory names are invalid.
Entries are contained relative `.js`, `.mjs` or `.ts` paths. This profile uses the
existing native-window adapter; it does not replace the proposed
`experimental-desktop-v1` unchanged-game compatibility contract.

Only the current host target is accepted: `macos-arm64`, `macos-x64`, `linux-x64`
or `windows-x64`. An optional `--targets` must name exactly that target. This
checks artifact identity, not hardware certification or minimum-OS compatibility.
Other target requests fail before artifact creation. Cross-host workers, signed
runtime downloads and cross-compilation remain future orchestration work.

## Build the HTML-entry example

Prepare the pinned [DOM experiment](../experiments/dom-canvas/README.md), then run
from the repository root:

```sh
export CARGO_HOME="$PWD/.cache/cargo"
export CARGO_TARGET_DIR="$PWD/target"
cargo build --offline --locked -j2 --manifest-path experiments/dom-canvas/Cargo.toml --bin threejs-dom-window-probe
node packages/cli/cli.mjs build examples --runtime target/debug/threejs-dom-window-probe --font .cache/dom-canvas/blitz/examples/wasm_hello/assets/DejaVuSans.woff2 --out artifacts/packaged-dom-demo --experimental
artifacts/packaged-dom-demo/3jsn-dom-demo --frames 120
```

The [example config](../examples/3jsn.json) selects `dom-window-v1` and
`dom-window/index.html`. The project root is `examples` so the shared scene import
stays contained. The CLI parses HTML with pinned parse5, finds the single external
local module, bundles it and replaces only that script's `src` attribute in the
generated HTML. Application sources are unchanged. CSS is parsed with pinned
css-tree for structural/resource admission, not to certify rendering fidelity.

This interim profile accepts ordinary HTML5 no-quirks UTF-8 without a BOM,
structural/text elements, buttons, one unique `canvas#scene`, and one local
external module. It rejects inline/classic scripts, templates, noscript, foreign
content/XML, canvas fallback content, static resource/navigation elements,
inline handlers and unsupported attributes. Plain inline CSS is accepted;
at-rules, resource URLs, escapes, parse recovery and unlisted functions reject.
The recorded grammar and exact generated/source hashes appear in build metadata.

The fixed canvas ID and restricted document grammar belong to this experimental
host, not the generic product contract. Accepted markup does not establish DOM,
CSS or input support. Dynamic HTML/style/resource creation, lifecycle events,
CSSOM, focus/forms/IME, scrolling and general asset loading remain unresolved.
The current painter does not advance CSS animation/transition timelines.

`--font` is required for this profile and rejected for `native-window-v1`. The
builder checks a regular WOFF2 input, its header/declared length and source/copy
identities. The native worker rejects a font that registers no usable family.
That single font supplies the generic-family fallback; this does not implement
font-face loading, complete glyph coverage or font licensing. The example font
comes from the pinned upstream checkout; include applicable notices before any
binary distribution.

Only a matching current-host macOS Metal player is accepted. HTML/font payloads
are included under `app/`; neither the development cache nor the font's original
path is required by the packaged loader. This debug example is a correctness
artifact, not a performance result.

## Run and relocate

Run `artifacts/packaged-demo/3jsn-demo` (or `3jsn-demo.exe` on Windows). The entire
directory can move; the executable finds `app.json` beside its actual executable
path and resolves the entry from that directory, independently of the working
directory. It does not require the build project's location.

The player also accepts diagnostic commands:

```sh
target/release/threejs-native-player --describe
target/release/threejs-native-player --verify-app artifacts/packaged-demo/app.json
artifacts/packaged-demo/3jsn-demo --frames 120
```

`--describe` emits the actual runtime, target, backend and supported package
protocol/profile identifiers. `--verify-app` verifies a package without creating
a window or JS realm. `--app <app.json>` explicitly selects a package; paths in
that manifest remain relative to its own directory. `--frames` is a bounded native
validation run, not an FPS benchmark.

## Package contract

The output contains the named native executable, `app.json`, `app/main.mjs`, its
linked source map, and `metadata/build.json`. The manifest uses schema version 1,
the profile/name/target, a listed `.mjs` entry and SHA-256/byte identities for every
listed application file. Files must be under `app/`, with portable slash-separated
paths. Traversal, case-fold collisions, symbolic links within the package, missing
files, wrong hashes and incompatible targets/profiles fail before GPU startup.
The manifest is limited to 1 MiB and 4,096 file records. An explicit manifest's
parent path is canonicalized; aliases in that outer path may resolve normally.

DOM manifests also require distinct, listed `html` and `font` paths ending in
`.html` and `.woff2`; the builder emits `app/index.html` and `app/font.woff2`.
Native-window manifests reject those fields. Both players use the shared
`threejs-native-package` validator and reject each other's profile. DOM
`--describe`, `--verify-app`, `--app` and adjacent-manifest startup follow the same
protocol. `--verify-app` checks manifest and payload integrity, not HTML behavior
or font decoding. The old positional DOM-probe invocation remains available.

These are corruption and configuration checks for trusted local code. The
manifest is unsigned, execution reopens verified files, and packages must stay
quiescent. The existing runtime module loader can resolve dynamic file imports;
this is not a hostile-code sandbox or a guarantee that future reads remain inside
the package. The build metadata records unresolved dynamic behavior explicitly.

## Preservation and failure behavior

The CLI snapshots the project before and after a build, excluding root `.git`
and `node_modules`. It separately records and rechecks exact bundled dependency
bytes, the supplied/copied runtime, generated files and manifest. Dependencies
outside the project are accepted only under `node_modules`; arbitrary external
source imports fail. The record does not capture every resolver decision or the
entire dependency installation. Source preservation is not equivalent to browser
behavioral compatibility.

Bundling uses the pinned esbuild browser/ESM path with an explicit empty tsconfig;
custom plugins, inherited tsconfig and frontend scripts are not run. Warnings,
unresolved/external literal imports and unexpected output kinds fail. Computed
imports, relative asset URLs and dynamic API access remain unresolved. The output
is labelled experimental even when bundling succeeds.

Work occurs in a sibling staging directory. Publication exclusively reserves a
new destination, moves its contents, and installs `app.json` last. This avoids
overwriting existing output, but is not an atomic directory transaction. Caught
failures remove owned partial output and write a unique failure receipt with
source-preservation results. SIGINT/SIGTERM request graceful cancellation; the
current bundling/filesystem operation finishes before cleanup and verification.
Forced process termination can leave an incomplete
directory. Inputs and destination parents must be quiescent during the operation.

Maps retain `sourcesContent` and stable virtual source labels for later debugging.
The runtime currently reports generated-file stack locations; emitting a map does
not establish original-source stack mapping. Debug maps include source text and
are part of the package's disclosure surface.

## Distribution gates

### Planned webfont bundling

`--bundle-web-fonts` is a planned opt-in build flag, tracked with font/asset
loading. It is not accepted by the current CLI. The intended behavior is to
resolve webfont stylesheets and `@font-face` sources at build time, package the
required font files, and rewrite only generated CSS/HTML references to package
URLs. Ordinary project sources remain unchanged. This replaces neither the
native font-face loader nor CSS family/weight/style matching.

Preserve declared weights, styles, variable-font ranges, unicode ranges and
fallback ordering. Do not subset from the initial screen: runtime text and
localization can need other glyphs. Resolve relative URLs against the stylesheet's
actual response URL; record redirects, content identities, resource provenance
and available notices. A reproducible asset lock/cache must pin fetched bytes
and support offline rebuilds. Download, format or decoding failures must fail
with the originating stylesheet/declaration, never silently change the typeface.

Validate the result with network access disabled, including multiple families,
weights, variable fonts, localized/dynamic text and retained fallback behavior.
Runtime-created font URLs that cannot be resolved during the build remain
explicit dependencies; the flag must not imply their automatic discovery.
The existing `--font` option packages one supplied fallback for the interim DOM
fixture and is not this webfont-bundling feature.

### Release artifacts

Artifacts currently serve local development and validation. Native library
inventory, matching third-party/V8 notices, clean-machine checks, platform app
bundles, signing/notarization and installers are unfinished. Do not treat this
command as a public binary release workflow. The [dependency record](dependencies.md)
and roadmap issues [#37](https://github.com/PANDORMedia/3JSN/issues/37),
[#38](https://github.com/PANDORMedia/3JSN/issues/38) and
[#41](https://github.com/PANDORMedia/3JSN/issues/41) retain the broader gates.

The hardware probe builds a disposable copy of the shared example, removes that
copy, relocates the output to a path with spaces/Unicode, runs from another working
directory with a restricted PATH, and checks 120 presented frames plus rejection
of a modified source map. Keep its new evidence directory under the checkout so
the build step can resolve the installed Three.js dependency:

```sh
npm run probe:package -- target/release/threejs-native-player artifacts/package-relocation
```

The DOM counterpart additionally removes the supplied font, checks HTML/font
corruption and profile mismatch, and exercises unusable-font and packaged
animation-error failures. Its native subprocess denies network access and reads
from development cache, dependency and source directories using macOS sandbox
rules; system libraries remain available:

```sh
node scripts/probe-dom-package.mjs target/debug/threejs-dom-window-probe .cache/dom-canvas/blitz/examples/wasm_hello/assets/DejaVuSans.woff2 artifacts/dom-package-relocation
```
