# Positioned layout candidate

This is an **unadopted research candidate** for containing-block ownership.
It uses upstream [Blitz PR #805](https://github.com/DioxusLabs/blitz/pull/805) at
`c032f63418097bb82c26077a85c24896c0a96e9d`, whose manifest pins merged Taffy
`dc2fe8bd1ad93e93f0494bdeca2561a420c8f28c`. Only the existing stacking-demotion
patch is applied. The overflow prototype and no-box geometry patch are excluded.
Normal `prepare.mjs`, its prepared Blitz copy and the supplied Git checkout are
not changed.

Initial Metal comparison of the [positioned fixture](../../fixtures/positioned-layout/README.md)
matches 10 of 14 captures. The remaining differences concern short-document
initial-containing-block size, transformed fixed geometry and grid geometry
after changing the containing block's layout mode. The grid failure also
reproduces entirely at scale 1, so it must not be labeled a DPI-only failure.
This does not establish full absolute/fixed,
clipping, scrolling or HTML/CSS compatibility. The candidate remains separate
from the default renderer; upstream compilation or CI cannot substitute for the
browser/native comparison.

## Prepare from existing local sources

Prerequisites are Node.js 24+, Git, tar and the dependencies already cached for
the normal DOM-canvas experiment. Supply a local Blitz Git repository containing
the exact candidate commit. Preparation never fetches, checks out, installs,
resolves dependencies or builds. A missing commit or source cache is an error.
The supplied repository may have a different HEAD or local changes: preparation
archives the pinned Git objects, not its working tree.

From the 3JSN repository root, after normal dependency preparation:

```sh
export CARGO_HOME="$PWD/.cache/cargo"
export CARGO_TARGET_DIR="$PWD/target"
node experiments/dom-canvas/prepare.mjs --check
node experiments/dom-canvas/prepare-positioned.mjs /path/to/local/blitz
node experiments/dom-canvas/prepare-positioned.mjs /path/to/local/blitz --check
```

The new script generates `.cache/positioned-candidate/blitz` and
`.cache/positioned-candidate/probe/{Cargo.toml,Cargo.lock}`. Only these dedicated
generated sources/manifests are replaced on preparation. Do not prepare again
while compiling or capturing this candidate. `--check` verifies existing output
without writing it. Its JSON output records source, patch and manifest/lock
identities; save it alongside captures when collecting evidence.

Every tracked Blitz file is checked against the immutable commit, except the
one patched file, which has a pinned resulting SHA256. Additional files or
symlinks in the prepared Blitz directory fail verification. The shared prepared
Deno source is checked by the normal preparation's read-only verification.

The candidate manifest derives from the tracked `experiments/dom-canvas/Cargo.toml`:
Blitz revisions change to the candidate, source/patch paths become absolute, and
package/binary names gain `positioned-` to avoid overwriting default binaries in
a shared target directory. The generated manifest contains local paths and stays
ignored. The tracked lock is copied with exactly two changes: its Taffy source
identity and the probe package name. No fresh dependency resolution is performed;
the checks below use `--locked --offline`. If canonical inputs evolve beyond
these substitutions, review the generation rather than updating a lock ad hoc.

## Build and compare separately

These commands require the complete cached dependency graph. Native capture also
requires macOS hardware Metal access. Preparation itself does not run them.

```sh
cargo build --locked --offline -j2 \
  --manifest-path .cache/positioned-candidate/probe/Cargo.toml \
  --bin threejs-positioned-overflow-paint-probe
node scripts/compatibility/paint-reference.mjs \
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  artifacts/positioned-layout/browser positioned-layout
MTL_DEBUG_LAYER=1 target/debug/threejs-positioned-overflow-paint-probe \
  fixtures/positioned-layout/index.html fixtures/positioned-layout/fixture.js \
  fixtures/positioned-layout/cases.json artifacts/positioned-layout/candidate
node experiments/dom-canvas/compare-clips.mjs \
  artifacts/positioned-layout/browser artifacts/positioned-layout/candidate \
  artifacts/positioned-layout/candidate-comparison.json
```

The native capture process reports successful capture/cleanup independently of
parity. The comparator exits nonzero when geometry or uniform interior pixels
differ. Retain failures; do not rewrite fixture CSS to make the candidate pass.
Use the same executable with `fixtures/overflow-paint/{index.html,fixture.js,cases.json}`
and its browser reference to recheck the original clipping matrix. Run the
separately named canvas/geometry binaries when evaluating those regression gates.
Record the candidate's preparation identity and executable hash with each run;
do not attribute old binaries or captures to newly prepared source.

For a smaller native grid-transition diagnostic, keep the HTML/JS unchanged and
supply a separate ordered case file to the native capture executable:

```sh
mkdir -p artifacts/positioned-layout/grid-transition
cat > artifacts/positioned-layout/grid-transition/cases.json <<'JSON'
[
  { "name": "grid-static-anchor" },
  { "name": "grid-owner-area" },
  { "name": "grid-static-anchor" }
]
JSON
MTL_DEBUG_LAYER=1 target/debug/threejs-positioned-overflow-paint-probe \
  fixtures/positioned-layout/index.html fixtures/positioned-layout/fixture.js \
  artifacts/positioned-layout/grid-transition/cases.json \
  artifacts/positioned-layout/grid-transition/native
```

The final static-grid case should restore the first case's geometry. The current
candidate instead retains a different width after the intervening grid-owner
case. This command is a native diagnostic, not a browser parity comparison:
the 14-case browser report has a different case hash and order. A comparison
needs a browser reference executing this exact three-case input sequence.
