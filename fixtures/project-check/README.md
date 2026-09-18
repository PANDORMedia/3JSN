# Existing-project inventory fixture

This redistributable project supplies ordinary TypeScript, HTML, CSS, a worker and
an npm workspace declaration for `3jsn check`. It has no `3jsn.json` and is not a
native-runtime acceptance fixture. Dependencies and resources are declarations;
they are not installed, built, fetched or executed by the check command.

```sh
node packages/cli/cli.mjs check fixtures/project-check --targets macos-arm64,linux-x64,windows-x64
```

Expected: JSON inventory with source locations, explicit unknown/unsupported
compatibility, unchanged source, and exit 1. The build script intentionally fails
if someone tries to execute it. Static analysis must not run it.
