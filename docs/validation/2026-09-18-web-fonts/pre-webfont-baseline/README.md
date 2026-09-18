# Earlier Blitz test control

The [report](report.json) and [test log](tests-sanitized.log) reproduce the two
hover/scroll failures with the pre-webfont stack: 48 passes, two failures.
The assertions match the current candidate. Their underlying causes are not
established.

To reconstruct the isolated control, archive Blitz revision
`9d92719b37c801b8b41c81b799a2a474db8b3936` into
`.cache/pre-webfont-baseline/blitz`. Apply only the stacking-demotion,
boxless-geometry and layer-budget patches from 3JSN commit
`fcb7c4cd034596465ee79fc38884f675756b7091`, in that order. Verify affected source
hashes against [source-identities.json](source-identities.json).

Copy this directory's `Cargo.toml` and `Cargo.lock` into
`.cache/pre-webfont-baseline/`, and create an empty `src/lib.rs` there. Use the
unmodified cached Fontique/Parley 0.11.1 registry sources, not the prepared
webfont candidates. Effective features and the dependency audit are recorded in
[dependencies.json](dependencies.json); the graph matches published versions.
Run from the repository root with Cargo/rustc 1.93.0:

```sh
CARGO_HOME="$PWD/.cache/cargo" \
  CARGO_TARGET_DIR="$PWD/.cache/pre-webfont-baseline/target" \
  cargo test --offline --locked -j2 \
  --manifest-path .cache/pre-webfont-baseline/Cargo.toml -p blitz-dom --lib
```

Exit 101 with those exact failures is the observed baseline, not a passing test
suite. This control does not modify the shared prepared source, DOM manifest or
target, and uses neither GPU nor network access.
