# Runtime extension source embedding

The runtime embeds its own JavaScript and its Deno extension JavaScript at compile
time. Application modules still use the explicit local module loader. This change
does not package a game or change the application compatibility boundary.

## Why the adapter exists

In the pinned `deno_core` 0.412.0 API, an `extension!` file declaration can produce
`ExtensionFileSourceCode::LoadedFromFsDuringSnapshot`. Despite its name, loading
that source without a snapshot reads the recorded build-machine path at runtime.
Release compilation alone does not replace it with embedded code. An executable
could therefore depend on both the checkout and Cargo registry, or execute edited
bootstrap code without rebuilding.

`deno_core` embeds its own internal runtime sources with `ascii_str_include!`:
`00_primordials.js` and `00_infra.js` set up the context, `02_timers.js` and
`01_core.js` provide builtins, and `mod.js` provides the builtin ESM module.
`ext:core/ops` is a synthesized module, not an external source file. These
declarations are in the pinned crate's `runtime/jsruntime.rs`. The additional
`deno_webidl` 0.259.0, `deno_web` 0.290.0, `deno_webgpu` 0.226.0 and 3JSN bootstrap
declarations need the adapter described here.

## Build and runtime ownership

[build.rs](../../crates/js-sources/build.rs) constructs the dependency extension
declarations and enumerates `js_files`, `esm_files`, `lazy_loaded_esm_files` and
`lazy_loaded_js_files`. It does not create an isolate or GPU device, or execute the
extensions' state callbacks. Dependency source filenames are discovered from
their declarations, rather than duplicated in a maintained list.

The native runtime's local `bootstrap.js`, `web-globals.js`, `window.js`,
`animation.js` and `input.js` use direct `ascii_str_include!` declarations in
[embedded.rs](../../crates/runtime/src/embedded.rs). They no longer need a generated
build-time table. The shared web globals initialize the same Event/EventTarget
and WebGPU classes before window or DOM adapters. Dependency source paths produce Cargo
`rerun-if-changed` instructions. Missing files, duplicate specifiers and non-ASCII
extension sources fail the build. The pinned Deno API requires ASCII for these
fast static strings.

A sorted specifier-to-`FastStaticString` table is emitted into `OUT_DIR` using
escaped source literals and `deno_core::ascii_str!`. The generated table contains
source bytes rather than absolute file paths; its order and contents are
deterministic for the same inputs. The four Deno crates are also build dependencies
at the same workspace-pinned versions, which adds a host-side build cost.

[The shared source adapter](../../crates/js-sources/src/lib.rs) replaces filesystem-backed
entries in all four categories before `JsRuntime` registers extensions. It keeps
existing in-memory sources, source specifiers, entry points, synthetic module
mappings and op/state declarations. An absent compiled entry panics with its
specifier: this is an integration defect, and reading a runtime path is never a
fallback. No V8 snapshot or upstream patch is used; normal isolate startup still
parses the embedded JavaScript.

## Validation

The focused unit tests cover every source category, the complete current
dependency declarations, unique sorted keys, preservation of
in-memory sources and a missing-entry failure. They substitute unavailable paths
before adaptation and load every resulting source from memory. Run them with:

```sh
cargo test --locked -p threejs-native-js-sources --lib
```

The [DOM packaging checkpoint](2026-09-18-dom-package.md) extracted this adapter
into `threejs-native-js-sources` for both players. The five shared tests still
pass; native V8 execution checks cover the directly embedded local bootstrap.
The counts and results below describe earlier revisions before that extraction.

On the macOS arm64 development host, all five tests passed on 2026-09-18. The
then-generated table contained 32 sources: 29 dependency modules and three 3JSN modules.
Three generated copies from separate build profiles were byte-identical and
contained no absolute user paths. This is source-embedding evidence, not a
cross-platform packaging certification.

The subsequent globals extraction adds one local module (33 sources total).
It changes module organization, not the initialized globals or dependency-source
boundary. The same embedding coverage tests include the new specifier.
All five embedding tests and the V8 execution regression passed again; the
generated release table was checked to contain 33 entries. The separate
[Three.js release regression](2026-09-18-native-html-runtime-regression.json)
also passed with the extracted globals.

A macOS release-player integration run also passed the Three.js offscreen scene
while a Seatbelt policy denied all file reads under the runtime crate sources and
the Cargo registry source tree. A `cat` control under the same policy failed with
`Operation not permitted`. The GPU run still verified 14,345 foreground pixels
and 5,041 changed pixels with Metal validation enabled. This exercises builtins,
lazy WebGPU sources and the bundled application module; it does not certify
installation on another machine or platform.

These tests establish the extension-source boundary. A copied executable still
needs separate integration checks for application assets, native dynamic
libraries, target-specific build dependencies and platform packaging. Merely
running a copy while the original checkout remains readable is insufficient
evidence that it no longer reads the checkout.
