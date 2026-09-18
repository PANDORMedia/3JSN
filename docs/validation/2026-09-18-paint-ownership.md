# Paint ownership diagnostics and shared clip geometry

Status: **unadopted research candidate**. This checkpoint adds an inspectable
ownership plan and removes duplicate geometry boundaries without replacing the
renderer. The existing clipping, input and transformed-geometry gates remain open.
The default prepared Blitz source is unchanged.

## What changed

The ninth candidate patch exposes `PaintOwnershipPlan` after layout. Each box
contribution has a formatting rank, geometry owner, enclosing real stacking
context, paint owner, phase and CSS-pixel coordinate prefix. Relative/absolute
auto groups differ from real zero/fixed/sticky/effect contexts. The plan borrows
the resolved document and never writes its legacy paint lists. Callers must also
avoid direct writes through public interior layout cells while retaining it.

The eighth patch moves the existing `CssBox` and corner-radius implementation
from paint into DOM. Paint imports the shared implementation; no parallel radius
algorithm is introduced. Padding/content predicates close open subpaths and
preserve nonzero winding holes. They provide geometry for future clip-aware
input; they do not decide which ancestor clips apply.

The CPU diagnostic reuses the existing V8 DOM bindings and runs real fixture
mutations before collecting a plan. Its shared host also preserves the separate
DOM geometry probe. Unsupported ownership returns a node and issue code; it
does not invent a fallback attachment.

## Evidence

The [new public fixture](../../fixtures/paint-ownership/README.md) has 18 captures:
auto versus zero, fixed/sticky contexts, reordered peers, opacity and clip-path
groups, containing-block escape through a carrier, CSS rect clipping, rounded
overflow at two scales and restoration. It contains no private game assets.

The [Chrome/native comparison](2026-09-18-paint-ownership/candidate-comparison.json)
is **10/18**, unchanged from the seven-patch baseline. All 18 geometries match.
This deliberately records the renderer's unresolved failures while the separate
[plan](2026-09-18-paint-ownership/plan.json) collects all 18 cases. An
[independent entry audit](2026-09-18-paint-ownership/plan-audit.json) checks unique
rooted attachments, expected owners/prefixes, source order and restoration.
Equal ownership for opacity and clip-path does not imply equal clip policy.

| Browser comparison | Seven-patch baseline | This checkpoint |
| --- | ---: | ---: |
| Paint ownership/effects | 10/18 | 10/18 |
| Auto paint | 5/17 | 5/17 |
| Paint order | 19/20 | 19/20 |
| Initial containing block | 19/21 | 19/21 |
| Positioned layout | 13/14 | 13/14 |
| Overflow | 5/22 | 5/22 |

The [render regression](2026-09-18-paint-ownership/render-regression.json)
verifies all 112 native case records, including pixel hashes and geometry,
are unchanged. These are unchanged partial results, not 112 compatibility passes.
It also preserves the complete canvas paint report and initialization, 21 canvas
captures, 27 browser canvas contracts, zero unexpected GPU validation errors,
and cleanup after the injected failure following two submitted frames.
All native painting used Apple M1 Pro Metal offscreen with API validation enabled.

The split-effect reference is particularly important. With overflow ancestor A,
static opacity group B and viewport-fixed subject C, Chrome shows all 8,192
blended subject pixels while clipping B's own background at A. Making C relative
leaves 1,024 pixels. The expanded clip-path counterpart shows 1,024 pixels for
both fixed and relative C despite unchanged reported geometry. That difference
is recorded, but its cause remains unresolved; it does not establish a changed
containing block or behavior in other browsers.

The visibility guard now accepts an explicit expected composited RGBA color.
Default opaque-red matching remains exact; declared colors allow two channel
levels of rounding. Both hosts must use identical metadata, and the reference
must expose more than 100 subject pixels. Full-image and geometry thresholds
are unchanged. [Invalid-color controls](2026-09-18-paint-ownership/color-rejection-controls.json)
fail before native GPU setup; [integer-valued decimal/exponent spellings](2026-09-18-paint-ownership/color-numeric-control.json)
normalize to the same pixels and geometry.

## Checks and source identity

- [42 targeted Rust tests](2026-09-18-paint-ownership/checks/tests.txt): previous
  28 controls, five shared-geometry tests and nine ownership tests.
- [21 Node tests](2026-09-18-paint-ownership/checks/node-tests.txt), including
  invisible-subject, malformed-color and mismatched-metadata rejection.
- [Strict candidate Clippy](2026-09-18-paint-ownership/checks/clippy.txt) and
  formatting pass. The pre-existing upstream `Intrinsic` warning remains visible.
- [Default DOM geometry regression](2026-09-18-paint-ownership/geometry-regression.json):
  all 23 checks and the complete report remain identical after sharing the host.
- [Structured diagnostic failure](2026-09-18-paint-ownership/diagnostic-error-control.json):
  a float case saves its node/issue and exits 1 without requesting a GPU.
- [Preparation integrity](2026-09-18-paint-ownership/preparation-regression.json):
  two fresh preparations and read-only verification agree; 413 retained tracked
  files, six added modules and three removed files are checked. Added-file
  tampering, resurrection of a removed file and symlinks are rejected.

The [baseline identity](2026-09-18-paint-ownership/baseline-identity.json) records
the preserved seven-patch executable from `60339e4`, with optional capture color
metadata added. The [candidate identity](2026-09-18-paint-ownership/candidate-identity.json)
records all nine patches, generated dependency manifests, current probe sources
and executable hashes. The archive includes 54 PNGs for the new fixture's browser,
baseline and candidate, plus comparison and regression records. Existing matrix
references remain in the preceding checkpoint rather than duplicating their PNGs.

## Remaining contract

The plan rejects floats, scrolling, unsupported computed context triggers,
3D/singular transforms and positioned/effected non-atomic inline fragments.
It cannot reject properties the parser discards: pinned Stylo registers
`transform-box` only for Gecko, leaving alternate reference boxes unsupported
and unobservable through this computed-style interface.

The public fixture performs no geometry reads. The diagnostic's
`explicitResolveCalls` counts its own resolves; arbitrary supplied fixture code
could trigger additional resolves through DOM geometry bindings. Collection
success does not establish rendering, input or general CSS support.

Clip eligibility through effect groups, reverse hit traversal, transformed
culling bounds, scrolling and observable layer-budget failure still precede
renderer adoption. The earlier candidate's lost one-frame overflow match remains
documented in the [transform-context checkpoint](2026-09-18-transform-context.md).
No performance, native-window, Windows/Linux GPU or unchanged-game packaging
claim follows from this work. Issues #54, #52, #24 and #25 remain open.

See the [ownership design](../investigations/paint-ownership.md) and
[reproduction commands](../../experiments/dom-canvas/POSITIONED.md).
