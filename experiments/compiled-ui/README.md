# Compiled initial HTML tree experiment

This is an executable construction proof for [ADR 0003](../../docs/adr/0003-compiled-ui-and-generic-compatibility.md).
Pinned parse5 8.0.1 converts static HTML into experimental JSON. The Rust loader
validates that data and uses public Blitz mutation APIs to create the same
authoritative live document used by the existing JavaScript bindings, style,
layout and native canvas experiments. It does not create a second DOM.

The compiler has no canvas-ID, framework or game-specific requirement. The
window fixture uses its own `#scene` canvas through the existing experimental
window host; that fixture contract does not define the compiler grammar.

This is not a shipping format, package profile or unchanged-project certification.
CSS is still parsed and evaluated by Blitz. The default `dynamic-html` feature
retains dynamic HTML parsing; the fixture deliberately exercises `innerHTML`.
The original [checkpoint](../../docs/validation/2026-09-18-compiled-ui.md)
records native construction parity and Metal presentation, including the shared
stylesheet-order repair. SVG/MathML, inline-layout and table-size compatibility
remain incomplete. The commands below produce evidence rather than promise a
passing browser comparison.

For restricted hosts, `load_json_restricted` / `load_restricted` reject a supplied
parser provider and preflight all iframe hooks before creating the document.
`--no-default-features` makes `blitz-html` optional and applies the same preflight
when ordinary loading has no supplied provider. Ordinary loading preserves an
explicit caller provider and reports it as unverified. The host must also guard
live markup operations: the underlying native document's absent provider alone
does not guarantee an explicit error or preserve children during replacement.
The separate [optional-parser runtime](../compiled-ui-runtime/README.md) supplies
that host policy and the artifact-comparison tools. Neither a feature flag nor
this loader's report alone proves parser omission or performance improvement.

## Data and ownership

The top-level object has these required fields:

| Field | Meaning |
| --- | --- |
| `format`, `version` | `"3jsn-static-ui-experiment"`, `1` |
| `source` | `{name, sha256, byteLength}` for the original UTF-8 source |
| `document` | `{mode, scriptingEnabled:false}` |
| `nodes` | Flat preorder array; index zero is the document |
| `diagnostics` | First at most 1,000 parse5 recovery diagnostics |
| `diagnosticsTotal`, `diagnosticsTruncated` | Total error count and whether entries were omitted |

Every node has `kind` and `source`. Additional fields are:

| Kind | Fields |
| --- | --- |
| `document`, `fragment` | `children`: ordered node indices |
| `element` | `name`, `namespace`, `prefix`, ordered `attributes`, `children`; HTML templates also have `templateContents` |
| `text`, `comment` | `value` |
| `doctype` | `name`, `publicId`, `systemId` |

Attributes are `{name, namespace, prefix, value}`. Namespace/prefix absence is
`null`; an empty prefix remains distinct in the data. Element prefixes are
`null` for this HTML parser. Names, namespace identities, normalized attribute
values and order come from parse5, including duplicate-attribute recovery.

Every child/reference points forward in preorder. Nodes have exactly one owner;
unreachable nodes, cycles, duplicate ownership and arbitrary native IDs are
invalid. An HTML template has empty ordinary children and owns one `fragment`
through `templateContents`; nested templates retain their separate inert content.
The loader obtains that fragment through Blitz's template-content API. Native
node IDs are created at load time and never serialized as a package ABI.

`source` is a parse5 location object or `null`, retaining attribute, start-tag
and end-tag ranges when available. Offsets are zero-based UTF-16 indices with
exclusive ends; lines and columns are one-based. Implied nodes and some attributes
merged onto implied elements lack ranges. A leading BOM is skipped for parsing,
but all ranges and first-line columns are shifted back to the original input.
The SHA-256 and byte count include that original UTF-8 BOM. Hashes identify input;
the loader does not reread the source to authenticate provenance metadata.

## Bounds and unsupported behavior

| Bound | Maximum |
| --- | --- |
| Original UTF-8 HTML | 1 MiB |
| Serialized JSON | 16 MiB |
| Nodes, including document and template fragments | 10,000 |
| Total attributes | 10,000 |
| Tree depth, document at zero | 128 |
| Individual UTF-8 string | 64 KiB |
| Retained recovery diagnostics | 1,000; additional errors only increment the total |

