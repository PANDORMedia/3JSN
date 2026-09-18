# Experimental webfont packaging

`3jsn build --bundle-web-fonts` resolves static font dependencies during the build,
copies the complete font bytes into the application, and rewrites generated
HTML/CSS to local package references. Original application files stay unchanged.
The option extends the experimental macOS `dom-window-v1` profile; it is not a
claim that arbitrary web applications are supported.

```sh
node packages/cli/cli.mjs build fixtures/web-fonts \
  --runtime target/debug/threejs-dom-window-probe \
  --font .cache/dom-canvas/blitz/examples/wasm_hello/assets/DejaVuSans.woff2 \
  --out artifacts/type-lab --bundle-web-fonts --experimental
```

The output parent must exist. Build the player using the pinned
[DOM preparation steps](../experiments/dom-canvas/README.md); the CLI checks its
`dom-package-fonts-v1` capability before downloading fonts. The separate `--font`
input remains the generic fallback of this interim profile. CSS webfont families
register their own faces and do not replace every generic family with one font.

## Resource graph and reproducibility

The localizer follows ordinary stylesheet links, inline styles and CSS imports,
then `@font-face` source URLs. Relative URLs use the final stylesheet response URL
after redirects. It preserves rule order, descriptors, conditions and comments
in generated CSS. Native admission checks are separate from this generic rewrite:
preserving syntax does not prove the player implements it.

No remote CSS/font requests occur without `--bundle-web-fonts`. The first opted-in
build pins exact response bytes, requested/final URLs, redirects, content types
and a fixed modern request representation. The fixed Chrome 140 representation
with `3JSN-font-bundler/1` suffix avoids asking providers for legacy static-font
responses when a variable range was requested. It is independent of the machine
running the build. Original query parameters are preserved; no `text=` parameter
or initial-screen glyph subsetting is added.

State defaults to `<output-parent>/.3jsn-web-fonts/<project-identity>/`. Override
it with `--web-fonts-state <directory>`. State, project and package output must be
disjoint directory trees, including filesystem aliases. `lock.json` pins remote
representations and `blobs/<sha256>` stores immutable bytes. Every use verifies
the cached bytes. Existing pins never refresh silently: use a new state directory
for an intentional provider update. A single build leases a state directory;
after forced process termination, remove a stale `.lease` only after its owner
has stopped.

`--offline` requires the bundling flag and fails on a missing pin/blob instead of
contacting the server. A copied state directory supports a build on another
machine with the same inputs and request representation. Metadata includes the
used lock subset, provenance, source identities and native requirements. These
records do not replace the font blobs when moving offline build state.

## Current native boundary

| Input | Experimental treatment |
| --- | --- |
| Static, unconditional `@font-face` with one URL source | Package and load through a verified in-memory resource provider |
| TTF, OTF, WOFF and WOFF2 | Content-identified packaging and checked native decoding |
| Family, normal/italic style, weight and variable weight ranges | Preserve CSS descriptors and select registered faces |
| `unicode-range` and later-rule precedence | Restrict selection and shaping without editing original font bytes |
| Normal/100% stretch | Admitted; other stretches remain outside build admission |
| Runtime text/localization | Uses the packaged declared coverage; no initial-text subset |
| `local()`, multiple sources, `tech()`, unsupported descriptors or conditional faces | Fail with an explicit native-capability diagnostic |
| Runtime-created, removed or reordered font rules | Fail checked startup/frame validation; no silent stale face set |

Fonts are decoded and registered before application startup and initial layout.
This does not implement asynchronous `FontFaceSet` readiness or `font-display`
swap timing. Dynamic text and ordinary styling are distinct from dynamic font
rule creation. Discovering fonts constructed from arbitrary JavaScript URLs or
CSS strings remains future capability work.

The native resource base is `threejsn://package/app/index.html`. It is an internal
URL-resolution base, not a complete browser origin/security model. Exact listed
CSS/font URLs resolve only to bytes verified from the package; there is no native
network or filesystem fallback. This provider does not implement other asset
types or sandbox trusted application JavaScript.

## Integrity, bounds and errors

Manifests declare `requires: ["dom-package-fonts-v1"]` and resource records with
`path` and `kind` (`font` or `stylesheet`). Every resource also appears in the
ordinary hashed `files` list. Old players reject the new capability, and native
window packages reject DOM resource fields. The shared validator checks hashes,
roles, paths and sizes before window/realm creation, retaining the verified
resource bytes rather than reopening them later.

The build graph permits 64 resources, eight stylesheet levels and five redirects
per request. CSS is limited to 1 MiB, each stored font to 16 MiB, and aggregate
stored/generated resources to 64 MiB. Requests have a 15-second deadline and
honor cancellation. UTF-8 CSS, contained regular local files and credential-free
HTTP(S) are accepted; other resource schemes and non-font CSS URLs reject.

The native checked decoder separately caps reconstructed font output at 128 MiB
per face and retained decoded responses at 256 MiB per document. These are data
bounds, not a guarantee of peak process memory. Empty registration, malformed
fonts, undeclared resource requests and changed font-rule sets remain fatal.
Runtime package URLs can be mapped to original dependencies through build
provenance. Hashes detect damage; an unsigned manifest is not an authenticity
guarantee.

CSS notices and original downloaded bytes are retained. The builder does not
infer redistribution rights or discover every license automatically. Supply the
applicable notices with distributed fonts. The public
[fixture](../fixtures/web-fonts/README.md) includes explicit Roboto/Noto OFL
notices, copied by its validation harness.

## Dependency candidate and validation

The experiment uses separately prepared, hash-verified Fontique/Parley and Blitz
patches. Fontique's registration metadata carries authored ranges and CSS order;
Parley's shaping adapter applies the same Unicode eligibility without rewriting
font data or forking HarfRust. Blitz supplies checked loading/status and a cached
mutation boundary. A separate layout patch preserves fractional intrinsic text
widths before line wrapping. These remain experimental dependency candidates; their
upstream adoption and complete web-font conformance are not established.

The [matcher experiment](../experiments/web-font-matcher/README.md) contains
independent CPU regressions and original tiny font fixtures. The
[package probe](../scripts/probe-web-font-package.mjs) exercises a public provider,
offline rebuilds, relocation, native Metal presentation, corruption and
browser/native text widths. Focused matching/layout tests do not establish
universal shaping or rasterization parity, all browser font APIs, platform
certification, startup speed or memory improvement.

The [2026-09-18 checkpoint](validation/2026-09-18-web-fonts.md) records the
verified macOS Metal package and browser width comparison, including limitations
and the two independently checked broad Blitz test failures.
