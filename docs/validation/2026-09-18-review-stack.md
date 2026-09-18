# Daily PR review corrections — 2026-09-18

The existing PR57–63 stack was corrected in isolated checkouts and integrated
through its dependency order. No change was merged into main. Review comments
were assessed against the code; the review's original passing CI did not catch
the analyzer hang or invalid DOM receiver path.

| PR | Corrections |
| --- | --- |
| [57](https://github.com/PANDORMedia/3JSN/pull/57) | Network-policy wording; loader node/depth/string/metadata boundary tests; construction error propagation |
| [58](https://github.com/PANDORMedia/3JSN/pull/58) | Runnable actual DOM mutation tests in both parser modes; Python evidence collectors wired into CI; network-policy wording |
| [59](https://github.com/PANDORMedia/3JSN/pull/59) | Same-read bounded verified font bytes in both packaged hosts; specific package rejection tests; unreachable check removed; locale-independent ordering with a failing-before regression |
| [60](https://github.com/PANDORMedia/3JSN/pull/60) | Verbatim upstream licenses/notices; attribution; explicit deferred behavior and network-policy limits |
| [61](https://github.com/PANDORMedia/3JSN/pull/61) | Explicit limits on per-record microtask and duplicated adapter coverage; queue algorithm unchanged |
| [62](https://github.com/PANDORMedia/3JSN/pull/62) | Receiver validation before mutation/layout, real V8 regression in both modes, Deno event-helper attribution |
| [63](https://github.com/PANDORMedia/3JSN/pull/63) | Bounded/interruptible analysis and findings, iterative HTML traversal, dependency exclusions, metadata/BOM/unsupported-format coverage, Windows junction path normalization |

## Integrated local checks

- Full Node suite: **196 pass, one existing skip**.
- Core Rust workspace: **53 pass, two existing ignores**; strict all-target
  Clippy and workspace formatting pass.
- Source/config/document check: **782 pass** before adding this archive.
- Both Python collector suites: **three tests each pass**.
- Real CPU runtime integration: preserved mode **23 DOM mutation + 24 receiver
  + 13 package-option tests**; restricted mode **23 + 24 + 11**. All pass;
  shared controls repeat across targets/modes. Strict scoped runtime Clippy passes
  in both modes. This is not 118 unique controls or GPU execution.

[Source identities](2026-09-18-review-stack/source-identities.json) identify the
integrated tested code; logs and the runtime receipt sit alongside them. Earlier
per-PR evidence records the failing-before reproductions and feature-specific
checks. The first analyzer correction passed macOS/Linux CI and exposed a Windows
junction spelling mismatch; its correction retains exact exclusion/external-link
assertions and requires new-head Windows CI. Final source CI remains separate
from native hardware evidence. No GPU/window test or performance claim is added.

## Explicitly deferred review observations

Wrapper/detached-node retention and quadratic collection traversal remain
experimental DOM limits. Deno JS notifications/rejections that become runnable
during or after the final GPU drain still need a bounded shutdown protocol and
an after-final-frame control. The prior completion negatives execute before the
frame limit and do not prove that case.

DOM-host tests remain local CPU/V8 evidence, not part of the root source CI
matrix. The input test adapter mirrors dispatch and does not directly cover the
worker's 64-record drain; per-listener browser microtask equivalence is unproven.
Keyboard key/code strings still depend on the pinned winit Debug spelling.
Some older runtime negative assertions remain generic; the repaired package
boundaries assert specific errors. Exhaustive file-count/FIFO/platform parser
stress coverage remains followup work. These observations were not silently
promoted to supported behavior or marked complete.

The source notices do not replace a shipping-binary dependency/license inventory.
Unchanged Three.js project builds, full WebGL bindings and other native platform
acceptance remain open roadmap work.
