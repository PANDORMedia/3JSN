# Initial containing block candidate — 2026-09-18

Historical checkpoint: the [subsequent paint-order repair](2026-09-18-paint-order.md)
resolves the two equal-z regressions described here; the candidate remains unadopted.

**Partial; not adopted.** Separating the viewport's geometry owner from HTML's
box repairs short/tall-document positioning, root margins, percentage sizing,
static anchors and cached resize behavior. It also exposes paint-order regressions.
The default renderer remains unchanged; issues #54 and #52 remain open.

| Same-input comparison | Upstream candidate baseline | Initial-owner candidate |
| --- | --- | --- |
| New initial-containing-block suite | 4/21 | 17/21 |
| Existing positioned-layout suite | 10/14 | 13/14 |
| Existing overflow suite | 6/22 | 6/22 |

A match requires both stored geometry within 0.1 CSS pixel and uniform interior
pixels within two channel levels. Raster edges are counted separately. Every
non-hidden reference case must show over 100 exact red subject pixels. Captures
use one native paint, then stored geometry reads, at a 448×256 CSS viewport and
recorded device scales 1/2. The new suite's browser, baseline and candidate use
identical HTML, JavaScript and ordered case hashes.

## Architecture and executable evidence

The adapter gives the existing Document node a definite viewport style through
public Taffy traits. Real HTML remains a normal authored element: margins,
borders, padding, position and transforms retain their own meanings. Element
layout uses the existing upstream algorithms and caches. Document is recomputed
each resolve, including its out-of-flow ownership list and overflow traversal.
HTML still supplies the root paint context; the paint bridge compensates the
coordinate origin when a box belongs to Document. Crossing Document while
finding a stacking context must return to HTML's paint context, including for
nested containing blocks.

A separate small grid patch rejects stale grid detail when an element changes
from grid to another display mode. It preserves grid caches while the element
remains a grid. This fixes the existing grid→block→grid regression without
clearing unrelated layout caches.

The [reproduction guide](../../experiments/dom-canvas/POSITIONED.md) documents the
four patch boundaries, pinned upstream revisions and isolated baseline profile.
The upstream baseline uses only the existing stacking-demotion patch; the
initial-owner profile adds grid-state, layout and paint patches. Neither applies
the no-box geometry repair or rejected overflow prototype.

Evidence includes [candidate identity](2026-09-18-initial-owner/candidate-identity.json),
[baseline identity](2026-09-18-initial-owner/baseline-identity.json), source/patch/
executable hashes, raw reports and 99 PNG captures:

- Initial suite: [browser](2026-09-18-initial-owner/initial/browser/report.json),
  [baseline comparison](2026-09-18-initial-owner/initial/baseline-comparison.json),
  [candidate comparison](2026-09-18-initial-owner/initial/candidate-comparison.json).
- Existing suites: [positioned comparison](2026-09-18-initial-owner/positioned/comparison.json)
  and [overflow comparison](2026-09-18-initial-owner/overflow/comparison.json).
  Their unchanged browser references remain with the earlier
  [positioned](2026-09-18-geometry-positioning/positioned/browser/report.json) and
  [overflow](2026-09-18-overflow/browser/report.json) evidence.
- [Nine CPU tests](2026-09-18-initial-owner/checks/candidate-tests.txt) pass:
  three grid transition/cache tests and six initial-owner tests. Before their
  respective patches, all three grid tests and all six initial-owner tests fail.
  CPU coverage includes repeated resolves, viewport resizing, scale changes,
  mutation/restoration, root decorations, auto anchors, transformed-owner sizes
  and absolute/fixed HTML roots without self-parenting. It does not assert
  transformed DOM x/y coordinates.

## Adoption failures

The new suite has four failures. `transformed-root-fixed` paints correctly but
six geometry fields omit transforms. `root-effect-fixed-auto-order` has correct
geometry but wrong overlap order; it also fails upstream. Both equal positive
and negative z-index merge cases **pass upstream and fail the new candidate**.
The new Document and HTML geometry owners feed the same paint context in owner
iteration order instead of the required paint order. These two regressions
prevent treating improved aggregate counts as a compatibility upgrade.

Sorting every box by DOM order would damage CSS order for flex/grid. A coherent
merge must account for formatting ancestry, out-of-flow boxes, `display:contents`,
anonymous layout boxes and pseudo-elements. Root effect ordering also cannot be
repaired merely by moving a node between immediate child lists. These are
follow-up requirements on #54, before adopting the ancestor clip repair on #52.

The existing transformed CSSOM and ancestor clipping failures remain. Hidden
geometry also fails here because this candidate excludes the maintained default's
no-box patch. Source review identifies additional unverified scroll boundaries:
fixed root entry, fixed descendants through effect ancestors, both hoisted z
ranges, CSSOM viewport offsets and double cancellation beneath a fixed root.
Current Taffy overflow accumulation also does not distinguish fixed contributions.
This no-scroll suite establishes none of those behaviors.

## Regression and tooling checks

The [canvas regression](2026-09-18-initial-owner/canvas-regression.json) preserves
all 21 prior capture entries and initialization results, matches all 27 browser
canvas contracts, reports no unexpected GPU validation errors and drains the
injected failure after two submitted frames. Ancestor clipping remains the
expected failing gate. Raw [canvas report](2026-09-18-initial-owner/canvas-report.json)
and [failure output](2026-09-18-initial-owner/canvas-failure.txt) are retained;
unchanged canvas PNGs remain in the earlier canvas-handoff evidence.

Strict candidate Clippy and Rust formatting pass. Sixteen Node tests pass with
localhost access; an initial sandbox run failed three tests because loopback
binding was denied. Preparation verifies 416 pinned Blitz files plus one added
file, checks both generated manifests/locks, rejects a changed added file and
rejects a source symlink into the generated directory before mutation. The
[preparation checks](2026-09-18-initial-owner/preparation-regression.json) and
[Clippy log](2026-09-18-initial-owner/checks/candidate-clippy.txt) are retained.
The existing upstream `Intrinsic` dead-code warning remains visible.

Metal evidence is offscreen on the recorded Apple M1 Pro. No visible-window,
Windows/Linux GPU, performance, complete HTML/CSS, unchanged-game or executable
packaging support is claimed. The prior published commit's source CI passed on
Linux, macOS and Windows; that CI excludes this isolated native experiment.
