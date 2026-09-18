# HTML-entry package relocation on Metal

Date: 2026-09-18. This checkpoint adds the interim `dom-window-v1` build profile
to the [native DOM-window experiment](2026-09-18-dom-window.md). It packages the
original Orbit Study fixture and an explicitly supplied font. The native player
still parses HTML/CSS and maintains a live DOM; [compiled UI and parser omission](../adr/0003-compiled-ui-and-generic-compatibility.md)
are separate planned work.

## Observed behavior

The [automated report](2026-09-18-dom-package/report.json) records a successful
CLI build, source preservation, exact runtime/payload hashes and 120 Metal
presentations with native device/queue identity checks and no CPU image
transport. The temporary source tree and supplied font were deleted after the
build. The complete package moved to a path containing spaces, Unicode and `#`,
then ran from an unrelated working directory.

The native process had no Node on PATH. Its [macOS sandbox rules](2026-09-18-dom-package/native-only.sb)
denied network access and reads from this checkout's `.cache`, `node_modules`,
`crates`, `experiments` and `examples` directories. System libraries remained
available. Five `cat` controls against existing files, one per denied directory,
failed with `Operation not permitted`. This provides development-source independence evidence on one Mac,
not a clean-machine distribution or performance certification.

After the successful render, separate controls rejected damaged HTML, a damaged
font and a native-window manifest sent to the DOM player. A correctly hashed but
unusable font reported its registration failure. A correctly hashed module with
an injected animation exception exited with that cause. Each mutation was
restored, and the final package passed integrity verification again.

The existing `native-window-v1` player also passed its [relocation regression](2026-09-18-dom-package/native-profile-regression.json)
after the shared source-embedding extraction: 120 Metal frames, no Node on its
restricted PATH, source preservation and the existing corruption/error controls.
That separate regression did not use the DOM probe's denied-read policy.

## Implementation boundaries

- The CLI uses pinned parse5/css-tree for strict admission and rewrites only the
  module `src` in generated HTML. It bundles the module/map and one WOFF2 file;
  it does not execute frontend build commands or prove dynamic API compatibility.
- Both players share `threejs-native-package` for profile-specific manifest,
  containment, hash and size validation before execution. Hashes detect damage;
  these unsigned local packages remain trusted code, not a hostile-code sandbox.
- `threejs-native-js-sources` embeds shared Deno extension sources during the
  Rust build. Native runtime bootstrap files are direct compile-time includes.
  The DOM experiment previously depended on development copies of dependency JS;
  relocation alone would not have exposed that on this machine.
- Native diagnostics now print the error's display message. A closed input
  receiver waits for the worker's `Stopped` result so it cannot mask a startup
  failure; a full input queue still fails explicitly.
- The font is one generic-family fallback. Webfont stylesheet discovery,
  `@font-face` loading and the planned `--bundle-web-fonts` option remain open in
  [#56](https://github.com/PANDORMedia/3JSN/issues/56).

The shared crate uses the workspace-pinned thiserror 2.0.18, so the separate DOM
lockfile now resolves that version instead of 2.0.20. The outer workspace excludes
the independent experiment/cache workspaces to prevent incorrect inherited
manifest metadata when they consume shared crates.

## Validation and limits

[Checks](2026-09-18-dom-package/checks.json) record 94 passing Node tests with one
platform-specific skip, 22 passing workspace Rust tests with the existing GPU
test/doc example ignored, and one DOM argument test. Scoped Clippy and formatting
checks accompany the checkpoint. A pre-existing Blitz dependency dead-code
warning remains; it is not a warning in the modified application code.

This run adds packaging and failure evidence. It does not broaden the earlier
fixture's verified CSS/input behavior, certify arbitrary HTML/WebGL applications,
prove full font coverage, or validate other platforms. No executable, font or
private acceptance-game assets are checked into this evidence directory.

Reproduce using the [build guide](../build.md) and
[probe](../../scripts/probe-dom-package.mjs). The original parser-enabled runtime
is retained as a baseline for future compiled UI comparisons.
