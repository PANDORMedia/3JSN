# Opacity output clipping checkpoint

The opt-in ownership renderer now applies a shared clip prefix to the composed
output of an existing opacity group. All **13 targeted opacity groups** are
byte-identical across their covered-fill variants. This repairs the bounded
composition defect identified by the [clip-edge diagnostic](2026-09-18-clip-edges.md).
It does not finish clip rendering or the unchanged-game product goal.

Across all 21 proposed groups, native results improve from **0/21 to 13/21**;
Chrome is **15/21**. These are within-renderer diagnostic counts, not a percentage
of browser compatibility. The candidate remains unadopted and the default
renderer is unchanged.

## Bounded renderer change

For each existing effect with `0 < opacity < 1`, preparation computes the longest
common prefix of its decoration/content routes and the routes of its paint-owned
descendants. It compares shared clip identity and order, not equal shape geometry.
The group's decoration route caps that prefix: its own later overflow/content
clip cannot be promoted onto its background or escaping descendants. Hidden and
zero-opacity entries participate conservatively in the summary.

The traversal opens the additional shared clips outside the existing opacity
layer and removes only that prefix from contribution routes inside it. Nested
effects inherit the active prefix; an escaping fixed descendant can shorten the
inner group's prefix. The remaining clips stay attached to their contributions.
Paint order, geometry ownership, one opacity operation per group, viewport effect
bounds and the checked scene's layer accounting remain intact. No DOM reparenting
or new texture transport is introduced. Nodes with opacity one retain their
previous grouping behavior.

Preparation checks prefix consistency before scene emission and returns the typed
`InconsistentClipPrefix` error if it fails. Helper tests reject wrong identities,
wrong order and overlong prefixes. **The complete typed preflight failure branch
has no direct fault-injection test yet**; helper coverage is not presented as
end-to-end coverage of that branch.

This updates the existing ownership patch within the eleven-patch candidate.
[Source and binary identities](2026-09-18-opacity-output/source-identity.json)
pin the prepared inputs and executables. The primary captures and fresh repeat
use ownership binary SHA-256
`84e852d9d9b263d8065ed620e9db1bd9a1564c4d1fc9e395f0c1479c58125da4`.
That recorded capture identity is distinct from a later executable rebuilt by
the broad test command. The [frozen rebuilt executable](2026-09-18-opacity-output/post-broad-binary.json)
has SHA-256 `8802b1fdcea6b3fa5d06fb8500c4f6be3ed2d19957dc21faf9afe0ac16867f04`.
Its [separate 48-capture conformance run](2026-09-18-opacity-output/post-broad-comparison.json)
reproduces the original complete reports and PNG bytes exactly. Older receipts
retain their original binary identity.

## Captures and physical witnesses

The existing 22-capture clip-edge fixture is unchanged. The original
[26-capture opacity-output fixture](../../fixtures/opacity-output/README.md)
adds own/ancestor inset clipping, same-owner rounded overflow, nested opacity,
partial shared prefixes, negative/positive paint-owned fixed contributors, an
unclipped later sibling, DPR 2 and restoration. All inputs are redistributable
colored boxes without text, fonts or game assets.

| Fixture | Proposed groups | Native before | Native after | Chrome |
| --- | --- | --- | --- | --- |
| Existing clip edges, 22 captures | 9 | 0/9 | 3/9 | 5/9 |
| New opacity output, 26 captures | 12 | 0/12 | 10/12 | 10/12 |
| Combined diagnostic | 21 | 0/21 | 13/21 | 15/21 |

The 13 targeted groups are the existing polygon-opacity and two ancestor-rounded
inner-opacity groups, plus ten new groups excluding same-owner rounded overflow.
Exact equality is evaluated over every RGBA byte within each equal-scale group.
The counts do not imply cross-renderer byte equality. In particular, Chrome's
existing rounded-inner-opacity 2× pair still differs by one channel unit at 11
pixels, while the native pair is now exact.

Only three existing case payloads change: `opacity-covered-blue` at 1× and
`rounded-opacity-covered-blue` at 1×/2×. The other 19 remain exactly unchanged.
Same-owner rounded-overflow pairs retain their noninvariance: native changes
228/456 pixels at 1×/2×, versus Chrome's 180/356. Plain alpha-one polygon, nested
polygon, inset and rounded controls also retain their recorded outcomes. These
failures are not silently removed or automatically called standards violations.

Both suites still match browser geometry and uniform interior pixels in all
**48/48 captures**. That independent comparator excludes raster edges, so it does
not establish full-image parity. The new fixture's browser capture is Chrome
153.0.8010.50; native capture is offscreen Metal on Apple M1 Pro, with one paint
per case and no recorded GPU errors.

