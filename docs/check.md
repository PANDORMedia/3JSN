# Inspect an existing project

```sh
node packages/cli/cli.mjs check /path/to/game --targets macos-arm64,windows-x64,linux-x64
```

`3jsn check` reads an existing project without requiring `3jsn.json`, executing
project code, installing dependencies or starting a browser/native player. It emits
one JSON report on stdout. Targets default to the current supported host identifier;
multiple targets are comma-separated. Reports use the versioned
[desktop profile](profiles/README.md), including its revision and SHA-256 identity.

This first analyzer inventories source syntax. It discovers HTML entry candidates,
package/workspace declarations, build script names, Vite dependency/configuration
candidates, declared Three.js version ranges, module imports and resource references.
Babel parses JavaScript, TypeScript and JSX; parse5 and css-tree inspect HTML and
CSS. Inline JavaScript uses its original HTML line/column. Configuration and build
plugins are never evaluated, so a Vite candidate is not a resolved Vite build.

Findings include renderer/context calls, DOM, animation frames, workers, Wasm,
networking, storage, audio, voice and gamepad syntax. Each feature is looked up for
each requested target. Unlisted APIs are unknown. Comments and string contents
alone are not API evidence. Locations are one-based source coordinates, not
source-map-remapped locations.

## Reading the report

- `project` contains entry, package, import, resource and requirement candidates.
  Script **names**, not their command strings, are recorded. Three.js declarations
  are ranges, not proof of the installed/resolved version.
- `analysisCoverage` identifies measured/analyzed source files, skipped inputs,
  limits and unimplemented analysis. Findings can include unused code, shadowed
  names, server code and build tooling. They are not proven runtime requirements.
- `diagnostics` distinguish unavailable features, unresolved syntax/dependencies
  and unverified targets. They include source locations where available.
- `preservation` compares complete before/after content snapshots, including
  assets and empty directories. Root `.git` and `node_modules` are excluded and
  explicitly recorded. Contents of dependencies are not certified.
- `artifacts` is empty: inspection does not package or launch anything.

Analysis covers UTF-8 JS/TS/JSX, HTML, CSS and package manifests in the selected
tree. It accepts at most 4,096 source files, 2 MiB per file and 32 MiB of analyzed
text. Excess, undecodable and nested dependency source files are listed as skipped
and cause an incomplete-analysis diagnostic. All nonexcluded files are still
included in content preservation. Contained symlinks are preserved in the snapshot;
their targets are analyzed through their normal paths. External/dangling links
cannot establish a self-contained snapshot and inspection fails explicitly.

Static inventory does not resolve imports, aliases, installed dependencies,
lockfiles, build outputs, client/server boundaries or source maps. Computed access,
dynamic imports and generated behavior remain unresolved. There is no optional
runtime trace implementation yet. Absence of a finding never means an API is safe.
The current desktop profile has no completely verified target, so even a small
project receives compatibility exit **1**; this command does not grant a build
certificate or broaden the experimental packaging profiles.

| Exit | Meaning |
| --- | --- |
| 1 | Inventory completed with unsupported or unresolved compatibility |
| 2 | Invalid invocation, target or profile configuration |
| 3 | I/O/tool failure, including unverifiable source preservation |
| 4 | Source changed during inspection |
| 130 | Cancellation with source preservation verified |

Source changes take precedence over cancellation or analysis errors. Cancellation
waits for the current filesystem/parsing operation and then verifies preservation.
SIGTERM uses shell exit 143 with cancellation recorded in the JSON report; forced
termination cannot return a verification report. Quiesce writers: this is a content
snapshot comparison, not an atomic filesystem snapshot or hostile-process sandbox.

Reports omit source bodies and command strings and sanitize URL credentials,
queries and fragments. They still contain project-relative file names, dependency
names and resource paths. Treat reports from private projects as private metadata;
review any derivative before publishing it.

The [public inventory fixture](../fixtures/project-check/README.md) exercises this
boundary. The [build command](build.md) continues to require explicit experimental
profiles and supplied runtime binaries. Executing existing frontend builds remains
separate roadmap work.
