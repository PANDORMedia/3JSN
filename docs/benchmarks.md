# Performance measurement protocol

Status: planned. The current screenshot probe deliberately reads pixels back and
is not a benchmark. No speedup over a browser or another engine has been measured.

## Compare equivalent work

Use identical Three.js versions, scenes, camera, shaders, drawable pixel sizes,
pixel ratio, antialiasing, color/tone settings, shadows, texture formats and asset
resolution. Check images first. Compare a browser WebGPU build, the proposed Rust
host, and an available existing native runtime. Use the same physical machine.

Record OS, GPU/driver, CPU, runtime versions, backend, build mode, validation,
display refresh, present mode, power source and thermal conditions. Do not
compare a debug native build with a release browser, or software GPU with hardware.
Keep VSync-paced behavior and uncapped throughput as separate measurements.

## Workloads

| Workload | Purpose |
| --- | --- |
| Small static PBR scene | Startup, first frame, idle memory, minimum per-frame cost |
| Many distinct meshes and materials | JS traversal, binding overhead, draw submission |
| Instanced equivalent scene | Control for object/draw count and batching |
| Dynamic vertex/texture uploads | Allocation, copies, bandwidth, synchronization |
| Animated skinned glTF scene | Typical game CPU/GPU workload |
| Many material variants | Cold shader compilation and warm cache behavior |
| Fill-rate/post-processing scene | GPU-bound control; native host may change little |
| Resize and long play session | Surface correctness, pacing and resource growth |

## Measurements

- Time from process start to first presented frame; cold and warm runs separately.
- CPU update, render preparation and submission spans with p50/p95/p99.
- GPU timestamps when supported; do not label CPU submission time as GPU duration.
- Frame/present intervals, missed frames and queue depth.
- Input-to-display latency measured separately; input-event timestamps alone do
  not establish photon latency. Use external measurement for that claim.
- Process RSS, JS heap, GPU resource estimates, allocation/GC pauses and uploads.

Use at least five runs per case. Warm up for a recorded period (initial target:
300 frames), then sample at least 1,800 frames. Preserve per-frame values and
document outlier treatment; do not remove stutters simply because they hurt results.
Record compilation/startup separately rather than hiding them in warm averages.

Avoid readback and `onSubmittedWorkDone()` on every measured frame; they can
serialize execution and change the workload. Timestamp queries and asynchronous
readback should be sampled with bounded buffering. Report unsupported metrics.

## Decision rules

First locate the bottleneck with a profile. Optimize binding calls only when they
are significant; optimize GPU workload when GPU time dominates. A new backend
must preserve the correctness fixtures and justify its maintenance cost with a
repeatable improvement in the target workload. Set numerical regression budgets
after obtaining a stable baseline, not before observing hardware behavior.
