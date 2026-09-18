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