`compileHtml(html, {sourceName, limits})` is a pure compiler API. Limits can only
be lowered. Malformed HTML is recovered according to parse5; errors remain
diagnostics. Invalid inputs, exceeded artifact bounds and unsupported node kinds
produce errors with stable `code` fields. Unpaired UTF-16 surrogates are rejected.
The CLI accepts UTF-8 regular files, reads at most the input cap plus one byte,
and creates output exclusively so an existing file or source alias is not overwritten.

Parsing occurs after the input bound but before tree/attribute/string checks.
Tree and attribute checks precede location copying; output size is checked after
serialization. These bounds are not independent parser peak-memory or wall-time
guarantees. This probe does not sandbox untrusted parsing or compilation work.

The compiler preserves all document modes. The current native loader rejects
anything except `no-quirks`, because the pinned native document cannot preserve
the other modes. It preserves doctype data in JSON but reports omitted native
DocumentType nodes; the pinned interpreted sink also drops them. This is an
observable browser gap. The loader validates schema, references, counts and
capabilities before constructing nodes.

Construction bypasses initial-document HTML parsing, not every possible HTML
parser invocation. Resource/subdocument providers can still parse during
attachment or resource delivery, and subsequent JS markup mutations use the
configured parser provider. Static script elements are retained as tree data;
these probes execute the explicitly supplied behavior/module, not arbitrary
HTML script discovery. External resource loading and browser-complete script
execution are outside this construction proof.

## Reproduce

From the repository root, use Node 24+, Rust and the existing
[DOM canvas preparation](../dom-canvas/README.md). Preparation verifies pinned
local dependency copies; it does not adopt these components as a shipping stack.

```sh
npm ci
export CARGO_HOME="$PWD/.cache/cargo"
export CARGO_TARGET_DIR="$PWD/target"
cargo fetch --locked --manifest-path experiments/native-html-interop/Cargo.toml
node experiments/dom-canvas/prepare.mjs
node --test experiments/compiled-ui/compiler.test.mjs
cargo test --locked --manifest-path experiments/compiled-ui/Cargo.toml
cargo build --locked --manifest-path experiments/dom-canvas/Cargo.toml \
  --bin threejs-compiled-ui-probe --bin threejs-dom-window-probe
mkdir -p artifacts
UI_RUN=$(mktemp -d "$PWD/artifacts/compiled-ui.XXXXXX")
UI_FONT="$PWD/.cache/dom-canvas/blitz/examples/wasm_hello/assets/DejaVuSans.woff2"
node experiments/compiled-ui/compiler.mjs \
  fixtures/compiled-ui/dashboard.html "$UI_RUN/dashboard.ui.json"
```

The font is an explicit upstream input, not redistributed here; see the
[font preparation and license notes](../html-paint/README.md).
For CPU DOM/layout comparisons against interpreted Blitz and Chrome:

```sh
node scripts/probe-compiled-ui.mjs \
  target/debug/threejs-compiled-ui-probe "$UI_FONT" "$UI_RUN/cpu" \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

The harness compares initial, mutated and resized observations across the
[five generic fixtures](../../fixtures/compiled-ui/README.md). It records recovery
diagnostics, input hashes, native equivalence and browser differences. Browser
rectangle tolerance is 0.25 CSS pixels. A partial result writes its report and
exits nonzero; it must not be summarized as browser parity.

For the separate macOS arm64 Metal/window checkpoint, with a window server and GPU:

```sh
node scripts/probe-compiled-ui-window.mjs \
  target/debug/threejs-dom-window-probe "$UI_FONT" "$UI_RUN/window"
```

The harness bundles the same fixture scene, copies inputs into a directory with
spaces and Unicode, and runs interpreted and compiled paths for 120 frames each.
The direct compiled-window path accepts inline CSS and the explicit fallback
font. Its strict empty package-resource provider and webfont startup checks
reject undeclared linked stylesheets/fonts instead of silently discarding them.
External resource packaging remains an integration gate, not a restriction of
the tree-data schema.
The compiled run denies source-HTML reads, development-tree reads and networking;
it also checks unsupported-version and undeclared-resource failures. DOM observations and successful
presentation do not establish pixel equivalence. Each harness requires a new
output directory. Neither command creates a production application package.
