# Read-only existing-project inspection — 2026-09-18

`3jsn check` now accepts an existing project without `3jsn.json` and emits a
versioned JSON inventory with candidate entry pages, package/workspace metadata,
build-system clues, Three.js declarations, source-located API findings and explicit
compatibility gaps. It reads source without evaluating project code or configuration.
See the [command contract](../check.md).

JavaScript/TypeScript/JSX parsing uses pinned Babel parser 7.29.9. Existing parse5
and css-tree dependencies handle HTML and CSS, including inline scripts/styles.
Findings are syntactic candidates: aliases may be shadowed, code may be unused,
and server/build-tool code is not separated from client code. Installed versions,
import resolution, build plugins and runtime tracing are not inferred.

The desktop profile revision advances to 2 to correct stale descriptions of the
experimental DOM/WebGPU work. Feature statuses remain unsupported for that complete
unchanged-project profile; no target is newly certified. Inspection always records
the exact profile hash and unresolved dynamic behavior.

## Executed checks

- **36 analyzer tests pass:** 19 JavaScript syntax/reference controls, seven
  manifest/HTML/CSS discovery controls and ten orchestration/CLI controls.
- **181 full Node-suite tests pass, one existing skip.** This includes the existing
  packaging regressions. No Rust runtime implementation changed and no new GPU
  or platform-hardware result is claimed.
- Two actual CLI invocations on the public fixture produce **byte-identical JSON**,
  exit 1 for unresolved compatibility, and verify unchanged source. The deliberate
  failure build script is not executed. The [receipt](2026-09-18-project-check/receipt.json)
  records commands and report identity; the [public report](2026-09-18-project-check/public-first.json)
  records findings and coverage.
- A local read-only CaptureTheFrog invocation also returns exit 1 with source
  preservation verified. It analyzes 691 files and lists 440 skipped files under
  the declared budget. This is incomplete inventory evidence, not a successful
  native build or application certification. Its private report is not published.

Review found and fixed backslash-authority credential leakage, ignored cancellation
during final verification, invalid-UTF-8 inputs bypassing analysis counters, and
silently omitted inline CSS. Regression controls cover each case. Source mutation
takes precedence over cancellation; unverifiable preservation never reports true.
Raw source, build command values and URL credentials/query/fragment payloads are
absent from public reports. File/dependency/resource paths can still be private.

The archive retains [source identities](2026-09-18-project-check/source-identities.json),
the [Node test output](2026-09-18-project-check/node-tests.txt), and two public reports.
Source/configuration/document validation is recorded alongside them after the
archive is assembled. Reports contain no native runtime artifacts.

## Remaining gates

Complete dependency/version and frontend-build resolution, configurable analysis
scope, client/server boundaries, optional runtime traces and actionable handling
of arbitrary dynamic behavior remain open in #36/#37. The parser inventory must
not be treated as admission for the experimental native packaging profiles.
The next rendering integration remains actual WebGL in the selected V8 host;
the isolated ANGLE/native texture-sharing proof does not supply that binding.

## Daily-review corrections

The subsequent [PR review](https://github.com/PANDORMedia/3JSN/pull/63#pullrequestreview-5249906784)
identified pathological member chains, uninterruptible parsing, excessive finding
arrays and nested dependency snapshot scope. These were not covered by the earlier
passing tests. The corrected analyzer uses constant-depth API recognition,
terminable parser workers, explicit traversal/finding caps and an all-depth
`node_modules` exclusion recorded in snapshot identity. The default snapshot API
retains its original exact-path behavior for existing build callers.

The real CLI now handles the reviewer's 20 KB member chain in 431 ms and the
650 KB computed-access input in 682 ms on this Mac. Both return exit 1 with source
preservation verified; the latter explicitly reports incomplete analysis. A pnpm
workspace-link control completes in 350 ms. These are reproduction timings, not
performance guarantees. [Results](2026-09-18-project-check/review/cli-reproductions.json).

58 focused tests pass, including parser deadlines, real CLI SIGINT, typed snapshot
scope, deep/wide HTML, colon script names, omitted metadata, BOM handling and
unsupported component formats. The full Node suite passes 194 tests with one
existing skip; 771 source/config/document checks passed before this receipt was
added. Test logs and [source identities](2026-09-18-project-check/review/source-identities.json)
are archived beside the reproduction results. Windows CLI signal semantics remain
outside the macOS SIGINT result; worker AbortController tests run independently.

No application build, native graphics support or platform certification is added.

The first correction passed macOS/Linux CI but exposed a Windows junction-path
mismatch in the new scope regression. Windows namespace prefixes now use Node's
`toNamespacedPath` consistently for containment comparisons; raw link spellings
remain in snapshot identity. Twelve local snapshot tests pass, retaining exact
excluded/external rejection assertions and adding a contained absolute-link
control. Windows execution still requires the next CI run; this local result
alone is not Windows validation.

The next Windows run still rejected the nested-dependency junction with
`EXTERNAL_LINK` instead of `EXCLUDED_LINK`. A root-ancestor alias reproduces that
failure locally on baseline `324e288`: the supplied root spelling and its
`realpath` spelling differ. Windows temporary-directory short names are the
inferred cause of the runner mismatch; that specific spelling awaits live CI.
Lexical checks now accept either supplied or canonical root spelling, while the
final physical containment and exclusion checks remain mandatory. Raw link text
and strict excluded/external assertions are preserved. The added regression
fails on the baseline and passes with this correction; all 13 snapshot tests
pass. The full Node suite passes 197 tests with one skip, and 785 source/config/
document checks pass. The full suite required localhost access; the initial
sandboxed attempt failed to bind its fixture servers. These local checks do not
replace Windows execution evidence.
