# Third-party source notices

The repository's [MIT license](LICENSE) covers original 3JSN code. The upstream
source portions identified below retain their original licenses and notices.
These notices cover copied, embedded and patched source; they are not an inventory
of every transitive dependency in a built application.

## Blitz

The `blitz-*.patch` files in [experiments/dom-canvas/patches](experiments/dom-canvas/patches/README.md)
include or modify source from [DioxusLabs/Blitz](https://github.com/DioxusLabs/blitz),
pinned at `9d92719b37c801b8b41c81b799a2a474db8b3936`; the isolated positioned-layout
candidate uses `c032f63418097bb82c26077a85c24896c0a96e9d`.
This includes the CSS box and corner geometry moved from
`packages/blitz-paint/src/kurbo_css/` to `packages/blitz-dom/src/geometry/` by
`blitz-shared-clip-geometry.patch`.

Blitz declares **MIT OR Apache-2.0**. Copies of its
[MIT license](LICENSES/Blitz-MIT.txt) and [Apache license](LICENSES/Blitz-Apache-2.0.txt)
are preserved verbatim from the pinned source. The two pinned source trees have
identical license files. The upstream MIT text contains no copyright attribution
line; none has been invented here. Existing source-level notices remain applicable.
The patch files identify 3JSN modifications and retain the upstream source paths.

## Deno

Copyright 2018-2026 the Deno authors. **MIT license**; see the preserved
[license text](LICENSES/Deno-MIT.txt).

`crates/js-sources` embeds JavaScript from `deno_web 0.290.0`,
`deno_webidl 0.259.0` and `deno_webgpu 0.226.0`, retaining source headers.
The runtime also uses `deno_core 0.412.0`. The three embedded extension packages identify
[Deno revision `0c071246a412575e07423263404a5d13e7ed6aa2`](https://github.com/denoland/deno/tree/0c071246a412575e07423263404a5d13e7ed6aa2).
`experiments/dom-canvas/patches/deno-webgpu-canvas.patch` modifies Deno's
`ext/webgpu/canvas.rs`. Any checked-source replacements
of `ext/web/02_event.js` in the embedding crate remain derived from that MIT source.
The license text is copied verbatim from the published `deno_webgpu 0.226.0` package's
`LICENSE.md`; its attribution agrees with the embedded source headers.

## Fontique and Parley

`fontique-web-fonts.patch` modifies **Fontique 0.11.1**, copyright 2024 the
Parley Authors. `parley-web-fonts.patch` modifies **Parley 0.11.1**, copyright 2020
the Parley Authors. Both published packages identify
[Parley revision `eea3503dd6cf17130cbb07348e0ff2c918300e94`](https://github.com/linebender/parley/tree/eea3503dd6cf17130cbb07348e0ff2c918300e94)
and declare **Apache-2.0 OR MIT**.

Their original [Fontique MIT](LICENSES/Fontique-MIT.txt),
[Parley MIT](LICENSES/Parley-MIT.txt) and [Apache](LICENSES/Parley-Apache-2.0.txt)
texts are preserved verbatim. Both packages contain the same Apache license text.
The differing MIT copyright years are retained separately.

## Preserving these notices

Keep this file and the referenced license texts with distributions of the listed
source or patch files. The preparation scripts preserve upstream license files
in generated dependency trees; adding a local patch does not replace those licenses
with 3JSN's license. A binary distribution needs notices for its actual dependency
set, beyond this source-copy inventory.
