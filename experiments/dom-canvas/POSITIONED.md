# Positioned layout candidate

This is an **unadopted research candidate**, separate from the default renderer.
It pins [Blitz PR #805](https://github.com/DioxusLabs/blitz/pull/805) at
`c032f63418097bb82c26077a85c24896c0a96e9d` and its Taffy dependency at
`dc2fe8bd1ad93e93f0494bdeca2561a420c8f28c`. Compilation does not establish support.

The candidate matches 19/20 [paint-order captures](../../fixtures/paint-order/README.md),
19/21
[initial-containing-block captures](../../fixtures/initial-containing-block/README.md),
13/14 [positioned captures](../../fixtures/positioned-layout/README.md), 5/17
[auto-paint captures](../../fixtures/auto-paint/README.md), and 5/22
[overflow captures](../../fixtures/overflow-paint/README.md). Both equal-z
owner-merge regressions from the initial-owner checkpoint are repaired.
Effect/z:auto ordering, transformed DOM geometry, ancestor clipping and input/
scrolling gaps prevent adoption. See the
[recorded evidence](../../docs/validation/2026-09-18-transform-context.md).
Overflow previously scored 6/22: fresh transform removal exposes an ancestor-clip
failure that the old classifier hid for one frame. Repeating that state also fails
on the old candidate. This remains an unadopted candidate with known regressions.

## Ownership and patch boundaries

The viewport-sized Document owns the initial containing block. HTML remains a
normal authored CSS box and the root paint context. A small adapter implements
public Taffy traits only for Document, delegates real elements to `BaseDocument`,
and uses the existing block and out-of-flow algorithms. It does not rewrite
HTML styles or copy a positioning algorithm. The synthetic container is rebuilt
each resolve; descendant layout caches remain in use.

Seven ordered patches define this candidate:

| Patch | Responsibility |
| --- | --- |
| `blitz-stacking-demotion.patch` | Existing stale stacking-list repair. |
| `blitz-positioned-grid-state.patch` | Expose cached grid tracks only while the element remains a CSS grid. |
| `blitz-initial-containing-block-layout.patch` | Separate Document viewport geometry from HTML layout through public Taffy APIs. |
| `blitz-initial-containing-block-paint.patch` | Route Document-owned boxes through HTML's paint context, compensate root offsets and preserve the root entry through containing-block traversal. |
| `blitz-positioned-paint-order.patch` | Merge equal nonzero z-index entries in current formatting-tree order, preserving CSS order, generated boxes, source ties and retained nonparticipant slots. |
| `blitz-transform-context.patch` | Classify transform contexts from current computed style, including identity transforms, with CSS-box applicability controls. |
| `blitz-stacking-bounds.patch` | Refresh active stacking-list hit bounds after layout, including contexts without out-of-flow attachments. |

Paint ranks follow formatting ancestry, including flex/grid order, pseudo-elements,
anonymous wrappers and flattened `display:contents` descendants. Hidden subtrees
cannot contribute stale layout-parent links. Active entries require a rooted rank;
known nonparticipants keep their original slots. The module uses transient ranks
and changes no geometry coordinates or zero-level ownership.

Transform classification uses Stylo's maintained predicate, since cached affine
presence cannot describe current ownership. Bounds refresh reuses the existing
post-layout pass and rooted rank guard. This now visits live contexts even on
frames without out-of-flow changes or equal-z ties; its cost is not benchmarked.
It refreshes the existing untransformed border bounds, not general transformed
or overflowing subtree bounds.

Root effects still expose a z:auto ordering failure that cannot be fixed by
sorting existing lists. Collecting those entries must preserve applicable clip
ancestors and reverse hit traversal as well as coordinates. The existing hit
path also lacks complete no-box rejection; preserving hidden entries' slots
avoids promoting them but does not certify general hidden-content input behavior.
The current hit/paint scroll handling has no complete shared coordinate-space
contract. Root-fixed, nested effect and hoisted positive/negative-z paths remain
gates; no scrolling support is claimed from these no-scroll captures.

The rejected overflow prototype and maintained default's no-box geometry patch
are excluded. Hidden-node failures in the overflow suite therefore remain visible.
Neither normal `prepare.mjs` nor its prepared source is changed by this candidate.

## Reproduce both profiles

Prerequisites: Node.js 24+, Git, tar, the normal experiment's cached dependencies,
and a local Blitz Git repository containing the exact candidate commit.
Preparation never fetches, checks out or resolves dependencies. It archives
immutable Git objects, checks every tracked source file and the two explicit added
modules, verifies patch hashes and resulting contents, and rejects extra files or
symlinks. Do not prepare while building or capturing the same profile.

From the repository root:

```sh
export CARGO_HOME="$PWD/.cache/cargo"
export CARGO_TARGET_DIR="$PWD/target"
node experiments/dom-canvas/prepare.mjs --check
node experiments/dom-canvas/prepare-positioned.mjs /path/to/local/blitz
node experiments/dom-canvas/prepare-positioned.mjs /path/to/local/blitz --check
node experiments/dom-canvas/prepare-positioned.mjs /path/to/local/blitz --baseline
node experiments/dom-canvas/prepare-positioned.mjs /path/to/local/blitz --baseline --check
```

Default candidate output is `.cache/positioned-candidate/{blitz,probe}`. The
`--baseline` profile uses `.cache/positioned-candidate-baseline/{blitz,probe}` and
applies only the existing stacking-demotion patch. It reproduces the upstream
candidate evaluated previously. The supplied source checkout stays unchanged.
This profile is distinct from the newer paint-order report's baseline, which
uses all four patches from repository commit `de0658b`. Reproducing that baseline
requires that commit's preparation/build in a separate checkout, with the current
paint-order fixture inputs; retain its executable and preparation identity before
building the fifth-patch candidate.
The transform-context report instead uses the five-patch `de902ac` baseline;
its preserved binary is compared to this seven-patch candidate with identical
auto-paint inputs and the separate overflow transform-reset sequence.

Generated manifests derive from the tracked experiment manifest. Paths become
absolute, Blitz revisions change, and package/binary names are distinct. The
tracked lock changes only the Taffy source and probe package name. Only the
initial-owner profile adds the `positioned-layout` integration test target.
Generated paths stay ignored. Save preparation JSON and executable hashes with
captures; do not attribute an old executable to newly prepared source.

```sh
cargo test --locked --offline -j2 \
  --manifest-path .cache/positioned-candidate/probe/Cargo.toml \
  --test positioned-layout
cargo build --locked --offline -j2 \
  --manifest-path .cache/positioned-candidate/probe/Cargo.toml --bins
cargo build --locked --offline -j2 \
  --manifest-path .cache/positioned-candidate-baseline/probe/Cargo.toml \
  --bin threejs-positioned-baseline-overflow-paint-probe
node scripts/compatibility/paint-reference.mjs \
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  artifacts/initial-containing-block/browser initial-containing-block
MTL_DEBUG_LAYER=1 target/debug/threejs-positioned-overflow-paint-probe \
  fixtures/initial-containing-block/index.html fixtures/initial-containing-block/fixture.js \
  fixtures/initial-containing-block/cases.json artifacts/initial-containing-block/candidate
MTL_DEBUG_LAYER=1 target/debug/threejs-positioned-baseline-overflow-paint-probe \
  fixtures/initial-containing-block/index.html fixtures/initial-containing-block/fixture.js \
  fixtures/initial-containing-block/cases.json artifacts/initial-containing-block/baseline
node experiments/dom-canvas/compare-clips.mjs \
  artifacts/initial-containing-block/browser artifacts/initial-containing-block/candidate \
  artifacts/initial-containing-block/candidate-comparison.json
```

Capture requires macOS Metal access; it records one paint per case and stored
geometry afterward. Comparison exits nonzero for partial parity, independently
of successful capture/cleanup. Repeat comparison against the baseline directory.
Use the same executable with the positioned-layout and overflow-paint fixtures
to check their separate matrices, and the candidate canvas binary for lifecycle
and initialization regressions. The candidate's full geometry test target is
not expected to pass because its no-box patch is deliberately excluded.

Run the additional painting and hit references with the same browser binary:

```sh
node scripts/compatibility/paint-reference.mjs \
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  artifacts/paint-order/browser paint-order
node scripts/compatibility/paint-hit-reference.mjs \
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  artifacts/paint-order/browser-hit-reference.json
MTL_DEBUG_LAYER=1 target/debug/threejs-positioned-overflow-paint-probe \
  fixtures/paint-order/index.html fixtures/paint-order/fixture.js \
  fixtures/paint-order/cases.json artifacts/paint-order/candidate
node experiments/dom-canvas/compare-clips.mjs \
  artifacts/paint-order/browser artifacts/paint-order/candidate \
  artifacts/paint-order/candidate-comparison.json
```

The `positioned-layout` CPU target now contains 28 regressions. They include the
native expectations for the shared hit fixture, anonymous-wrapper hide/show,
retained hidden entries, repeated DOM/CSS-order mutations, current transform
contexts and post-layout hit bounds. Hardware paint and
canvas lifecycle evidence remains a separate requirement.

The [paint-ownership investigation](../../docs/investigations/paint-ownership.md)
defines the next collection boundary and its effect/clip constraints. The
[transform hit fixture](../../fixtures/transform-context/README.md) and
[auto-paint matrix](../../fixtures/auto-paint/README.md) exercise the prerequisite
repairs without changing the fixture's positioning to fit the native result.

```sh
node scripts/compatibility/paint-reference.mjs /path/to/chrome artifacts/auto-paint/browser auto-paint
node scripts/compatibility/transform-hit-reference.mjs /path/to/chrome artifacts/auto-paint/browser-hit-reference.json
MTL_DEBUG_LAYER=1 target/debug/threejs-positioned-overflow-paint-probe \
  fixtures/auto-paint/index.html fixtures/auto-paint/fixture.js \
  fixtures/auto-paint/cases.json artifacts/auto-paint/candidate
node experiments/dom-canvas/compare-clips.mjs artifacts/auto-paint/browser \
  artifacts/auto-paint/candidate artifacts/auto-paint/candidate-comparison.json
MTL_DEBUG_LAYER=1 target/debug/threejs-positioned-overflow-paint-probe \
  fixtures/overflow-paint/index.html fixtures/overflow-paint/fixture.js \
  fixtures/overflow-paint/transform-reset-cases.json artifacts/auto-paint/transform-reset/candidate
```

Repeat the last command with the preserved `de902ac` binary and a separate output
directory to observe the baseline's one-frame clip pass followed by failure.
The normal matrix comparison intentionally exits 1 while parity is partial.
