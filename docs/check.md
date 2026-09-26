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
  are ranges, not proof of the installed/resolved version. `dependencyResolutions`
  records Three.js versions found in npm `package-lock.json` or
  `npm-shrinkwrap.json`, with their lockfile and package path; these are locked
  candidates, not evidence that the package is installed or used at runtime.
  Exact versions longer than 128 characters are omitted to keep malformed
  lockfiles from inflating the report.
- `analysisCoverage` identifies measured/analyzed source files, skipped inputs,
  inspected npm lockfiles, limits and unimplemented analysis. Findings can include unused code, shadowed
  names, server code and build tooling. They are not proven runtime requirements.
- `diagnostics` distinguish unavailable features, unresolved syntax/dependencies
  and unverified targets. They include source locations where available.
- `preservation` compares complete before/after content snapshots, including
  assets and empty directories. Root `.git` and `node_modules` at every depth are excluded and
  explicitly recorded, including pnpm links inside those dependency trees. Contents of dependencies are not certified.
- `artifacts` is empty: inspection does not package or launch anything.

Analysis covers UTF-8 JS/TS/JSX, HTML, CSS, package manifests and npm lockfiles in the selected
tree. It accepts at most 4,096 inputs, 2 MiB per file and 32 MiB of analyzed
text. Excess and undecodable source files, plus unsupported `.vue`/`.svelte`
inputs, are listed as skipped and cause an incomplete-analysis diagnostic.
Dependency trees are excluded from both analysis and preservation, not walked or
hashed. Discovery emits at most 10,000 findings; each JavaScript input emits at
most 5,000 and project aggregation caps retained findings at 10,000. HTML traversal
is iterative, with depth 256 and 20,000 visited/queued nodes. Reaching a cap emits
`ANALYSIS_INCOMPLETE`; missing findings cannot establish compatibility.

Default parsers run in a terminable worker with a 10-second wall-clock deadline
per discovery operation or JavaScript input. A deadline emits `ANALYSIS_TIMEOUT`
and `ANALYSIS_INCOMPLETE`, still verifies preservation, and returns exit 1 if that
verification succeeds. These limits do not bound the complete filesystem snapshot:
all nonexcluded assets must be hashed to support the preservation claim. All nonexcluded files are still
included in content preservation. Contained symlinks are preserved in the snapshot;
their targets are analyzed through their normal paths. External/dangling links and source links into excluded dependencies
cannot establish a self-contained snapshot and inspection fails explicitly.

Static inventory does not resolve imports, aliases, installed dependencies,
non-npm lockfiles, build outputs, client/server boundaries or source maps. For npm
lockfiles, only exact Three.js package versions and lockfile package paths are
reported. Safe relative npm link targets are followed within the same lockfile;
unsafe or missing targets are omitted with an uncertainty. Integrity values,
resolved URLs and other package metadata are not retained. Computed access,
dynamic imports and generated behavior remain unresolved. There is no optional
runtime trace implementation yet. Absence of a finding never means an API is safe.
The current desktop profile has no completely verified target, so even a small
project receives compatibility exit **1**; this command does not grant a build
certificate or broaden the experimental packaging profiles.

| Exit | Meaning |
| --- | --- |
| 1 | Unsupported/unresolved compatibility, including explicitly incomplete bounded analysis |
| 2 | Invalid invocation, target or profile configuration |
| 3 | I/O/tool failure, including unverifiable source preservation |
| 4 | Source changed during inspection |
| 130 | Cancellation with source preservation verified |

Source changes take precedence over cancellation or analysis errors. Cancellation
terminates active parser work, waits for any current filesystem operation, and then
verifies preservation.
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
