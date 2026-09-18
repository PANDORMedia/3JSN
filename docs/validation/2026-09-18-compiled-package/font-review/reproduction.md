# PR 59 fallback font ownership repair

Base: 65d930f27877ed9240488dc18c2b0eb0733d2b9a, branch codex/compiled-ui-packaging. No commit or push. Source hashes are in receipt.json.

Application.font now owns optional Vec<u8>; the loader bounds the declared fallback to 16 MiB before payload I/O, then reads at most 16 MiB + one sentinel byte from the same opened File used for hashing. Only the fully verified application escapes load_for. Compiled window/measurement options and interpreted window options consume those bytes directly. Direct developer font paths use read_font, which is bounded but does not claim hash verification or font decoding. HTML/module path loading remains subject to the documented quiescent trusted-package contract.

Checks: package tests 26/26; runtime package_options 13/13 default (includes interpreted host controls), 11/11 restricted; package all-targets Clippy and runtime bin+package_options Clippy in both modes with -D warnings; rustfmt and git diff --check. Existing Parley deprecation and Blitz dead-code dependency warnings remain. No GPU run.

All Cargo commands ran from this worktree, offline/locked, -j2. Environment: CARGO_HOME=/Users/sean/dev/3JSN/.cache/cargo, CARGO_TARGET_DIR=/Users/sean/dev/3JSN/target, CARGO_INCREMENTAL=0. Runtime commands also set RUSTY_V8_ARCHIVE=/Users/sean/dev/3JSN/target/release/gn_out/obj/librusty_v8.a.

- cargo test --offline --locked -p threejs-native-package -j2
- cargo clippy --offline --locked -p threejs-native-package --all-targets -j2 -- -D warnings
- cargo test --offline --locked --manifest-path experiments/compiled-ui-runtime/Cargo.toml --test package_options [--no-default-features] -j2
- cargo clippy --offline --locked --manifest-path experiments/compiled-ui-runtime/Cargo.toml --bin threejs-compiled-ui-runtime --test package_options [--no-default-features] -j2 -- -D warnings

The first runtime test attempt mistakenly targeted package-target and was interrupted immediately when it began recompiling generic dependencies; no completed result was inferred from it. Completed runtime checks used the root target. Worktree cache dependencies are symlinks only; no preparers or shared generated source mutations occurred.
