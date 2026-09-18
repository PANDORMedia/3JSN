# Packaged webfont fixture

An independent Three.js application for checking native font loading. It uses
ordinary HTML/CSS, a shared measurement module and a small WebGPU scene. It has
no acceptance-game code or assets.

`provider.css` is the complete Google Fonts response fetched on 2026-09-18 for:

```text
https://fonts.googleapis.com/css2?family=Roboto:wght@100..900&family=Noto+Serif:ital,wght@0,400;1,400&display=swap
```

The fixed representation is Chrome 140 on Linux with the `3JSN-font-bundler/1`
suffix, as recorded by the build lock. The CSS retains all 25 font subsets, rather
than selecting glyphs from the initial text. `fonts.css` imports that stylesheet
and adds three aliases to test authored Unicode restrictions and later-rule
selection, reusing unchanged original font bytes.

The original Roboto and Noto Serif OFL notices are in `notices/`, obtained from
the corresponding directories of [google/fonts](https://github.com/google/fonts).
The integration probe copies these explicit notices beside the packaged assets;
the general builder preserves CSS notices but does not discover font licenses
automatically. Source URLs and hashes in the build lock identify downloaded
representations. No font binaries are checked into this fixture.

Run the [webfont package probe](../../scripts/probe-web-font-package.mjs) with the
prepared DOM player, a fallback WOFF2, a new evidence directory and a Chrome
executable. It performs online and network-denied offline builds, relocates the
package, removes its disposable source, then runs 120 native Metal frames with
networking and development-source/cache reads denied. Browser/native comparisons
cover widths before and after runtime localization, variable weights, family and
italic selection, Unicode eligibility and CSS face ordering. They do not certify
all font APIs or exact rasterization equivalence.
