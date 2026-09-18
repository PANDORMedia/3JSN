# Bounded native input coalescing — 2026-09-18

A shared bounded queue now combines adjacent compatible mouse-motion records
before delivery to the native JavaScript worker. CPU delivery controls and native
regressions pass on macOS arm64/Metal. This addresses a specific source of queue
pressure, not all input flooding or browser input semantics.

The earlier React diagnostic recorded input-queue overflow without raw event
types. It does **not** establish that motion caused that particular overflow.

## Queue behavior and CPU evidence

The standalone player admits 1,024 queued records; the DOM window admits 128.
Only adjacent mouse moves combine, retaining the latest position. The standalone
player additionally requires matching button/modifier snapshots. Key, button,
wheel, focus and leave/reset events form ordering barriers. Non-coalescible full
queues still fail explicitly; no discrete transition is silently discarded and
the window thread does not wait for capacity. This preserves the latest motion
sample, not the complete pointer trajectory.

The queue owns neither V8 nor window state. The host supplies its combination
rule. Consumer wakeup and record destruction occur outside the queue lock;
disconnection and shutdown remain explicit. See the
[input ownership contract](../native-input.md#ownership-and-delivery).

The [receipt and archived CPU logs](2026-09-18-input-coalescing/receipt.json)
record separate validation scopes:

- **12 final queue tests**: eight integration controls plus four added unit
  controls. A 100,000-motion burst tests bounded coalescing; ordering, capacity,
  disconnection and wakeup behavior have focused controls.
- The player queue policy has a **20,000-motion burst** control.
- The DOM input-delivery target passes **15 tests**: 12 shared native DOM checks
  and three new input controls. The V8 delivery control reduces 60,000 motions
  to 23 queued records and 26 observed callbacks, checking microtasks after each
  record. Separate controls cover V8 dispatch errors and discrete queue overflow.
  The callback count includes generated DOM observations and is not a one-to-one
  count of queued records. This CPU test supplies a known target, bypassing native
  hit testing.
- The final workspace run passed **46 tests with two existing ignores**, including
  all 12 queue tests. The earlier 42-test log predates the four additional controls.
- Final workspace/DOM/compiled-runtime formatting, workspace all-target Clippy,
  DOM input-test Clippy and both compiled-runtime binary Clippy checks passed.

These bursts are deterministic CPU controls, not physical input-rate or
performance measurements. Deliberate overflow has not been injected into a live
GPU window.

## Native regressions and identities

The [React report](2026-09-18-input-coalescing/react/report.json) passes both
relocated parser-mode packages: React verification and 120 Metal presentations
per mode, with network and development-file reads denied and source preserved.
It checks shared device/queue identity and reports no CPU image transport.
Tested React observations still match Chrome. Four `knownDifferences` records
represent the same pre-existing HTMLCollection ID/name-collision discrepancy in
each mode's CPU/window run; complete DOM parity remains false.

The [completion report](2026-09-18-input-coalescing/completion/report.json) passes
12 positive runs: limits 1, 4 and 120, twice in each mode. Four deliberately
failing JavaScript/WebGPU controls still exit with an error rather than a success
receipt. These regressions preserve the prior worker-owned frame-completion
contract; they do not establish all cancellation or lifecycle behavior.

| Debug executable | SHA-256 |
| --- | --- |
| Parser preserved | `674b11cec242a4e4b395fc5b1980a4d8b5663584c917026bd0dd91ff51a886e0` |
| Parser restricted | `dcf860c7c093d756cdccfc3076df258cfbe976bbf15e49c85e5e6d7e4ef0b3d6` |
| Standalone player | `7b71ad94c4b514a3faab635853be6a6d4b50634b69c665cc9c592c996dd0d022` |

The first two identities match the React reports and completion inputs. These
are new debug artifacts; earlier release linkage, size and timing results do not
transfer to them.

## Manual observations and limits

The [manual summary](2026-09-18-input-coalescing/manual/summary.json) distinguishes
visual observations from process logs. Dragging, wheel zoom, pause and reset were
observed on one Mac. Earlier captures reused log paths, so those observations
cannot all be attributed to one preserved process log. A separate shutdown log
records 513 frames and focus/blur events only; it does not prove those other
controls occurred during that process.

An additional append-only capture was still live when its snapshot was taken.
That snapshot has no final completion claim. Keeping the application available
for the user's ongoing interaction is separate from the completed automated
regressions above.

The evidence is not raw-trajectory preservation, a measured speedup, cross-platform
hardware certification or full input support. Focus/forms/IME, pointer capture,
accessibility, transformed/clipped hit testing, resize/input ordering and arbitrary
forced cancellation remain open. Discrete-event overload can still exhaust the
128/1,024-record bounds and terminate with an explicit diagnostic.
