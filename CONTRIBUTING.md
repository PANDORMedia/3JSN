# Contributing

3JSN is at the research/prototype stage. Start with the roadmap and architecture
decision. Discuss changes that alter the runtime, renderer boundary or supported
web API subset before introducing a second implementation.

Use Node.js 24+ and Rust 1.92+. Pin direct experiment dependencies and commit both
lockfiles. Keep generated captures, downloads, caches and build outputs out of Git.
The Node/Dawn experiment and Rust device diagnostic are independent; label results
with the actual runtime and backend rather than calling both “the engine.”

```sh
npm ci
npm run check
cargo fmt --all --check
cargo check --workspace --locked
cargo clippy --workspace --locked -- -D warnings
```

For GPU-related work, also run the relevant probe on a real GPU and record the
hardware, driver/backend, command and result. Hosted CI compilation is not evidence
of native rendering. Do not turn a missing GPU into a passing GPU test.

Avoid broad Three.js forks and silent browser/WebGL/software fallbacks. Keep
platform-specific behavior behind small boundaries. Explain any unsafe Rust with
its lifetime and thread-safety invariants. Preserve third-party licenses for any
code incorporated into the project.

PRs should explain the resulting behavior, why it is needed, validation performed,
and remaining gaps. Performance claims need comparable workloads and raw evidence.
All contributions are under the project's MIT license.
