# Paint layer budget controls

This original fixture exposes silent loss of required paint effects when a scene
exceeds its layer budget. It uses only colored boxes in a 448×256 CSS viewport:
small **blue** cells, each with opacity 0.5, followed by a separate red 128×64
subject inside a 0.5-opacity group at `(220,120)`. Blue cells cannot satisfy the
red subject's color check.

`clipFixture.prepare(name)` removes the previous cells, creates the requested
number and moves the existing subject group after them. The root, outer, middle
and subject identities remain stable. The fixture performs no geometry reads
and needs no fonts, images, network assets or private inputs.

| Ordered control | Cells | Intended check |
| --- | ---: | --- |
| `small`, scale 1 | 8 | Ordinary painting below the default budget. |
| `wide`, scale 1 | 1,100 | Many sibling opacity groups exceed the cumulative layer budget without requiring deep nesting. |
| `small`, scale 2 | 8 | Cleanup and reconstruction after the wide state, at twice the physical resolution with unchanged CSS geometry. |

Every subject should composite over white to approximately
`[240,144,152,255]`; the case metadata supplies that color with the shared
reference tolerance. A fully opaque `[224,32,48,255]` subject is an effect-loss
failure, even when its rectangle is correct and the GPU reports no error.

## Checked-paint acceptance

The checked entry point returns `Result<PaintStats, PaintError>` and
accepts explicit `PaintLimits`. Default inclusive limits are 1,024 accepted
layers in total and 1,024 simultaneously open layers. They are independent:
the wide case is a cumulative-count control, not a depth stress test. Layer
statistics count actual accepted scene commands, not simply DOM elements.

With default limits, both small states should paint successfully. The wide state
must report a layer-budget error instead of returning a partially correct scene.
The caller must discard that fresh deferred scene **before rasterization or GPU
submission**. Recorded commands are not rolled back; an immediate drawing sink
cannot provide the same transaction guarantee. A runner that stops on the wide
error must exercise the final small state separately to check recovery.

[raised-limits.json](raised-limits.json) raises only the cumulative limit to
2,048 and leaves the depth limit at 1,024. With those limits, all three states
should complete with the required opacity intact. Validate returned statistics,
error attribution and actual pixels; accepting more commands is not itself a
rendering pass. Scene fragments, custom widgets and nested documents must use the
same checked command path. Arbitrary widget resource work and DOM traversal cost
are outside this layer-budget transaction.

## Observed baseline and evidence boundary

Before the checked-budget change, the native Metal baseline using the final
blue-cell input hashes returned a capture for all three states. The small
subjects were blended `[239,143,151,255]`; the wide subject was opaque
`[224,32,48,255]`. Its geometry still matched the reference, and its capture
reported no GPU errors. The comparison found 7,812 differing interior pixels in
the wide state; both small controls matched. This demonstrates silent opacity
loss in the old painter, not a device failure.

The intended new result is explicit rejection under the default budget and
correct pixels under raised limits. These files alone do not establish that
result. The [verified checkpoint](../../docs/validation/2026-09-18-paint-budget.md)
records default-limit rejection and 3/3 raised-limit matches in both prepared
renderers on Metal. Browser reference capture, CPU error/lifecycle tests and native hardware
validation are separate evidence. No general browser compatibility, CPU-only
renderer, performance benefit or platform support is claimed by this fixture.
