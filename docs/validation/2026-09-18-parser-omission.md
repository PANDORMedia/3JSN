# Restricted compiled UI: HTML-parser omission

The macOS arm64 release experiment can omit `blitz-html`, `html5ever` and
`xml5ever` while loading compiled UI into the existing live DOM. Selected
dependency graphs, actual compiler invocations, link-map objects and retained
executable symbols agree. The parser-enabled build supplies positive controls.
This is an experimental artifact proof, not a shipping build profile or generic
application certification.

CPU behavior, browser comparison, measurements and **native presentation now
pass for the exact parser-omission release artifacts**. After the Mac was
unlocked, both preserved executables presented 120 Metal frames. The preserved
interpreted shared-host player also presented 120 frames under its original
sandbox policy. The [unlocked follow-up](#unlocked-native-follow-up) records their
identities and limits; it does not validate the separate, uncommitted package work.

The earlier blocked attempt remains part of the record: the Mac was locked and
the shared-host regression reached its 90-second deadline without a presentation
result. Computer-use inspection confirmed the locked desktop. Its
[original check record](2026-09-18-parser-omission/checks.json) and
[stderr](2026-09-18-parser-omission/locked-shared-host-interpreted-stderr.txt)
are preserved. The previous [compiled-tree checkpoint](2026-09-18-compiled-ui.md)
is separate evidence for the earlier implementation.

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
- Original HTML reads, development-source reads and networking are denied in
  the native subprocesses. Executables and inputs are copied into a directory
  with spaces and Unicode; source/input hashes remain unchanged.
- Chrome 153.0.8010.50 matches this fixture's sampled initial and mutated
  behavior, with zero rectangle differences above 0.25 CSS pixels and exact
  text/interaction observations. Both paths use the same supplied font bytes.

This is one plain-DOM fixture. It does not resolve the earlier SVG/MathML,
inline-layout and table-sizing gaps, test frameworks, certify arbitrary DOM
behavior or establish GPU pixel equivalence. The CPU run explicitly reports
`nativeWindowValidated: false`.

## Unlocked native follow-up

The [native report](2026-09-18-parser-omission/unlocked-native.json) records the
2026-09-18 rerun of the existing PR58 release executables. They were not rebuilt.
Their SHA-256 identities match the executables in the earlier linkage proof:

| Artifact | SHA-256 |
| --- | --- |
| Parser enabled, 92,432,032 bytes | `51d4f3f6c95836b0daa27124c15cc5629d6843e8f33a8adc4980b240c0cd6beb` |
| Parser disabled, 91,298,144 bytes | `66667b849beee784bb1ec2de5487d8dda94724e5aee4b192df46d6ae9a654e9f` |
| Preserved interpreted shared-host player, 188,851,368 bytes | `112668bfce04f54c53b16c6d5f3ef475403f616d9c4b6d516ac81cb245c1612d` |

The release executables came from
`.cache/parser-omission/{enabled,disabled}-target/aarch64-apple-darwin/release/threejs-compiled-ui-runtime`.
The harness copied them and the fixture inputs to
`artifacts/parser-omission-release-native-01/Native parser é #/`, then ran each
window for 120 successful presentations with Metal API validation enabled.
Both reported 120 canvas snapshots, verified native device and queue identity,
and `cpuImageTransport: false`. The
[enabled](2026-09-18-parser-omission/unlocked-native-enabled-window-stdout.txt) and
[disabled](2026-09-18-parser-omission/unlocked-native-disabled-window-stdout.txt)
window observations match before and after the fixture's click and live-tree
mutations. Their stderr logs contain only the Metal validation-enabled message.

The same run repeated the positive CPU behavior, all 17 restricted-operation
rejections, tree-preservation checks and both iframe rejection controls. Chrome
153.0.8010.50 again produced zero sampled DOM/layout differences above the
0.25 CSS-pixel rectangle tolerance. The
[runtime sandbox policy](2026-09-18-parser-omission/unlocked-native-restricted-inputs.sb)
denied original HTML and development-tree reads plus networking. Input and source
hashes remained unchanged. The report indexes the preserved stdout/stderr logs,
policy and their hashes; the browser comparison remains a CPU DOM/layout check.

The [shared-host follow-up](2026-09-18-parser-omission/unlocked-native-shared-host-interpreted.json)
ran the exact existing
`artifacts/compiled-ui-shared-host-regression/Native UI é #/player` with its
adjacent HTML, module and font under the
[original interpreted policy](2026-09-18-parser-omission/unlocked-native-shared-host-interpreted.sb).
It presented 120 Metal frames with 120 canvas snapshots and the same device,
queue and transport checks. Its
[observations](2026-09-18-parser-omission/unlocked-native-shared-host-interpreted-stdout.txt)
include a click, creation through DOM operations, retained target identity and
successful dynamic `innerHTML`. The player, inputs and policy hashes were
unchanged. This follow-up reran the interpreted invocation; it did not rerun the
separate compiled invocation of that preserved shared-host player.

These are presentation and sampled behavior results for the original PR58
artifacts. They establish neither GPU pixel equivalence nor a speedup, framework
support or another platform. New compiled-package binaries and resource/build
integration have a [separate checkpoint](2026-09-18-compiled-package.md) and artifact identities.
The earlier CPU timings and linkage/build-provenance records are unchanged.

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

The [PR58 source CI run](https://github.com/PANDORMedia/3JSN/actions/runs/35342025736)
completed successfully on Windows, macOS and Ubuntu. The
[preserved CI summary](2026-09-18-parser-omission/unlocked-native-source-ci.json)
records all three successful jobs and the identity of the observed CI response.
This is source-check evidence, not native graphics validation on those platforms.

Reproduction commands and exact diagnostic behavior are in the
[runtime README](../../experiments/compiled-ui-runtime/README.md) and
[fixture README](../../fixtures/parser-omission/README.md). The paired
parser-enabled/parser-disabled window harness and preserved interpreted
shared-host invocation now pass with an unlocked desktop. A complete rerun of
the preserved shared-host interpreted/compiled pair remains a separate check.

Next gates for this checkpoint are compiled resource and webfont packaging,
build-CLI capability selection, conservative analysis of dynamic dependencies,
constant-fragment semantics, independent framework and string-markup workloads,
and broader platform/graphics evidence. The existing HTML-entry package profile
in the tested PR58 artifacts remains interpreted. No production package format
or unsupported existing application is silently switched to the restricted path.
