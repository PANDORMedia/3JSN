# Restricted compiled UI: HTML-parser omission

The macOS arm64 release experiment can omit `blitz-html`, `html5ever` and
`xml5ever` while loading compiled UI into the existing live DOM. Selected
dependency graphs, actual compiler invocations, link-map objects and retained
executable symbols agree. The parser-enabled build supplies positive controls.
This is an experimental artifact proof, not a shipping build profile or generic
application certification.

CPU behavior, browser comparison and measurements passed. **Native-window
validation for this change remains pending:** the Mac was locked and the rebuilt
shared-host regression reached its 90-second deadline without a presentation
result. Computer-use inspection confirmed the locked desktop. The previous
[compiled-tree checkpoint](2026-09-18-compiled-ui.md) contains earlier Metal
evidence; it does not validate this new executable or shared-host extraction.

## Implementation boundary

- The loader's default `dynamic-html` feature preserves the maintained parser.
  Restricted APIs reject injected providers and iframe hooks before constructing
  the document, including inert templates and the pinned implementation's
  namespace-blind iframe hook.
- Shared DOM operations receive an explicit optional fragment-parser callback.
  `innerHTML` rejects before detaching children when absent; iframe creation
  rejects before allocation. Ordinary live-tree mutations retain their existing
  implementation and node identity.
- The new runtime reuses the existing V8 realm, canvas bridge, Metal transport,
  painter and window lifecycle. The interpreted adapters continue to install
  the parser. There is no second DOM or renderer implementation.
- Restricted JavaScript stubs give explicit diagnostics for additional markup
  and navigation entry points. They are not implementations of DOMParser, Range
  or browser navigation, and this capability policy is not a security sandbox.

CSS and selector parsing, style evaluation, CPU layout, text shaping, V8 and the
live DOM remain. `markup5ever` name/types also remain. Both compared executables
load the same compiled initial tree; this is not a comparison against interpreted
HTML startup. Application dependency reachability and parsers implemented by
application JavaScript are outside the proof.

## Artifact evidence

Both variants used Rust 1.93.0, the same lockfile and source, release optimization,
the explicit `aarch64-apple-darwin` target, incremental compilation disabled and
separate fresh target directories. Link maps were emitted and ordinary symbol
tables retained. The disabled build's first attempt stopped at a blocked V8
download; it resumed with the matching cached V8 release archive. Both variants
use that same archive hash. All attempt logs are included in the proof's input
identities. See [build provenance](2026-09-18-parser-omission/build-provenance.json)
and the [linkage report](2026-09-18-parser-omission/linkage.json).

| Evidence | Parser enabled | Parser disabled |
| --- | ---: | ---: |
| Selected normal/build closure contains the three parser crates | Yes | No |
| Actual parser crate compiler invocations | All three | None |
| `blitz_html` link-map objects / defined symbols | 16 / 5 | 0 / 0 |
| `html5ever` link-map objects / defined symbols | 7 / 110 | 0 / 0 |
| `xml5ever` link-map objects / defined symbols | 9 / 50 | 0 / 0 |
| Executable bytes | 92,432,032 | 91,298,144 |

The restricted artifact is 1,133,888 bytes smaller: **1.08 MiB, or 1.23%**.
These are whole executable variants, including feature-specific diagnostics;
this is not an isolated attribution of every byte to parser machine code.
The lockfile still lists optional packages. Its contents, the feature flag and
symbol absence alone would not establish the result above.

The proof ties each map's output to the executable hash and records raw tool
output identities. Large maps, compiler logs and symbol inventories remain under
the local ignored artifact/cache directories; the checked-in report preserves
their hashes, counts, commands and representative parser records. Apple link
maps contained non-UTF-8 symbol bytes; the collector preserves them losslessly
and records that decoding policy.

## Behavior and compatibility

The [CPU/browser report](2026-09-18-parser-omission/cpu-browser.json) records:

- Exact initial and positive mutation parity between both native variants.
  Click handlers, text/class/style changes, creation, removal, reattachment and
  retained node identity are exercised.
- Parser-enabled `innerHTML` succeeds and retained detached wrappers remain
  valid. The restricted variant rejects all 17 tested markup/navigation
  operations with unchanged snapshots and retained child identity.
