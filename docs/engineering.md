# Engineering standards

3JSN should be maintainable, solid and understandable. Contributors must be able
to identify a subsystem's owner, contract and failure modes.
The [module contracts](module-contracts.md) make these responsibilities explicit.

## Boundaries

- Separate project analysis/build tooling from the shipping runtime.
- Give platform lifecycle, JS execution, graphics, DOM/UI and services explicit
  owners. Use small contracts; avoid dependency cycles and global registries.
- Keep library-specific types inside adapters where practical. Expose capabilities
  and errors rather than leaking dependency internals across the codebase.
- State thread affinity, GPU ownership, teardown and cancellation behavior.
  Keep unsafe code small and document its precise safety invariants.
- Prefer maintained libraries to duplicate standards implementations. Track local
  patches and upgrade costs. Avoid a permanent broad Three.js fork.

## Code and comments

Names, types and focused functions explain ordinary control flow. Comments explain
intent, invariants, non-obvious algorithms, compatibility constraints or a linked
upstream workaround. Do not narrate assignments, add decorative banners or keep
stale comments. Every comment must answer a useful question the code cannot.

Document public APIs with behavior, ownership, errors and a minimal example when
helpful. Put architectural decisions in ADRs, usage in guides and changing task
status in issues. Avoid duplicating a specification across multiple documents.

## Reliability

Use structured errors at boundaries. Do not hide unsupported features, fallback
renderers, failed assets or invalid handles behind success. Cancellation and
shutdown are normal paths. Bound queues, retries and resource ownership.

Test observable behavior and important failure paths: bindings, lifecycle,
cleanup, pixels/input, assets and unchanged-source builds. Avoid tests that repeat
the implementation. Label hardware checks separately from hosted CI compilation.
Keep GPU validation during bring-up and record settings in performance results.

## Dependencies and documentation

Pin tested runtime combinations and lock application dependencies. Record upgrade
rationale and temporary patches; remove dependencies that no longer earn their
cost. Distinguish proposed, experimental and verified behavior. Keep examples and
commands current. Check links and executable examples where practical.

## Pull requests

Explain the behavior change, reason, validation and remaining limits. Review
ownership, errors, teardown, compatibility and docs where affected. Delete
redundant code/comments instead of explaining accidental complexity. Performance
improvements need comparable evidence.
