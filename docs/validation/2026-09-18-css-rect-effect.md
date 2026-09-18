# Own CSS rect and opacity boundary

The experimental ownership renderer now keeps an element's own `clip:rect(...)`
inside its opacity effect. Incoming clips and the owner's clip-path can still
surround the composed output. The previous decoration cap incorrectly promoted
the owner's CSS rectangle across that boundary. This updates the existing
eleventh patch; the default renderer and dependency graph are unchanged.

Preparation snapshots the eligible route after positioned-route selection and
the owner's clip-path, before its CSS rect. The longest common contribution
prefix is capped against that snapshot only when selecting an opacity group's
output clips. The original common summary remains available to enclosing groups.
Clip identity, paint order, fixed escape, local suffixes and checked layer cleanup
retain their existing contracts.

## Browser and Metal evidence

The original [16-capture fixture](../../fixtures/opacity-css-rect/README.md)
compares two coincident opaque children inside a fractionally translated CSS
rectangle, with/without a broader polygon and at opacity 1/0.5, DPR 1/2. Only the
covered blue underlay changes within each pair. All images have an opaque white
background, so these are RGB-composition controls, not varying-alpha validation.

Chrome is nonidentical in all eight pairs. The prior native renderer incorrectly
makes the four half-opacity pairs identical; after repair, all eight native pairs
are nonidentical too. **A larger exact-invariance count is not a success metric
for this fixture.** The measured differences stay on the rectangle perimeter.

| Pair, with or without the broad polygon | Chrome changed pixels / max delta | Prior native | Repaired native |
| --- | --- | --- | --- |
| Opacity 1, DPR 1 | 608 / 52 | 608 / 55 | 608 / 55 |
| Opacity 1, DPR 2 | 1,216 / 56 | 1,216 / 56 | 1,216 / 56 |
| Opacity 0.5, DPR 1 | 608 / 26 | 0 / 0 | 608 / 28 |
| Opacity 0.5, DPR 2 | 1,216 / 28 | 0 / 0 | 1,216 / 28 |

Only the four half-opacity covered-blue case payloads change. The broad polygon
strictly contains the rectangle and adds no visible edge; corresponding images
with/without it are identical within each renderer. Fractional edge coverage is
present at both DPRs, so equality cannot be attributed to integer snapping.

All **16/16 uniform interiors** match Chrome. The combined geometry/interior
comparison remains **0/16**, with the same four missing CSS-transform translations
in DOM queries per case. Rendered translation and queried geometry are distinct
observations. Matching group classification does not establish exact
cross-renderer edge colors or general clip conformance.

Receipts: [Chrome groups](2026-09-18-css-rect-effect/browser-invariants.json),
[prior groups](2026-09-18-css-rect-effect/native-invariants.json),
[repaired groups](2026-09-18-css-rect-effect/candidate-invariants.json), and
[geometry/interior comparison](2026-09-18-css-rect-effect/candidate-comparison.json).
The archive includes all 48 images,
[source identities](2026-09-18-css-rect-effect/source-identity.json),
[candidate binary identity](2026-09-18-css-rect-effect/candidate-binary.json) and logs.
Native capture uses Metal API Validation on Apple M1 Pro.
Three text logs have only trailing whitespace/final blank lines normalized;
[raw and archived hashes](2026-09-18-css-rect-effect/receipt-formatting.json)
record that formatting change. Capture reports and PNGs are unchanged.

The [independent audit](2026-09-18-css-rect-effect/independent-audit/candidate-addendum.md)
verifies candidate image hashes, the four changed cases, all 190 regression
captures and exact comparator regeneration. Its
[DPR 2 addendum](2026-09-18-css-rect-effect/independent-audit/dpr2-addendum.md)
checks straight-edge coverage against scaled and unscaled translation; inclusive
pixel bounds alone would not distinguish them.

## Regression and limitations

All **190 earlier ownership case payloads and PNG files remain byte-identical**:
the 48 clip-edge/opacity controls and 142 earlier box cases. The
[regression receipt](2026-09-18-css-rect-effect/regression-results.json) links their
previous archived inputs and hashes. Existing passes and failures are preserved;
the legacy/default paths were not changed or recaptured in this follow-up.

79 focused host tests pass: 42 layout, five budgets and 32 public renderer tests.
The three new public controls exercise own-versus-incoming rectangles, all paint
phases, nested effects, fixed overflow escape, empty/restore behavior and budget
cleanup. All three initially failed against the previous renderer. Private tests
pass 22/22, including four new route controls. Strict host Clippy, formatting,
36 Node tests and prepared-source identity verification pass. The first Node run
hit sandbox `listen EPERM` in three fixture-server tests; the authorized loopback
rerun passes. The broader suite's four known DOM geometry failures were not
rerun or claimed fixed here.

An initial public test reused one document across DPR 1→2 and exposed a separate
cache defect: the clip bound retained a `.375` translation where `.75` was
required. The [failure log](2026-09-18-css-rect-effect/dpr-transition-failure.txt)
and [diagnosis](2026-09-18-css-rect-effect/dpr-diagnosis/DIAGNOSIS.md) are preserved.
Scale-only viewport invalidation can leave box-only transform/overflow caches
clean. The final clipping test uses a fresh document at each DPR; it neither
loosens expected coordinates nor validates live display-scale transitions.

General polygon composition, text/canvas integration through this renderer,
input, scrolling, transformed DOM queries, live DPR changes and backend adoption
remain open. This is not an unchanged-game build or a performance result.

## Reproduce

Prepare/build the [candidate](../../experiments/dom-canvas/POSITIONED.md), then:

```sh
node scripts/compatibility/paint-reference.mjs /path/to/chrome artifacts/css-rect/browser opacity-css-rect
MTL_DEBUG_LAYER=1 target/debug/threejs-positioned-ownership-paint-probe fixtures/opacity-css-rect/index.html fixtures/opacity-css-rect/fixture.js fixtures/opacity-css-rect/cases.json artifacts/css-rect/native
node experiments/dom-canvas/compare-clip-invariants.mjs fixtures/opacity-css-rect artifacts/css-rect/native artifacts/css-rect/invariants.json
node experiments/dom-canvas/compare-clips.mjs artifacts/css-rect/browser artifacts/css-rect/native artifacts/css-rect/comparison.json
```

Both comparison commands currently exit 1 with valid partial reports: exact
within-renderer equality is false, and DOM query differences remain. Neither
exit is suppressed or described as a complete compatibility pass.
