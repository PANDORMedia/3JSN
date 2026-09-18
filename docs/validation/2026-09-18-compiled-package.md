# Compiled DOM package checkpoint — 2026-09-18

The experimental `compiled-dom-window-v1` build path passed a macOS arm64
integration run in both preserved and restricted HTML-parser modes. Each relocated
package presented 120 Metal frames after its disposable build source was removed,
with networking and development-source reads denied. This validates the bounded
public fixture and exact binaries below, not general unchanged-game support.

## Evidence and identity

The [package report](2026-09-18-compiled-package/package-report.json) records
`compiled-package-native-01`: 43 subprocess steps, including expected diagnostic
failures. [Package logs](2026-09-18-compiled-package/package-logs.json) preserve
stdout/stderr keyed by the filenames in those steps; the
[sandbox policy](2026-09-18-compiled-package/package-native-offline.sb) records
the denied paths. JSON is compacted without removing fields;
[archive identities](2026-09-18-compiled-package/archive-identities.json) retain
original and archived hashes. No executable, bundled application, font bytes or
private acceptance-game input is included in the evidence directory.

| Input | Bytes | SHA-256 |
| --- | ---: | --- |
| Preserved debug executable | 189,089,872 | `1d07081cfe80565e5b9a4c2e869f4229d88f1c5b05a17c4e43ef438ee2d21dab` |
| Restricted debug executable | 187,157,952 | `cafff38fad73e77130799e934643d4bba8f908531fd5d77b5c30f71b27e0ad2e` |
| Both packages' `app/ui.json` | 40,436 | `a8b5b898676ad33ad30507b6be00c438b858d140ae4da3bb818d32027370cac0` |

Both executables describe `macos-arm64`, Metal, V8 `15.0.245.2-rusty`, package
version 1 and `3jsn-static-ui-experiment` version 1. Their parser mode exactly
matches the requested build mode. The
[preserved manifest](2026-09-18-compiled-package/preserved-manifest.json),
[restricted manifest](2026-09-18-compiled-package/restricted-manifest.json), and
corresponding [preserved](2026-09-18-compiled-package/preserved-build.json) and
[restricted](2026-09-18-compiled-package/restricted-build.json) metadata retain
all listed input/payload identities and webfont provenance.

