# DPR 2 translation addendum

The existing browser and frozen-native PNGs retain the correctly scaled CSS
translation. This conclusion applies to the recorded fixture capture path. It
does not establish correct invalidation when an already resolved document
changes DPR without a style mutation.

The two proposed device-space rectangles have the same inclusive raster support
`[144, 112, 512, 352]`, so support bounds alone cannot distinguish them:

| Hypothesis | Device rectangle | Left coverage | Right coverage | Top coverage | Bottom coverage |
| --- | --- | --- | --- | --- | --- |
| Scaled translation | `(144.75, 112.5)–(512.75, 352.5)` | 0.25 | 0.75 | 0.5 | 0.5 |
| Unscaled translation | `(144.375, 112.25)–(512.375, 352.25)` | 0.625 | 0.375 | 0.75 | 0.25 |

Fresh decoding verified all 16 existing DPR 2 PNG identities against the prior
audit and capture reports. Across eight single-fill PNGs, 9,632 straight-edge
pixels were checked away from corners. Every strip is uniform, and browser and
native strips match exactly. Alpha-one edge RGBA values are left
`[247,199,203,255]`, right `[232,88,100,255]`, and top/bottom
`[239,143,151,255]`. The half-opacity equivalents are `[251,227,229,255]`,
`[243,171,177,255]`, and `[247,199,203,255]`.

Using the measured interior color and opaque white background, every sampled
channel is within one level of the scaled-translation prediction. The unscaled
hypothesis misses the green channel by at least 28 levels on every edge. These
samples reinforce the original audit's recorded fractional-coverage checks;
the inclusive bounds were never sufficient evidence on their own. Covered-blue
states are hash-verified but excluded from translation inference because their
repeated clipping is the separate composition behavior under investigation.

The preserved CPU receipt `artifacts/css-rect-boundary/dpr-transition-failure.txt`
still records `103.375 != 103.75` for the earlier cached DPR-transition setup.
This read-only audit neither reruns that test nor proves the invalidation cause.
The fixture replaces styles for each state, so its successful physical scaling
does not rule out that separate lifecycle defect. No claim is made about general
antialias parity, corner coverage, or CSSOM translation support.

`dpr2-addendum.json` records every file hash, strip bounds, RGBA value, coverage
estimate, residual, source identity, frozen binary identity, and failure-receipt
identity. `dpr2-addendum.mjs` reproduces this file-only check without a build or
capture. The original `audit.json` remains unchanged.
