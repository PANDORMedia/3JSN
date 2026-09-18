# Public Three/HTML demo — offscreen Metal evidence

The unchanged `examples/webgl-window` HTML and JavaScript now run through the
compiled UI loader, real DOM, upstream Three WebGLRenderer, ANGLE and GPU HTML
painter for 60 deterministic frames. Both preserved and omitted dynamic-parser
builds pass. Their final 960 × 640 PNG files are byte-identical.

![Final GPU composition](2026-09-18-webgl-demo/preserved-demo.png)

This image was rendered offscreen on Metal, not captured from a presented window.
The desktop remains locked; native surface presentation and OS input are still
unverified for this fixture. No browser reference or exact CSS fidelity claim is
made. The renderer's previously recorded ancestor-clipping limitation remains.

## Exercised behavior

The test embeds the production RAF scheduler with deterministic timestamps and
microtask checkpoints. It loads the ordinary application bundle without changing
its source, renders every frame through the existing compositor, and checks:

- Five application checkpoints at frames 1, 12, 24, 36 and 60.
- Stable 904 × 400 CSS canvas size while bitmap size changes to 1130 × 500.
- Same-width reset preserving the application context while retiring its export.
- Actual node/context replacement at frame 36, with distinct native identities.
- Exactly four snapshot generations at frames 1, 12, 24 and 36.
- Application shader/GL-error assertions, DOM connection and context identities.
- Pagehide disposal cancelling scheduled animation, followed by GPU/host cleanup.

The final PNG was visually inspected: title, lifecycle HUD, geometry, translucent
panes and overlapping HTML card are present and readable. The image does not prove
browser pixel equivalence, antialiasing quality, performance or window presentation.
Readback occurs only for the final evidence capture, never as canvas transport.

## Evidence and reproduction

[Preserved report](2026-09-18-webgl-demo/preserved-report.json) and
[output](2026-09-18-webgl-demo/preserved-stdout.txt);
[restricted report](2026-09-18-webgl-demo/restricted-report.json) and
[output](2026-09-18-webgl-demo/restricted-stdout.txt).
The reports retain executable, font, generated input and unchanged application
hashes. [Test source identities](2026-09-18-webgl-demo/source-identities.json)
include the production scheduler. Metal API Validation was enabled in both runs.

Use the [fixture runner instructions](../../examples/webgl-window/README.md#offscreen-integration-check).
The runner refuses existing output directories, requires exactly one passing test
and a matching lifecycle receipt, verifies source preservation, and archives
failures as well as successes. ANGLE and the font remain external inputs.

Both test builds pass. Restricted-target strict Clippy passes; the only warnings
come from the previously recorded upstream Parley/Blitz dependencies. JavaScript
syntax, Rust formatting and source checks are separate from GPU evidence.
