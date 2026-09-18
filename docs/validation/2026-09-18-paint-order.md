# Paint order across geometry owners — 2026-09-18

**Research candidate; not adopted.** Equal nonzero z-index boxes must share the
same painting and hit order even when their geometry belongs to different
containing blocks. The initial-owner candidate previously merged these lists in
owner visitation order. This repair ranks the current formatting tree and uses
those ranks only within equal nonzero z-index groups.

## Design boundary

The new `layout/paint_order.rs` module separates ordering from geometry ownership.
DOM preorder includes `::before` and `::after`; generated anonymous wrappers are
anchored at their first participating source descendant. Formatting ancestry
preserves the effect of a flex/grid ancestor's CSS order on its descendants.
Actual CSS display determines flex/grid ordering, since the layout library also
uses its grid algorithm for tables. Out-of-flow children use effective order zero.

Ranks are computed once for a resolve that needs them. Sorting compares scalar
ranks, without rebuilding ancestor paths inside the comparator. No persistent
rank cache or coordinate changes are introduced. Retained detached contexts and
hidden subtrees are excluded from the active formatting tree. Lifecycle tests
cover deletion and reconstruction of anonymous wrappers during hide/show.
Known hidden/boxless entries retain their slots in existing stacking lists;
only participating entries are reordered. An unclassified painted entry without
a rooted rank remains an explicit invariant failure.

The ordering rules are described in [CSS Display](https://www.w3.org/TR/css-display-3/#order-property),
[Flexbox painting](https://www.w3.org/TR/css-flexbox-1/#painting), and
[CSS painting order](https://www.w3.org/TR/CSS22/zindex.html).
The executable fixtures establish only their recorded cases.

## Validation

| Same-input comparison | Previous initial-owner candidate | Repaired candidate |
| --- | --- | --- |
| New paint-order suite | 16/20 | 19/20 |
| Initial-containing-block suite | 17/21 | 19/21 |
| Positioned-layout suite | 13/14 | 13/14 |
| Overflow suite | 6/22 | 6/22 |

The baseline here is repository commit `de0658b`, with four patches, not the
older stacking-only upstream profile selected by `--baseline`. The fifth patch
repairs both positive/negative owner-merge regressions and the new DOM-restoration
case. Every previously passing case in these matrices remains passing. All 20
new cases have matching geometry; only `effect-auto-order` still differs in
interior pixels. The initial-owner suite retains its transformed-root geometry
and effect-auto failures.

Matches require stored geometry within 0.1 CSS pixel and uniform interior pixels
within two channel levels. Raster edges are reported separately. Captures use
one native paint before stored geometry inspection, identical fixture hashes,
ordered mutations and a 448×256 CSS viewport at the recorded scales 1/2. Each
non-hidden browser reference contains over 100 exact red subject pixels.

Evidence includes 117 PNGs, raw observations, source and executable identities:

- New suite: [browser](2026-09-18-paint-order/browser/report.json),
  [baseline comparison](2026-09-18-paint-order/baseline-comparison.json), and
  [repaired comparison](2026-09-18-paint-order/candidate-comparison.json).
- Existing suites: [initial-owner](2026-09-18-paint-order/initial-comparison.json),
  [positioned](2026-09-18-paint-order/positioned-comparison.json), and
  [overflow](2026-09-18-paint-order/overflow-comparison.json). Their unchanged
  browser references remain in the earlier validation directories.
- [Baseline identity](2026-09-18-paint-order/baseline-identity.json),
  [candidate identity](2026-09-18-paint-order/candidate-identity.json), and
  [capture identity](2026-09-18-paint-order/final-capture-identity.json).
  Executable hashes are unchanged before and after the final GPU runs.

All [21 targeted CPU tests](2026-09-18-paint-order/checks/final-tests.txt) pass:
the previous nine grid/viewport tests and twelve ordering, hit and lifecycle
tests. Four tests fail in the original 18-test
[pre-repair subset](2026-09-18-paint-order/checks/baseline-tests.txt).
Review regressions reproduce the freed-wrapper crash and hidden-entry hit
promotion before their respective fixes. The origin-hit control
[passes before the ordering patch](2026-09-18-paint-order/checks/hidden-hit-baseline.txt),
[fails with the intermediate end-sentinel sort](2026-09-18-paint-order/checks/hidden-hit-red.txt),
and passes with the final slot-preserving sort.

The [shared hit reference](2026-09-18-paint-order/browser-hit-reference.json)
records 48 Chrome point/target assertions matching the native visible-box tests,
including DOM moves and repeated resolves for both z-index signs.
The [canvas regression](2026-09-18-paint-order/regression-summary.json) preserves
all 21 earlier capture entries and initialization results, matches 27 browser
contracts, reports zero unexpected GPU validation errors, and drains the
injected failure after two submitted frames. Its
[raw report](2026-09-18-paint-order/canvas-report.json) and
[failure output](2026-09-18-paint-order/canvas-failure.txt) are retained.

Strict candidate Clippy, Rust formatting, 16 Node tests and 220 source/config/
documentation checks pass. The existing
upstream `Intrinsic` dead-code warning remains visible. Two fresh preparations
are identical, all 416 upstream files plus two added modules are verified, and
tampering with the new module is rejected. The
[preparation checks](2026-09-18-paint-order/preparation-regression.json) also verify
that default prepared dependencies are unchanged. See the
[reproduction guide](../../experiments/dom-canvas/POSITIONED.md) and
[fixture contract](../../fixtures/paint-order/README.md).

## Remaining adoption gates

The effect-layer `z-index:auto` case still needs a paint-ownership repair.
Sorting existing lists cannot order a root-attached fixed child against a later
relative child nested inside another list. Moving that child without preserving
its applicable clip ancestors would introduce further overflow errors. Paint
ownership, current coordinates, clips and reverse hit traversal must agree.

Transformed DOM geometry and scrolling also remain open. The no-box geometry
repair used by the default experiment is deliberately absent from this isolated
candidate. The rejected overflow prototype is not applied. Issues #54 and #52
remain open, and the default prepared source is unchanged.

The upstream hit traversal also lacks a complete no-box rejection: inclusive
zero-size bounds can make a retained hidden entry hittable at the origin. Keeping
nonparticipant slots prevents this sorting repair from promoting such entries;
it does not repair that general hit-test gap. The recorded visible-box hit checks
must not be interpreted as full hidden-content or scrolling input support.

These offscreen Metal checks do not establish visible-window behavior,
Windows/Linux GPU support, performance, general HTML/CSS compatibility or a
packaged unchanged game.
