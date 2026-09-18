# Positioned overflow fixture

This redistributable fixture uses identical HTML and JavaScript in Chrome and the
isolated native DOM painter. The ordered 22 captures test ordinary colored boxes;
there are no fonts, game assets or GPU canvases. Existing DOM canvas probes test
canvas integration separately.

Each case changes styles or parentage, then paints. Native capture reads stored
layout after exactly one `Painter.paint` call; it does not invoke the JS geometry
getter, which would trigger another resolve and conceal stale paint coordinates.
Chrome waits two animation frames before reading geometry and capturing pixels.
The fixture contains no geometry reads or scrolling setters before native paint.

The matrix covers visible and hidden overflow, both z-index signs, nested clips,
rounded padding edges, relative positioning, transforms, moves/resizes, hidden
elements, reparenting, stacking-context demotion and device scales 1 and 2.
Absolute and fixed positioning cases deliberately exercise containing-block gaps.
Case order is part of the input identity; this is not an exhaustive CSS suite.

The comparison requires identical source hashes, dimensions and case order. It
reports geometry differences and all pixel differences. Its parity criterion
excludes nonuniform browser 3x3 neighborhoods to separate rasterized edges from
uniform interiors; it allows two channel levels and 0.1 CSS pixel in geometry.
That criterion does not certify identical antialiasing or broad compatibility.
Every non-hidden reference must contain visible subject pixels; an occluded box
cannot establish clipping parity. The negative-z case uses a transparent body
background so that its subject remains observable.

See the [run instructions](../../experiments/dom-canvas/OVERFLOW.md) and
[recorded results](../../docs/validation/2026-09-18-overflow.md).
