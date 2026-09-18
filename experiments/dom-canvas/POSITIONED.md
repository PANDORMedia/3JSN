# Positioned layout candidate

This is an **unadopted research candidate**, separate from the default renderer.
It pins [Blitz PR #805](https://github.com/DioxusLabs/blitz/pull/805) at
`c032f63418097bb82c26077a85c24896c0a96e9d` and its Taffy dependency at
`dc2fe8bd1ad93e93f0494bdeca2561a420c8f28c`. Compilation does not establish support.

Two explicit paint paths now share this layout candidate. Legacy traversal retains
all 142 case records from its preserved baseline. The opt-in
[ownership renderer](OWNERSHIP.md) matches browser geometry and uniform interior
pixels in 136/142 cases, and uniform interior pixels in all 142. Six DOM geometry
mismatches remain. See the [current validation](../../docs/validation/2026-09-18-ownership-renderer.md).
These box fixtures do not establish text, antialias-edge, input, scrolling or
complete HTML support. The default renderer remains unchanged.

The [opacity-output repair](../../docs/validation/2026-09-18-opacity-output.md)
extends only the opt-in traversal. It factors a shared clip prefix outside an
existing fractional-opacity group and retains local clip suffixes. All 48 old/new
clip-edge captures match browser geometry and uniform interiors; exact image
invariance remains a separate, partial result. The earlier 142 case payloads are
unchanged in both traversals. See [the renderer contract](OWNERSHIP.md) for the
conservative identity-prefix rule and its limits.

The [own CSS rect follow-up](../../docs/validation/2026-09-18-css-rect-effect.md)
keeps the owner's CSS rect inside its opacity effect while preserving eligible
incoming clips. All 190 previous ownership captures remain unchanged. Its 16
new captures match uniform interiors and Chrome's group classification; DOM
geometry, edge-color parity and live DPR transitions remain open.

## Ownership and patch boundaries

The viewport-sized Document owns the initial containing block. HTML remains a
normal authored CSS box and the root paint context. A small adapter implements
public Taffy traits only for Document, delegates real elements to `BaseDocument`,
and uses the existing block and out-of-flow algorithms. It does not rewrite
HTML styles or copy a positioning algorithm. The synthetic container is rebuilt
each resolve; descendant layout caches remain in use.

Eleven ordered patches define this candidate:

| Patch | Responsibility |
| --- | --- |
| `blitz-stacking-demotion.patch` | Existing stale stacking-list repair. |
| `blitz-positioned-grid-state.patch` | Expose cached grid tracks only while the element remains a CSS grid. |
| `blitz-initial-containing-block-layout.patch` | Separate Document viewport geometry from HTML layout through public Taffy APIs. |
| `blitz-initial-containing-block-paint.patch` | Route Document-owned boxes through HTML's paint context, compensate root offsets and preserve the root entry through containing-block traversal. |
| `blitz-positioned-paint-order.patch` | Merge equal nonzero z-index entries in current formatting-tree order, preserving CSS order, generated boxes, source ties and retained nonparticipant slots. |
| `blitz-transform-context.patch` | Classify transform contexts from current computed style, including identity transforms, with CSS-box applicability controls. |
| `blitz-stacking-bounds.patch` | Refresh active stacking-list hit bounds after layout, including contexts without out-of-flow attachments. |
| `blitz-shared-clip-geometry.patch` | Move the existing rounded-box geometry into DOM for painting and future clip predicates, removing its old paint-side copy. |
| `blitz-paint-ownership.patch` | Build a read-only post-layout ownership plan with explicit unsupported errors; does not replace legacy rendering or hit lists. |
| `blitz-layer-budget.patch` | Return explicit whole-paint layer errors before GPU submission, covering direct clips/effects, widgets and subdocuments. Also applied to the default and upstream baseline profiles. |
| `blitz-ownership-renderer.patch` | Add an explicit ownership traversal, contribution clip routes, shared opacity-output prefixes and typed preflight errors while sharing checked lifecycle and primitives with legacy paint. |

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

Legacy root effects expose a z:auto ordering failure that cannot be fixed by
sorting existing lists. The new traversal consumes the read-only ownership plan
and retains contribution-specific clip suffixes inside effects, with proven
common prefixes around fractional-opacity groups. Reverse hit traversal remains
a separate consumer to implement. The existing hit
path also lacks complete no-box rejection; preserving hidden entries' slots
avoids promoting them but does not certify general hidden-content input behavior.
The current hit/paint scroll handling has no complete shared coordinate-space
contract. Root-fixed, nested effect and hoisted positive/negative-z paths remain
gates; no scrolling support is claimed from these no-scroll captures.

The rejected overflow prototype and maintained default's no-box geometry patch
are excluded. Hidden-node failures in the overflow suite therefore remain visible.
The ownership/layout patches remain isolated from normal `prepare.mjs`. The
independent layer-budget correction is shared by all three prepared profiles.

## Reproduce both profiles

Prerequisites: Node.js 24+, Git, tar, the normal experiment's cached dependencies,
and a local Blitz Git repository containing the exact candidate commit.
Preparation never fetches, checks out or resolves dependencies. It archives
immutable Git objects, checks 413 retained tracked files and nine added modules,
verifies three removed files stay absent, checks patch hashes and resulting
contents, and rejects extra files or symlinks. Do not prepare while building or capturing the same profile.

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
applies the existing stacking-demotion patch and the shared budget correction.
It preserves upstream layout/paint ownership, with observable budget failure.
To reproduce the exact older upstream baseline, use that checkpoint's preparer
and host source. The supplied source checkout stays unchanged.
This profile is distinct from the newer paint-order report's baseline, which
uses all four patches from repository commit `de0658b`. Reproducing that baseline
requires that commit's preparation/build in a separate checkout, with the current
paint-order fixture inputs; retain its executable and preparation identity before
building the fifth-patch candidate.
The transform-context report instead uses the five-patch `de902ac` baseline;
its preserved binary was compared to the seven-patch candidate with identical
auto-paint inputs and the separate overflow transform-reset sequence.

Generated manifests derive from the tracked experiment manifest. Paths become
absolute, Blitz revisions change, and package/binary names are distinct. The
tracked lock changes only the Taffy source and probe package name. All profiles
include the five public `layer-budget` tests. Only the
initial-owner profile adds the `positioned-layout` and `ownership-render` test
targets, `threejs-positioned-paint-owner-probe` diagnostic, and
`threejs-positioned-ownership-paint-probe` renderer executable.
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

The `positioned-layout` CPU target now contains 42 regressions. They include the
native expectations for the shared hit fixture, anonymous-wrapper hide/show,
retained hidden entries, repeated DOM/CSS-order mutations, current transform
contexts and post-layout hit bounds. Hardware paint and
canvas lifecycle evidence remains a separate requirement.

The [paint-ownership investigation](../../docs/investigations/paint-ownership.md)
defines the collection boundary and its effect/clip constraints. The
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

## Inspect ownership without changing rendering

The ninth patch exposes a post-layout `PaintOwnershipPlan` that keeps formatting
ancestry, geometry owners and real stacking contexts separate. It only describes
box contributions. Legacy painting and hit testing still use the old lists;
the explicit ownership renderer consumes this plan without modifying them.
Reverse hit traversal remains an adoption gate.

```sh
target/debug/threejs-positioned-paint-owner-probe \
  fixtures/paint-ownership/index.html fixtures/paint-ownership/fixture.js \
  fixtures/paint-ownership/cases.json artifacts/paint-ownership/plan.json
```

Create the output directory first. The executable uses the existing V8 DOM
bindings, executes each real fixture mutation and resolves once per case. It
writes node/owner identities, phases, formatting ranks, current coordinate prefixes
and legacy attachments. It requests no GPU. Exit 0 means the plan was collected,
not that its proposed order rendered correctly; unsupported cases save a node
and issue code and exit nonzero. It does not fall back to a different plan.

Unsupported computed context triggers, floats, scrolling, 3D/singular transforms
and positioned/effected non-atomic inline fragments are explicit gates. CSS
declarations discarded by Stylo cannot be diagnosed from computed styles;
`transform-box` remains such a gap. The plan's shared document borrow prevents
ordinary mutable API calls, but callers must also avoid direct interior-cell
writes until they discard it.

The eighth patch moves the existing `CssBox` paths and radius implementation into
DOM; paint imports that shared implementation. Padding/content point predicates
close open paths and use nonzero winding. They provide geometry only: no clip
eligibility, hit-test traversal or layer-budget change is implied. See the
[ownership design](../../docs/investigations/paint-ownership.md) and
[effect fixture](../../fixtures/paint-ownership/README.md).

## Check paint budgets

The tenth patch is shared with the default and upstream baseline profiles. It
changes the paint entry point to return a typed result. The host discards failed
scenes before GPU submission; fragment balance and widget resource lifecycle
requirements are documented in the [default experiment](README.md).

```sh
cargo test --locked --offline -j2 --manifest-path .cache/positioned-candidate/probe/Cargo.toml --test layer-budget
cargo test --locked --offline -j2 --manifest-path .cache/positioned-candidate/probe/Cargo.toml -p blitz-paint --lib
node scripts/compatibility/paint-reference.mjs /path/to/chrome artifacts/paint-budget/browser paint-budget
MTL_DEBUG_LAYER=1 target/debug/threejs-positioned-overflow-paint-probe \
  fixtures/paint-budget/index.html fixtures/paint-budget/fixture.js \
  fixtures/paint-budget/cases.json artifacts/paint-budget/default-limits
MTL_DEBUG_LAYER=1 target/debug/threejs-positioned-overflow-paint-probe \
  fixtures/paint-budget/index.html fixtures/paint-budget/fixture.js \
  fixtures/paint-budget/cases.json artifacts/paint-budget/raised-limits \
  fixtures/paint-budget/raised-limits.json
node experiments/dom-canvas/compare-clips.mjs artifacts/paint-budget/browser \
  artifacts/paint-budget/raised-limits artifacts/paint-budget/comparison.json
```

Use fresh output directories. The default-limit command intentionally exits 1
at the wide case, after the first small capture; it writes no failed-frame PNG
or success report. The raised-limit command must capture all three cases and
match the browser. Repeat with `threejs-overflow-paint-probe` for the default
profile. The optional fifth argument is strict JSON containing the independent
`maxTotalLayers` and `maxLayerDepth` unsigned limits.

The [checkpoint](../../docs/validation/2026-09-18-paint-budget.md) also preserves
14 [clip-routing controls](../../fixtures/effect-clip-routing/README.md). Run the
same browser/native commands with `effect-clip-routing` and its fixture paths.
Legacy parity remains 8/14, separate from the budget fixture's 3/3 result.
The ownership renderer matches all 14 clip-routing controls.

## Opt-in ownership capture

After preparing and building the candidate:

```sh
cargo test --locked --offline -j2 --manifest-path .cache/positioned-candidate/probe/Cargo.toml --test ownership-render
cargo test --locked --offline -j2 --manifest-path .cache/positioned-candidate/probe/Cargo.toml -p blitz-paint --lib
node scripts/compatibility/paint-reference.mjs /path/to/chrome artifacts/ownership-render/browser ownership-render
MTL_DEBUG_LAYER=1 target/debug/threejs-positioned-ownership-paint-probe fixtures/ownership-render/index.html fixtures/ownership-render/fixture.js fixtures/ownership-render/cases.json artifacts/ownership-render/native
node experiments/dom-canvas/compare-clips.mjs artifacts/ownership-render/browser artifacts/ownership-render/native artifacts/ownership-render/comparison.json
```

Keep unsupported errors and geometry mismatches visible. The ordinary overflow
probe still selects legacy traversal. Do not replace it silently in existing
benchmarks or interpret the new box-only paint path as backend adoption.

For the opacity-output fixture, use the same capture/comparison tools with its
own inputs and preserve exact within-renderer invariants separately:

```sh
node scripts/compatibility/paint-reference.mjs /path/to/chrome artifacts/opacity-output/browser opacity-output
MTL_DEBUG_LAYER=1 target/debug/threejs-positioned-ownership-paint-probe fixtures/opacity-output/index.html fixtures/opacity-output/fixture.js fixtures/opacity-output/cases.json artifacts/opacity-output/native
node experiments/dom-canvas/compare-clips.mjs artifacts/opacity-output/browser artifacts/opacity-output/native artifacts/opacity-output/comparison.json
node experiments/dom-canvas/compare-clip-invariants.mjs fixtures/opacity-output artifacts/opacity-output/browser artifacts/opacity-output/browser-invariants.json
node experiments/dom-canvas/compare-clip-invariants.mjs fixtures/opacity-output artifacts/opacity-output/native artifacts/opacity-output/native-invariants.json
```

Use fresh capture directories. The two invariant commands intentionally exit 1
for the recorded 10/12 classification: same-owner rounded overflow remains
noninvariant at both scales. The independent browser/native comparison passes
26/26 geometry/interior checks, excluding raster edges as documented by that
comparator. These results do not certify equal antialiased pixels or performance.
