# Experimental desktop compatibility contract

[experimental-desktop-v1.json](experimental-desktop-v1.json) is a machine-readable
declaration for analysis and future runtime gates. It is **not a supported runtime
release**. `schemaVersion` versions the data format; `id` versions the compatibility
contract; `revision` changes when evidence or implementation status changes without
redefining the contract. Profile files are immutable inputs to an individual build:
record their SHA-256 identity in its output manifest.

The target is unchanged JS/TS, upstream Three.js version, renderer, shaders, HTML
and CSS. Configuration can choose entry/build commands, assets, service endpoints,
application identity and permissions. Generated output may be adapted while
preserving behavior and source maps. Application rewrites and a mandatory renderer
migration are forbidden. Game and voice servers remain separately configured
services unless an explicit distribution mode packages and supervises them.

## Status and evidence

| Feature status | Meaning | Required-feature diagnostic |
| --- | --- | --- |
| `supported` | Implemented and covered by dated integration evidence for the selected target and declared version constraints | Informational; still evaluate project-specific constraints |
| `unsupported` | Known unavailable or outside the declared implementation | Error identifying the feature, target and current gap |
| `unknown` | Insufficient evidence or unresolved dynamic behavior | Error requiring investigation; never silently treat it as supported |

An API absent from the profile is `unknown`, not supported. A source analyzer's
failure to discover an API is also insufficient evidence. Report its analysis
coverage and unresolved dynamic imports, property access and generated code.
Optional features may be informational only when the application explicitly
declares and tests a compatible unused/fallback path; static guesses cannot waive
required features. Never suggest rewriting the game as a supported solution.

Evidence kinds are `probe`, `browser-reference`, and `native-integration`. A probe
establishes only what it executes. A browser baseline establishes expected
behavior, not native compatibility. `supported` requires `native-integration`
evidence naming the target, runtime/dependency versions, constraints and a dated
report. A `verified` target needs a complete target-specific acceptance report;
compilation, another platform's result or an upstream support list is insufficient.
The initial profile certifies no feature and no target.

## Proposed CLI behavior

This specifies future `3jsn check/run/build`; those commands do not exist yet.
Desktop target IDs are `macos-arm64`, `macos-x64`, `windows-x64` and `linux-x64`.
Targets are requests, not support claims. Linux reports X11/Wayland independently.
Platform minimum versions, drivers and packaging constraints remain unverified.
Other identifiers fail configuration validation until added to a profile.

`check` reports entry points, build boundaries and every discovered requirement.
`run` and `build` must first pass the same compatibility checks. Neither silently
launches a browser, switches renderers or falls back to software. Build outputs
are per target: one invocation can dispatch workers, but it cannot declare a
target successful before its artifact and manifest exist. A failed target makes
the overall invocation fail and is individually represented in structured output.

| Exit | Meaning |
| --- | --- |
| `0` | Requested operation completed; `check` found no unsupported or unresolved required features within its explicitly stated analysis coverage |
| `1` | Compatibility refusal: unsupported feature, unknown required feature or unavailable target/runtime |
| `2` | Invalid invocation, malformed configuration/profile or invalid preservation manifest |
| `3` | Toolchain, I/O, worker or runtime infrastructure failure |
| `4` | Original source/assets changed during the operation |
| `5` | Launched application failed; preserve its original exit/signal in the report |
| `130` | User cancellation after child cancellation, cleanup and source verification |

Exit `0` from analysis does not certify arbitrary dynamic execution. Preservation
failure takes precedence over cancellation or another failure; record all causes.
If preservation cannot be verified (for example I/O failure), report exit `3` and
`preservation: "unknown"`, never `true`. Reports can contain sensitive local paths;
publishing them requires a sanitized derivative.

The future JSON report envelope has `schemaVersion: 1`, `operation`, `profile`
(`id`, `revision`, `sha256`), `targets`, `analysisCoverage`, `diagnostics`,
`preservation`, `artifacts` and `exitCode`. Each diagnostic has `code`, `severity`,
`feature`, `status`, `message`, `target`, and optional original-source `location`
(`path`, one-based `line` and `column`). Stable diagnostic codes describe a class
of failure; human wording may evolve. Unknown locations are omitted, not invented.
Run/build source-map failures must not rewrite diagnostics into misleading original
locations. Do not expose credentials or private endpoint query strings in logs.

## Preserving source and assets

The foundation tool is executable now, independent of the future CLI:

```sh
node scripts/compatibility/snapshot-cli.mjs capture /path/to/game /tmp/game-before.json --exclude node_modules --exclude dist
# Run the project's build with generated outputs restricted to declared exclusions.
node scripts/compatibility/snapshot-cli.mjs verify /path/to/game /tmp/game-before.json
node --test scripts/compatibility/*.test.mjs
```

Capture includes all files, empty directories and contained symbolic links by
default, except root `.git` metadata. Exclusions are exact root-relative paths,
recorded in the manifest; excluding root `dist` does not exclude `assets/dist`.
The caller must review every exclusion against the project's source and asset
graph. Do not omit a licensed/private input from the **private** manifest merely
because it cannot be redistributed. Protect the manifest as private metadata.

Manifests contain no file contents or timestamps. They record sorted paths,
SHA-256 hashes, byte sizes and link targets. Their own SHA-256 digest binds the
scope and entries; this detects accidental alteration, not malicious replacement
of both data and digest. It is not an authenticity signature. Capture refuses to
overwrite a manifest and uses private file permissions where the OS supports them.
Keep it outside the measured tree, including through directory aliases.

Contained symlinks are recorded without traversing aliases; their resolved target
must also be captured through its normal path. External, dangling, resolution-loop
and excluded-target links fail capture. Symbolic roots and special files fail
capture. Snapshot additional external inputs separately until a multi-root input
graph is implemented. Preserve existing link behavior; do not rewrite game inputs
just to fit the tool. File ownership, permissions and timestamps are outside this
content-preservation contract. Executable modes need separate packaging checks.

Quiesce writers before capture/verify. Files are streamed and checked for ordinary
concurrent modifications; directory membership changes are detected while walking.
This is not an atomic filesystem snapshot or a security boundary against a process
actively racing filesystem changes. For acceptance, use an immutable private
checkout/archive, record a clean or dirty provenance marker, and verify it after
success, build failure and cancellation. Identical hashes alone do not establish
equivalent rendered behavior.