- HTML and foreign-namespace iframe IR fail explicitly before startup.
- Original HTML and development-source reads are denied in the native subprocesses.
  Their sandbox policy also configures network denial, but no attempted-connection
  control measured it. The historical `networkDenied` receipt field described
  configuration, not observed network failure; new runs state that distinction.
  Executables and inputs are copied into a directory
  with spaces and Unicode; source/input hashes remain unchanged.
- Chrome 153.0.8010.50 matches this fixture's sampled initial and mutated
  behavior, with zero rectangle differences above 0.25 CSS pixels and exact
  text/interaction observations. Both paths use the same supplied font bytes.

This is one plain-DOM fixture. It does not resolve the earlier SVG/MathML,
inline-layout and table-sizing gaps, test frameworks, certify arbitrary DOM
behavior or establish GPU pixel equivalence. The CPU run explicitly reports
`nativeWindowValidated: false`.

## Measurements

The [complete 46-run record](2026-09-18-parser-omission/measurements.json) contains
three warmups per variant, followed by 20 sequential pairs in alternating order.
All initial snapshots match. Measurements ran after the builds and browser
comparison finished, without other checks from this task running concurrently.
They use the same binary and fixture as the behavior checks, with verification
disabled and no GPU-device request.

| Metric, median of 20 observations | Parser enabled | Parser disabled |
| --- | ---: | ---: |
| Main entry through initialization and first layout | 18.158 ms | 18.212 ms |
| Parent-observed process launch through termination | 27.865 ms | 27.811 ms |
| Whole-child peak resident memory | 39.203 MiB | 38.648 MiB |

The median paired differences, disabled minus enabled, are +0.011 ms for
initialization, -0.025 ms for process lifetime and -0.445 MiB for peak RSS.
Full ranges and sample standard deviations are in the report. Startup shows no
meaningful improvement in this small local sample. Peak RSS is a Darwin `wait4`
lifetime maximum, not steady-state heap or private footprint. These warm-cache
CPU results do not measure cold start, window startup, GPU memory, frame time,
large-game behavior or a general speedup.

## Validation and remaining gates

[Local checks](2026-09-18-parser-omission/checks.json) passed: 135 Node tests
(one skip), 19 shared DOM/player tests, six measurement/linkage collector tests,
Rust formatting and scoped strict Clippy for both runtime features. The
[loader policy checks](2026-09-18-parser-omission/loader-policy.json) pass 25
default-feature tests and seven restricted-feature tests. The other affected
HTML/V8, HTML paint and native interop hosts compile. Independent source review
found no unguarded pinned parser entry or extraction regression.

Reproduction commands and exact diagnostic behavior are in the
[runtime README](../../experiments/compiled-ui-runtime/README.md) and
[fixture README](../../fixtures/parser-omission/README.md). The paired native
window harness is ready but requires an unlocked desktop. Its existing
interpreted/compiled regression must also pass after the extraction.

Next gates are native presentation for these exact artifacts, compiled resource
and webfont packaging, build-CLI capability selection, conservative analysis of
dynamic dependencies, constant-fragment semantics, independent framework and
string-markup workloads, and broader platform/graphics evidence. The existing
HTML-entry package profile remains interpreted. No production package format
or unsupported existing application is silently switched to the restricted path.

## Daily-review test wiring

A dedicated `dom_mutations` integration target now compiles the actual shared
native mutation module despite the player binary's `test = false`. Its three
mutation/creation tests pass with default features and `--no-default-features`.
[Logs and identities](2026-09-18-parser-omission/review-corrections/source-identities.json)
record the CPU-only checks. Both Python evidence collectors' three-test suites
pass locally and are now explicit jobs within the existing source CI matrix.
This wiring adds no CI claim about native GPU or window execution.

The new CI wiring exposed a platform mismatch: the measurement collector's
process lifecycle and RSS-byte contract is explicitly Darwin-only. `run_child`
now rejects other platforms before opening output files or launching a process.
The two Darwin process controls remain active on macOS; other platforms test the
early rejection. Record validation still runs everywhere. The local measurement
suite passes three tests with one non-Darwin control skipped; modeled Windows and
Linux rejection controls verify that no process launches or files are opened.
Actual Windows execution is left to the new CI run, not inferred from those models.
