# Experimental packaged stylesheets

The `dom-package-stylesheets-v1` capability lets the experimental `dom-window-v1`
player load integrity-checked stylesheet resources from a native package. The
Vite adapter uses it for CSS emitted by one static HTML entry and its static
JavaScript graph. The package retains linked CSS bytes; the live DOM runtime
still parses and applies the CSS, and the native renderer paints the resulting
UI.

The current adapter admits at most 64 linked stylesheets, each no larger than
1 MiB, with 64 MiB total. It rewrites generated links to package-relative paths,
records stylesheet paths and hashes in `app.json`, and fails if an emitted
stylesheet is missing, changes during packaging, or is not linked by the HTML
entry. `url()`, `@import` and `@font-face` rules are rejected because their
target resources are not yet captured by this capability. The package validator accepts only
stylesheet resources when this capability is required. The separate
`dom-package-fonts-v1` capability continues to support its existing font and
stylesheet contract.

This is resource delivery support, not broad CSS compatibility. Media queries,
layout, font semantics, DOM mutation, CSSOM and GPU paint behavior remain subject
to the capabilities and evidence of the current native DOM runtime. Vite config
and plugins still run as trusted project code during build. See the
[Vite build contract](build.md#package-a-vite-html-entry) and the dated
[native integration report](validation/2026-09-26-vite-native-package.md).
