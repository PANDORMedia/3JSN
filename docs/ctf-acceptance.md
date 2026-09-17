# CtF acceptance protocol and private input identity

This protocol follows the [source inventory](ctf-compatibility.md) and
[unchanged-source contract](profiles/README.md). CtF is not supported by the
current probes. Browser reference and native end-to-end journeys have not yet
been executed under this protocol.

## Current private capture

Read-only capture on 2026-09-17 covered 1,190 file/directory/link entries from the
local checkout. Its git HEAD was `784dff4369280eee18f77b592c6a6431b5a0661b` and the
worktree was dirty. The private content manifest digest is
`385f3ce14801d67e057cfb5fd2dd16b9432c010976c92b7fac15e9f62314ad60`;
the root lockfile SHA-256 is
`dfd6ea06f88df54ea2d83e77082f9c6958830056e3855806d5e3f84edf443242`.
A second read produced the same manifest digest and no changed entries.

The ignored local `.cache/acceptance/ctf/` directory holds the private manifest
and provenance, including the exact exclusion set and dirty-worktree status.
Only `.git`, installed dependency directories and declared workspace `dist`
directories were excluded. Sources, lockfile, source assets and configuration
were measured; their contents are not tracked or published by 3JSN. The manifest
contains paths and content identities and must remain private.

An authorized private recovery directory now preserves the exact manifest-scoped
inputs, including the dirty changes: 1,107 files totaling 227,212,054 bytes. It is
stored beneath the ignored `.cache/acceptance/ctf/` directory; the private recovery
report records its locator. Every restored entry was rehashed against the original
manifest, and a second hash of the original checkout confirmed it stayed unchanged.
No installed dependencies or generated workspace outputs were copied.

Recovery directories and files are owner-only; existing owner executable bits are
retained. The private copy is retained as acceptance input and must not be edited.
Verify its digest before use, and work from a separate disposable copy when builds
need output directories. It is a recoverable local copy, not an off-machine backup
or filesystem-enforced immutable archive. Reconstructing from git HEAD alone loses
the uncommitted changes. Dependency installation, build-output identities and
toolchain/runtime versions remain part of the execution record.

## Execution and evidence

Use the same immutable game snapshot, installed dependency lock, service versions,
room state, visual settings, resolution and device setup in browser and native
runs. Endpoints and permission configuration stay private; reports contain only
sanitized service labels. Servers remain separately deployed services. Do not
claim offline operation from successful native client packaging.

Every step records browser result, native result, evidence locator and one of
`passed`, `failed`, `blocked`, `not-run`. Missing evidence is `not-run`, never a
pass. Preserve timestamps relative to recorded audio playback, input actions and
frame presentation. Screenshots and videos of the game require redistribution
review; publish original fixture results or sanitized capability reports instead.

| Journey | Actions and required observations |
| --- | --- |
| Startup and intro | Launch from an arbitrary working directory; verify asset loading, fonts, scene/UI appearance, audio-linked intro timing and transition into menus |
| Menus and identity | Navigate every menu; change settings and return; verify retained input/focus and one-action confirmation after DOM updates |
| Join and lobby | Connect to configured game service, join a room, select/confirm a team, change ready state and reach gameplay; observe peer state |
| Gameplay | Complete a representative round with multiple players; compare shaders/post-processing, overlays, procedural textures and input actions |
| Controller | Use physical supported Xbox/PlayStation controllers for menu and gameplay actions; test hotplug/focus changes; record the exact device and driver |
| Settings and persistence | Change volume/input settings, restart/reload and check expected local/session persistence without changing another application's data |
| Reconnect | Interrupt the game connection, restore it, verify UI/state recovery and prevent duplicate worker/network listeners |
| Microphone permission | Exercise allow and deny, unavailable/busy device and device change; report clear native permission outcomes |
| Voice self-test | Start recording with one input action, stop and play; verify audible playback, mute and processing behavior; test peer voice and reconnect |
| Window lifecycle | Resize repeatedly, change DPI/display where available, minimize/restore and switch focus; verify canvases, UI, input and audio behavior |
| Shutdown and failure | Exit during loading, active gameplay, voice capture and reconnect; ensure worker/network/audio/GPU cleanup and repeat launches |

Capture/verify source and asset manifests around successful, failed and cancelled
build/run attempts. Require identical scope and content digests. Keep an output
manifest with runtime/profile/target identities and asset hashes; source hashes
prove preservation only, not behavioral parity. Hardware-dependent audio/input
steps require real devices, not synthetic events or successful compilation.

## Public fixture coverage

The original [public fixture corpus](../fixtures/README.md) covers rendering/UI,
module workers/Wasm, offline Web Audio/worklets, and local fetch/WebSocket reconnect.
It can be redistributed. Its automated checks do not replace physical input,
full CSS coverage, CtF's Three.js version, real-time audio devices, voice,
game services or the journey above. Post-processing, media/voice, full lifecycle
and the CtF browser/native journey remain corpus and acceptance work.