These are new debug binaries. They are distinct from the release artifacts in
[PR #58's parser-omission checkpoint](2026-09-18-parser-omission.md).
The earlier release link/size/measurement evidence must not be attributed to
these hashes. This run is neither a matched performance experiment nor new
parser-linkage proof for these exact executables.

## Verified package behavior

The harness copies `fixtures/web-fonts`, changes only the disposable configuration
to the compiled profile, and checks preservation during packaging. It localizes
static CSS/font references before compiling the generated HTML. Both manifests
contain `compiledUi` and no `html` field or listed HTML payload. The original
fixture remains unchanged.

For each mode:

- First build and repeat build run offline against existing pinned font state,
  with network access denied. Manifest, listed payloads and executable bytes match
  the repeat build exactly. This does not test fresh remote acquisition.
- The package moves to a path containing spaces, Unicode and `#`; the disposable
  source is removed. Startup runs from an unrelated working directory with
  `PATH=/usr/bin:/bin`. The policy denies the cache, dependencies, development
  sources and font state. Three explicit reads confirm the restrictions.
- `--verify-app` succeeds; `--measure-app` constructs live DOM state and registers
  28 CSS font faces from 25 font files, with no pending faces. Eleven text/width
  samples cover differing families and weights, Unicode restrictions, later-face
  precedence, and a live Greek/Cyrillic text update.
- Adjacent-manifest startup presents 120 Metal frames and 120 canvas snapshots,
  checks native device/queue identity, and reports no CPU image transport.
  CPU and window text-width observations agree. Metal API validation is enabled.
- Fourteen negative controls exit with diagnostic code 1: modified UI/font/CSS
  hashes; rehashed invalid UI version/reference; parser-mode descriptor mismatch;
  a rehashed undeclared stylesheet; a rehashed malformed font; and stylesheet or
  font-rule mutation during the behavior script, snapshot and verification phases.
  Restoring the package makes verification pass again. Rehashed controls exercise
  semantic checks beyond hash mismatch.

The public fixture's Roboto/Noto notices are copied by the harness and their
identities recorded. This does not make license discovery automatic.

## Direct DOM regression on the same binaries

A separate [parser report](2026-09-18-compiled-package/parser-report.json), run
`compiled-package-parser-regression-01`, uses the same executable hashes with
`fixtures/parser-omission`. Its [logs](2026-09-18-compiled-package/parser-logs.json)
and [policy](2026-09-18-compiled-package/parser-restricted-inputs.sb) preserve
direct-input CPU evidence. Both variants match the sampled initial and mutated
DOM observations in Chrome **153.0.8010.50**, with no recorded differences at a
0.25 CSS-pixel rectangle tolerance. Preserved mode executes dynamic markup;
restricted mode rejects 17 markup/navigation operations and retains the existing
tree. Compiled HTML and foreign-namespace iframe inputs also reject.

This companion run is CPU-only (`nativeWindowValidated: false`). It does not
compare packaged webfont pixels with Chrome or validate a direct-input window.
The 120-frame package evidence above is a separate run, not a reinterpretation
of that flag.

## Checks and remaining gates

The [check summary](2026-09-18-compiled-package/checks.json) and
[archived logs](2026-09-18-compiled-package/check-logs.json) record:

- Node tests with networking enabled: **143 passed, one skipped**.
- Compiled UI loader: **25 passed** with default features; **seven passed** with
  restricted features.
- Root workspace: **33 passed, two existing ignored tests**.
- Runtime `package_options` preflight integration tests: **nine passed per mode**.
- Runtime Clippy: binary and `package_options` integration target in each mode;
  this is scoped validation, not an all-targets claim. Root workspace Clippy:
  `--workspace --all-targets -- -D warnings` passed.
- Runtime, compiled-loader and root workspace formatting checks passed.

The [source identities](2026-09-18-compiled-package/source-identity.json) record
the toolchain, build settings, V8 archive, implementation inputs and exact binaries.
The [repository check](2026-09-18-compiled-package/source-check.txt) passed source,
configuration and local-document-link validation.

Reproduce the package run with fresh output and already pinned public font state:

```sh
node scripts/probe-compiled-package.mjs \
  --preserved path/to/preserved-runtime --restricted path/to/restricted-runtime \
  --font path/to/DejaVuSans.woff2 --web-fonts-state path/to/pinned-font-state \
  --out artifacts/new-compiled-package-run
```

The runtime and package grammar remain experimental. Live DOM mutation, CSS
parsing, selectors, text shaping and CPU layout remain required. `--verify-app`
does not decode fonts, execute JS or open a window. CPU timing fields are
observations, not startup or memory improvement evidence. Pixel equivalence,
physical input/display transitions, general WebGL/framework compatibility,
other platforms, exact-binary parser linkage, signed distribution and a stable UI
format remain separate gates. Packages contain trusted local code and are not a
hostile-code sandbox.

## Verified fallback font correction

The [daily review](https://github.com/PANDORMedia/3JSN/pull/59#pullrequestreview-5249905651)
identified that runtime startup reopened the fallback font after its package hash
was checked. Package loading now retains the exact verified bytes from the same
bounded read, and both compiled and interpreted packaged hosts consume those
bytes. Declared and actual font sizes are bounded to 16 MiB. Explicit developer
font inputs use a bounded reader without claiming manifest verification.

Package tests pass 26/26, including deletion/replacement after loading, exact and
over-limit sizes, and specific integrity errors. Runtime option tests pass 13/13
with the parser preserved and 11/11 restricted, including interpreted-host
consumption. Strict package and scoped runtime Clippy pass in both modes.
[Receipt](2026-09-18-compiled-package/font-review/receipt.json) and
[reproduction commands](2026-09-18-compiled-package/font-review/reproduction.md)
record the pre-commit source identities. No GPU run was needed or claimed for
this byte-ownership correction. HTML/module reopening remains governed by the
existing documented quiescent-package contract.

The smaller review followups also remove an unreachable role-path collision
check, assert the specific rejection reasons, and replace locale-sensitive path
sorting with code-unit ordering. A real bundle with mixed-case/underscore paths
fails the old ordering assertion and passes the correction. Thirty CLI tests,
eight compiled-package tests and strict package Clippy pass for this followup;
[raw logs and identities](2026-09-18-compiled-package/font-review/followup/receipt.json)
are retained separately from the font checks.
