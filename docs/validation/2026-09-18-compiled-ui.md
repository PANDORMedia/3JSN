# Compiled initial HTML construction

Date: 2026-09-18. On macOS 26.1 arm64, the experimental HTML compiler and Rust
loader now construct the same authoritative native DOM used by the interpreted
path. A Three.js fixture presented 120 Metal frames with reads of its original
HTML denied. This is an initial-tree construction proof toward
[#55](https://github.com/PANDORMedia/3JSN/issues/55), not parser omission or generic
web-project packaging.

## Construction and source preservation

Pinned parse5 8.0.1 emits flat, versioned JSON with namespace-qualified attributes,
inert template fragments, source ranges, recovery diagnostics and original-input
hashes. The loader validates schema, counts, ownership, references and supported
document modes before calling public Blitz mutation APIs. Existing JavaScript
bindings, layout and painting share that document; there is no second UI tree.
The [experiment contract](../../experiments/compiled-ui/README.md) records exact
bounds, BOM/UTF-16 provenance, CLI overwrite protection and unsupported modes.

All five [generic fixtures](../../fixtures/compiled-ui/README.md) produce identical
tested native observations through interpreted and compiled construction:
initial state, mutation results and a resized viewport. The loader unit suite
also compares tree structure, qualified attributes and template ownership,
exercises multiple device scales, and verifies through a counting provider that
initial construction avoids the HTML parser while `innerHTML` invokes it later.
The compiler has no game, framework or canvas-ID dependency. The existing window
host still has its separate experimental `#scene` fixture contract.

## Shared stylesheet correction

The first comparison exposed a native stylesheet-order bug. HTML foster parenting
can place style owners in an order different from their allocation IDs. The
interpreted cascade used those IDs; construction from the final compiled tree
happened to get the right order. In an independent
[Chrome control](2026-09-18-compiled-ui/cascade-browser.json), the witness cell's
border-box width is 42 CSS pixels; the old native path returned 79.5.

The pinned `blitz-stylesheet-order.patch` now caches connected owners in actual
DOM order for Stylo, CSSOM and checked web-font discovery. Mutation boundaries
and stylesheet installation reconcile registered owners' ancestor paths; there
is no per-frame tree scan. Reordering retains stylesheet objects, imports and
CSSOM edits. Detached/template styles stay inert, and queued work for removed
owners no longer installs styles or dereferences deleted nodes.

All nine focused regressions fail on the copied baseline and pass with the
candidate ([baseline](2026-09-18-compiled-ui/stylesheet-baseline.txt),
[candidate](2026-09-18-compiled-ui/stylesheet-candidate.txt)). The identical scratch
test source was used in both runs; the
[durable tests](../../experiments/compiled-ui/tests/stylesheet_order.rs) change
only two fixture/root paths. The final prepared source passes all nine again.
[Preparation](2026-09-18-compiled-ui/preparation.json) records exact patch/source
identities. Registry sources were not edited. Media/type/disabled behavior and
in-flight stylesheet URL replacement remain separate limitations.

## Browser and GPU evidence

The [CPU comparison](2026-09-18-compiled-ui/cpu-comparison.json) uses Chrome
153.0.8010.50, the same supplied font, strict non-geometry observations and a
0.25 CSS-pixel rectangle tolerance. It remains **partial** and exits nonzero:

| Fixture | Native construction observations | Remaining browser differences |
| --- | --- | --- |
| Dashboard | Identical | 0 |
| Recovered HTML | Identical | 3 inline bounding-width values |
| Namespaces | Identical | 38 SVG/MathML layout/query values |
| Templates | Identical | 3 inline bounding-width values; inert CSS leak repaired |
| Cascade recovery | Identical | 11 table-height/downstream-position values; stylesheet width repaired |

Counts are individual compared values across phases, not independent defects.
The [earlier report](2026-09-18-compiled-ui/before-cascade.json) retains the native
construction mismatch and template leak. Its cascade fixture lacked an explicit
font declaration; the final harness corrects that confound. The isolated width
witness and identical-source regression tests establish the ordering repair.
These observations do not certify browser-complete behavior.

The separate [window report](2026-09-18-compiled-ui/window.json) records 120
presentations for each construction path, shared native device/queue identity
checks and no CPU image transport between Three.js and UI composition. Both paths
produce identical tested DOM observations, including button dispatch, identity,
style changes and runtime markup. A sandbox denies networking, development-tree
reads and, for the compiled path, reads of the original HTML. A denied-read control
verifies that restriction. The fixture source remains unchanged.

The direct compiled invocation rejects unknown data versions and undeclared
external stylesheets. Its explicit fallback font and inline CSS are sufficient
for this fixture; resource packaging is not integrated into this entry point.
No image comparison, speedup, startup-time or footprint claim follows from the
presentation count. The first copied-player `--describe` attempt exceeded the
original 10-second harness deadline; the bounded allowance is now 60 seconds,
and the [failed attempt](2026-09-18-compiled-ui/window-startup-timeout.txt) is retained.

## Regression checks and remaining gates

[Checks](2026-09-18-compiled-ui/checks.json) record 135 passing Node tests and one
platform skip, 25 workspace Rust tests and two existing ignores, 18 compiled-UI
tests, 16 DOM-player tests, formatting, exact prepared-source verification and
scoped Clippy. Existing dependency warnings remain. This checkpoint does not
rerun or claim a fully green broad upstream Blitz suite; the earlier
[hover/scroll baseline failures](2026-09-18-web-fonts.md#validation-and-remaining-gates)
remain documented.

The [webfont regression](2026-09-18-compiled-ui/web-font-regression.json) again
registers 28 faces from 25 files, produces an identical offline rebuild, presents
120 Metal frames with networking denied, and passes all 22 browser/native width
comparisons and invalid-resource controls. Chrome failed to launch its renderer
in the [first attempt](2026-09-18-compiled-ui/font-browser-startup-failure.txt);
the unchanged probe passed on retry. The existing
[fallback-font package](2026-09-18-compiled-ui/dom-package-regression.json) also
passes relocation, native presentation and failure-control regressions.

The data format remains experimental. CSS and dynamic HTML parsers are linked;
DocumentType nodes are explicitly omitted and non-no-quirks modes rejected.
Subdocument/resource providers may still parse HTML during attachment. Automatic
script discovery, compiled resource packaging, framework workloads, pixel parity,
parser-omitted link graphs and size/startup/memory measurements remain open.
No Windows/Linux native support is inferred from this Mac checkpoint. Reproduce
with the commands in the [experiment README](../../experiments/compiled-ui/README.md#reproduce).
