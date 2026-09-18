# Observable paint budgets and effect clip routing

Status: **research renderer correction; ownership candidate remains unadopted**.
The shared paint entry point now rejects an over-budget frame instead of silently
omitting required clips or effects. This correction applies to the maintained
default, the upstream layout baseline and the positioned ownership candidate.
It does not install the read-only ownership plan or change clip eligibility.

## Failure and correction

The [public budget fixture](../../fixtures/paint-budget/README.md) places 1,100
small blue opacity groups before a larger red subject with opacity 0.5. The
preserved nine-patch executable from `ae6579c` reports successful capture but
paints the wide subject fully opaque: `[224,32,48,255]` instead of the browser's
`[239,143,151,255]`. Geometry still matches and the GPU reports no error. The
[baseline comparison](2026-09-18-paint-budget/baseline-comparison.json) is 2/3,
with 7,812 interior differences in the wide state.

The old manager counted cumulative pushes, admitted 1,025 under a nominal 1,024
limit, then continued drawing without later required layers. Direct masks,
shadows, SVG/widget commands and separate subdocuments could also bypass its
accounting. Its peak-depth update wrote the wrong counter.

`paint_scene(..., PaintLimits) -> Result<PaintStats, PaintError>` is now the single
public entry. A forwarding checked scene counts every emitted clip/effect push
across the whole call, including subdocuments and replayed widget fragments.
Default inclusive limits are 1,024 total accepted layers and 1,024 open layers.
Statistics report accepted total and peak depth. The first error retains the
active document/node, rejected command kind and attempted count, accepted
statistics and configured limits.

After an error, drawing stops reaching the sink and accepted layers are balanced.
The host discards its fresh scene before `render_to_texture`. Previously accepted
commands are not rolled back; immediate-mode sinks cannot provide this guarantee.
Custom-widget resource operations remain outside the scene transaction and use
the host's established resource cleanup. Fragments must be self-balanced: the
checker validates the combined command stack, not isolation at every fragment
boundary. The limits do not bound DOM traversal, recursion or backend GPU memory.

## Hardware evidence

[Budget results](2026-09-18-paint-budget/budget-regression.json) cover both the
default and candidate on Apple M1 Pro Metal with API validation enabled:

- Default limits reject attempted layer 1,025 after 1,024 accepted layers. The
  first small frame completes; the failed wide frame has no image or success
  report. Shared GPU cleanup completes.
- Explicit limits of 2,048 total and 1,024 depth produce **3/3 browser matches**,
  including the wide opacity group and reconstruction of the small scene at 2×.
- No unexpected GPU validation errors occur. The CPU API test separately retries
  the same document after a failed paint and verifies a fresh successful scene.

The [candidate regression](2026-09-18-paint-budget/regression/render-regression.json)
preserves all 112 previous native paint case records and their pixel hashes.
Those remain partial compatibility results: ownership 10/18, auto paint 5/17,
paint order 19/20, initial containing block 19/21, positioned layout 13/14 and
overflow 5/22. The complete canvas paint/initialization report, 21 captures,
27 browser contract checks and injected failure cleanup remain unchanged.
The [default canvas regression](2026-09-18-paint-budget/default-canvas/regression.json)
separately preserves those existing default-profile results.

## Clip routing evidence

The new [14-case fixture](../../fixtures/effect-clip-routing/README.md) separates
opacity, CSS rect, overflow and clip-path behavior. Official Chrome captures
match all source-derived visibility predictions; C's fixed rectangle remains
unchanged in all cases. The static-A control moves B through margin collapse,
which is recorded separately. [The audit](2026-09-18-paint-budget/effect-clips/browser-control-audit.json)
records the exact browser report identity and subject pixel counts.

The tested Chrome revision attaches B's path to its incoming clip chain and
propagates that path to fixed descendants. CSS rect can instead reparent its
shape into the fixed clip context; opacity can omit a common output clip when
contributions escape. The fixture README links the exact Chromium code/tests
and explains the unresolved standards boundary. These are implementation-specific
observations, not a claim of agreement across browser engines.

Native comparison remains **8/14** before and after the budget correction; all
14 geometries match and all native case records are unchanged. The
[ownership design](../investigations/paint-ownership.md) now records distinct clip
routes, per-contribution clipping inside one effect group, paint-owned bounds
and the renderer phase split needed before replacing legacy traversal.

## Checks and identities

The [source identity](2026-09-18-paint-budget/source-identity.json) records
source/preparation and executable hashes. The archive contains 56 public fixture
PNGs, comparisons and regression reports. Historical evidence remains unchanged.
All three preparers check exact source contents and reject added-module tampering,
extra files and symlinks; the candidate also rejects removed-file resurrection.
Two fresh preparations and read-only verification agree for each profile; see
the [integrity controls](2026-09-18-paint-budget/preparation-regression.json).

The focused Rust checks pass: [42 existing regressions plus five public budget
tests](2026-09-18-paint-budget/checks/candidate-tests.txt), those five repeated
against [default](2026-09-18-paint-budget/checks/default-tests.txt) and
[upstream baseline](2026-09-18-paint-budget/checks/baseline-tests.txt), and
[six private checked-scene tests](2026-09-18-paint-budget/checks/library-tests.txt).
All [21 Node tests](2026-09-18-paint-budget/checks/node-tests.txt), formatting,
and strict host Clippy for default and candidate pass.
The pre-existing upstream `Intrinsic` dead-code warning remains visible.

This does not establish native-window presentation, general HTML/input support,
performance gains, other-platform GPU correctness or unchanged-game packaging.
Issues #52, #54, #24 and #25 remain open. See the
[reproduction commands](../../experiments/dom-canvas/POSITIONED.md).
