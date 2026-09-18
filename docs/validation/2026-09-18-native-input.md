# Interactive native input checkpoint

The Rust player now delivers keyboard, mouse, wheel and focus events to its
JavaScript window fixture. The Three.js scene can orbit, zoom, pause and reset
using a shared JavaScript controller. The [input contract](../native-input.md)
records its bounded queue, ownership, event semantics and remaining limits.

## Native observation

On this Apple M1 Pro Mac, the scene visibly responded to arrows and mouse
dragging. R reset the camera; scrolling moved it to the maximum zoom-out distance,
which was then visibly observed. Space toggled pause. The window was enlarged
with macOS's zoom action and continued rendering. Closing produced the player's
success record after **7,424 presented Metal frames**, with Metal API Validation
enabled and no GPU validation errors logged. This is not a frame-rate measurement.

The [manual receipt](2026-09-18-native-input/manual-capture/summary.json) records
the trace and observations. Its 64-event trace contains trusted keydown/up, mouse
down/up/leave and focus/blur events at DPR 2. Separate controller records include
all arrows, dragging, Space, R and wheel. Wheel arrived after the raw-event cap;
its camera result is recorded, while raw wheel correctness has a Rust/V8 test.
A controlled click reported client coordinates (480,288), excluding the title bar.

Screenshots were inspected through computer use; no screenshot files are
archived. Querying the app after closure returned a connection-invalid tool
error; the runtime's final success record establishes its worker/surface shutdown
completion. A local unsigned demo bundle remains available. It is not output
from `3jsn build`.

## Checks

Workspace Rust tests pass: four player tests, seven runtime unit tests and the
execution suite. That suite runs JS input assertions inside V8 alongside existing
module, animation, error and cancellation fixtures. One explicit GPU-only test
and a documentation example remain ignored in this CPU command.

A real Rust wheel record passes through serialization and the installed JS event
dispatcher. Other tests cover key identity, modifier sides, mouse chords, wheel
units, stale-DPR rejection, queue order/overflow, readonly fields, trust and
redispatch. Handled listener errors retain later listeners; microtasks run between
records. All 49 Node tests pass, including 13 new controller controls for camera,
pause without frames, drag cleanup, zoom and disposal. Strict workspace Clippy,
formatting and source checks pass.

[Logs and identities](2026-09-18-native-input/receipt.json) distinguish the capture
binary, source inputs and commands. The preceding
[source CI](https://github.com/PANDORMedia/3JSN/actions/runs/35316909155) passed on
macOS, Linux and Windows; this is separate from hardware input certification.

## Remaining gates

Production DOM targets, hit testing, focus traversal, forms, IME, UIEvent classes,
pointer capture, click synthesis, controllers and other platforms remain open.
Input and resize use separate channels; stale/missing cursor samples fail
explicitly. Physical monitor/DPR transitions and live queue-overflow shutdown
have not been exercised. Surface/alpha/device-loss and unchanged-CtF gates remain
open. No performance or complete browser compatibility is claimed.

The separately diagnosed Blitz live-DPR cache repair remains a scratch candidate;
it has not been compiled, integrated or certified in this checkpoint.