The [independent audit](2026-09-18-opacity-output/independent-audit/audit.json)
also checks physical witnesses rather than relying on pair equality alone.
For all nine escape/signed/restored states in each original browser, baseline and
candidate run, quarter-opacity red remains visible beyond overflow Q but inside
polygon P; ordinary red remains clipped by Q; excluded regions and a rounded
corner stay white. All 26 later 4×4 CSS tiles retain their exact color and white
surround. At DPR 2 a tile contributes only 64 pixels and cannot satisfy the
greater-than-100 subject guard by itself. Signed/unsigned images match at each
scale. The audit verifies 144 current/prior PNGs and regenerates seven reports
byte for byte; it excludes the later repeat and broader regression suite.

A separate [fresh candidate repeat](2026-09-18-opacity-output/repeatability.json)
reproduces all 48 complete reports/case payloads and PNG files byte for byte with
the same binary. Metal API validation is recorded in those runs.

Primary receipts: [new browser groups](2026-09-18-opacity-output/browser-invariants.json),
[new baseline groups](2026-09-18-opacity-output/baseline-invariants.json),
[new candidate groups](2026-09-18-opacity-output/candidate/opacity-output/invariants.json),
[existing candidate groups](2026-09-18-opacity-output/candidate/clip-edges/invariants.json),
and [26-capture](2026-09-18-opacity-output/candidate/opacity-output/comparison.json)
/ [22-capture](2026-09-18-opacity-output/candidate/clip-edges/comparison.json)
geometry/interior comparisons. Existing Chrome groups remain in the
[prior archive](2026-09-18-clip-edges/browser-invariants.json).

## Regression, errors and lifecycle

The [full prior fixture regression](2026-09-18-opacity-output/regression/results.json)
reproduces all **142 ownership case payloads and 142 legacy case payloads exactly**.
That means unchanged results, including failures: ownership remains 136/142 for
geometry plus interior pixels and 142/142 for interior pixels; legacy remains
87/142 combined. This repair does not fix the six recorded geometry mismatches.

[Focused host tests](2026-09-18-opacity-output/checks/final/candidate-tests.txt)
pass **76/76**: 42 layout/ownership controls, five budget controls and 29 public
renderer controls. Nine new output-clip tests cover all paint phases, nested
escape, distinct clips with equal geometry, own-content clipping, visibility,
empty suffixes, restoration and budget recovery. Seven of those nine fail on the
[preserved pre-repair renderer](2026-09-18-opacity-output/checks/prior-output-tests-final.txt).
[Private library tests](2026-09-18-opacity-output/checks/final/library-tests.txt)
pass 18/18, including four prefix-helper controls. All 36 Node tests, formatting
and strict host Clippy pass; [commands and exits](2026-09-18-opacity-output/checks/final/results.json)
are retained. The existing upstream `Intrinsic` warning remains in test output.

The [broad candidate test run](2026-09-18-opacity-output/checks/candidate-broad-tests.txt)
is **not green**. It reproduces four known DOM geometry failures involving
display contents, hidden ancestors, inline fragments and retained detached
subtrees. Their prior reproduction is documented in the
[ownership renderer checkpoint](2026-09-18-ownership-renderer.md#errors-lifecycle-and-checks).

[Canvas lifecycle receipts](2026-09-18-opacity-output/lifecycle/results.json)
retain the default and candidate **legacy traversal** results: 21 captures and
27 passing browser contracts per profile, unchanged paint payloads, and cleanup
after an injected post-submit failure. The ordinary canvas runs remain `partial`
and exit 1 on their existing DOM paint gates; they are not newly green. They do
not exercise integrated canvas/text through the ownership renderer, whose text
path remains ineligible.

Default, candidate legacy and ownership budget controls reject attempted layer
1,025 under the default total limit, then match all three browser controls at an
explicit 2,048-layer limit. Additional [output-clip budget controls](2026-09-18-opacity-output/output-budget/results.json)
separately limit total layers and depth to one: the first clip is accepted, the
second effect layer is rejected, and cleanup completes. The failed frame is not
submitted for GPU rendering and produces no PNG or success report. These are
pre-submission paint failures, not a claim that device initialization does no GPU
work.

[Preparation checks](2026-09-18-opacity-output/preparation-checks/preparation-regression.json)
pass for default, candidate and upstream-baseline profiles, including repeated
fresh preparation, read-only identity, tamper, extra-file and symlink rejection,
and candidate removed-file resurrection. [Source CI for `5e067fc`](https://github.com/PANDORMedia/3JSN/actions/runs/35311739498)
passed macOS, Linux and Windows; that is separate from this checkpoint's Metal
evidence.

## Remaining boundary

This is an opacity-output repair, not general post-composite clipping. Alpha-one
grouping, same-owner overflow behavior, full-image cross-renderer edge fidelity,
text/inline content, wider effects, scrolling, transformed/hidden DOM queries,
clip-aware input and native presentation remain open. No benchmark, cross-platform
GPU support or unchanged-game executable is established. Candidate maintenance
and adoption remain separate decisions; [reproduction and eligibility](../../experiments/dom-canvas/OWNERSHIP.md)
keep this traversal explicitly experimental.
