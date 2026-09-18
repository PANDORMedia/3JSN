# Portable native package checkpoint

The [experimental build command](../build.md) now produces a portable directory
for the native-window Three.js fixture. The native player discovers and validates
its adjacent application manifest without Node or build tooling. This is progress
on [#38](https://github.com/PANDORMedia/3JSN/issues/38) and
[#41](https://github.com/PANDORMedia/3JSN/issues/41); the unchanged-web-project and
multi-platform distribution gates remain open.

## Measured behavior

The final [hardware report](2026-09-18-native-package/hardware-report.json) was
captured with the reviewed CLI sources and an optimized Rust player on this Apple
M1 Pro Mac. The probe:

1. Copied the shared public fixture into a disposable project and built it without
   changing its source. The before/after tree snapshots match.
2. Moved the package into a directory containing spaces, Unicode and `#`, then
   deleted the disposable build input.
3. Ran the copied native executable from an unrelated working directory with a
   restricted PATH. A separate lookup confirmed Node was absent from that PATH.
4. Presented **120 Metal frames** through the same JavaScript GPU device and a
   non-fallback Apple M1 Pro adapter, then completed cleanly. Metal API Validation
   was enabled; the recorded stderr contains no GPU validation errors.
5. Modified the packaged source map. The player rejected its checksum before
   graphics startup. The original bytes were restored and their hash rechecked.
6. Built another package whose imported module throws asynchronously. It exited
   with status 1 and the original error message, retaining a generated
   `app/main.mjs:3:9` stack location. Original-source map translation is not yet
   wired into the runtime.

This is a hardware correctness test, not a frame-rate measurement or a clean
machine test. The parent probe uses Node, and other copies of public fixture
sources and system libraries still exist on the development machine. The native
process does not launch Node or a web server. Its inspected dynamic-link list
contains system frameworks/libraries; that inspection does not establish all
minimum-OS or distribution requirements.

The command-line entry itself also built the example and its output passed the
player's `--verify-app` check. Source maps retain bundled source text and virtual
labels; maps and JS are both covered by the manifest's SHA-256/size checks.

## Checks and review

- **70 Node tests pass**, including 21 new CLI cases using real bundling and
  filesystem operations. They cover target/profile refusal, source preservation,
  no overwrite, input mutation, unsupported imports/maps, cancellation and
  unknown preservation when a final source recheck fails.
- Workspace Rust tests pass: **10 player unit tests**, the new executable package
  integration test, **7 runtime unit tests**, and the runtime execution suite.
  One explicit GPU-only test and one documentation example remain ignored by the
  CPU command; hardware evidence is the separate probe above.
- Strict workspace Clippy, formatting and source checks pass.

The initial sandboxed Node suite encountered the existing fixture server's
loopback `EPERM`; the complete authorized-loopback rerun passed. The read-only
review identified and resolved reserved executable-name collisions, portable-path
characters, unmeasured chained maps and stale failure-path preservation evidence.
The final hardware capture follows those changes and pins its own build inputs.

[Archive receipt](2026-09-18-native-package/receipt.json),
[build metadata](2026-09-18-native-package/build-metadata.json), and the test/native
logs retain identities and command outcomes. No native binaries or source-map
payloads are committed in this archive.

## Remaining work

`native-window-v1` packages an explicit native-window fixture. It does not turn
HTML entry pages, WebGL renderers or arbitrary browser services into a working
native game. Existing npm/Vite workflows, application assets/origins, `check/run`,
DOM input, unchanged CtF acceptance, cross-host workers, other-platform hardware,
mapped errors, signing and complete redistribution notices remain unfinished.
The broad desktop compatibility profile is unchanged.

Reproduce with the commands in [the build guide](../build.md), using a fresh output
directory. Source/outputs must remain quiescent; checksums are integrity evidence,
not signatures or a sandbox. Forced termination can leave an incomplete output.
