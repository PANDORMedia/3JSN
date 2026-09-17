# Native WebGL investigation

This isolated experiment renders GLSL ES 3.00 and an upstream Three.js
`WebGLRenderer` PBR scene through `gl@9.0.0-rc.10` and ANGLE. It also reproduces
known API failures. **A completed process is not a WebGL compatibility pass.**
The report always says `partial`, and incompatible behavior says `known-failure`.
Unexpected output or a backend mismatch terminates the probe with an error.

## Reproduce on macOS

Prerequisites: Node 24, Python 3 and Xcode command-line development tools. The root
Three.js dependency comes from the repository lockfile. Native GPU access is
required. All candidate dependencies/build outputs stay in ignored directories;
do not install this experimental binding as a runtime dependency.

Run from the repository root:

```sh
npm ci
npm install --prefix .cache/native-webgl --cache .cache/native-webgl/npm-cache --ignore-scripts --no-audit --no-fund --save-exact gl@9.0.0-rc.10
```

Build only the small Node addon against the ANGLE binaries bundled by the
candidate. This does not build ANGLE or install system packages:

```sh
cd .cache/native-webgl/node_modules/gl
node ../node-gyp/bin/node-gyp.js rebuild --devdir ../../node-headers
cd ../../../..
node experiments/native-webgl/probe.mjs --backend metal
```

The last `cd` returns to the repository root. The command records
`artifacts/native-webgl/report.json`. An existing isolated installation can be
selected with `--deps-dir <directory-containing-node_modules>`.

On the tested machine the package included universal x64/arm64 ANGLE dylibs.
The addon build emitted upstream compiler warnings, including an unimplemented
buffer-readback path; these are part of the candidate assessment, not ignored
3JSN quality requirements. The recorded build used Node 24.13.0, NAN 2.27.0 and
node-gyp 12.4.0. The initial install locks its resolved dependency graph in the
ignored cache; preserve that lock when comparing rebuilds. See the report for
the package integrity and binary hashes. No third-party binary is committed here.

`--backend vulkan` and `--backend d3d11` are available for future Linux/Windows
investigation; neither has been run here. Their build prerequisites and hardware
behavior remain unverified. The probe checks the real native renderer string,
because ANGLE's default on the tested Mac was OpenGL and the binding's public
renderer/version strings hide that distinction.

## Evidence and scope

- [Recorded Metal result](../../docs/validation/2026-09-17-webgl-metal.json):
  GLSL draw and changing Three.js pixels passed; buffer readback and WebGL2
  version reporting failed.
- [Investigation](../../docs/investigations/webgl.md): candidate reuse,
  Rust/V8 integration, native texture sharing and remaining gates.

The host uses a synthetic canvas object. It does not load an unchanged web page,
present a native window, compose HTML, embed Rust, or test CtF. CPU pixel readback
exists only to assert test output. Context-loss, complete WebGL semantics and
performance remain unverified.
