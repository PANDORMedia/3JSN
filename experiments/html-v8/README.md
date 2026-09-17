# V8 ↔ Blitz DOM probe

An isolated feasibility experiment for [issue #22](https://github.com/PANDORMedia/3JSN/issues/22).
One V8 realm calls one Rust-owned Blitz `BaseDocument`. This is **not** the shipping
DOM implementation, a browser compatibility profile, or a rendered game.

The original [DOM fixture](../../docs/investigations/html-dom/fixture.js) runs
without edits. The additional [behavior fixture](behavior.js) checks reentrant
listener mutation/layout, propagation paths, cancellation, detached-node lifetime,
listener removal, and invalid operations. Both can be compared using
[browser.html](browser.html).

## Reproduce

Run from the repository root with Rust 1.93.0 and a native compiler. Initial
compilation downloads the pinned Blitz revision and Deno/V8 dependencies. The
independent lockfile pins this experiment; it does not change the root workspace.

```sh
mkdir -p .cache/html-v8-probe
cp -R experiments/html-v8/. .cache/html-v8-probe/
CARGO_BUILD_JOBS=2 cargo run --locked \
  --manifest-path .cache/html-v8-probe/Cargo.toml -- \
  docs/investigations/html-dom/fixture.js \
  experiments/html-v8/behavior.js
```

The command fails if any declared DOM observation or any of the 15 additional
checks fails. Its JSON output also records the unsupported canvas/service
observations; passing the declared subset does not make those capabilities work.
Open `experiments/html-v8/browser.html` in a browser to obtain the same fixture's
observations. Match messages by their keys: browser loading/frame scheduling may
change the order in which result objects appear.

For an existing repository cache, optional `CARGO_HOME` and `CARGO_TARGET_DIR`
settings can reuse dependency downloads/builds. Do not run the fixture as a root
workspace member; keep the separate manifest and lockfile.

## Ownership and bridge

Rust owns the document, style/layout state and versioned node identifiers. Each
operation validates identifiers before accessing nodes. Identifiers cross the
boundary as decimal strings so a 64-bit ID cannot lose precision in a JS number.
JS caches wrappers and listener registrations; it has no copy of the DOM tree.
Queries, parent relationships, attributes, mutations and geometry are read from
or applied to the Rust document.

Native operations are synchronous and finish before JS listeners run. Dispatch
snapshots its propagation path by querying Rust, then calls JS listeners without
holding a Rust document borrow. A listener can therefore reenter the bridge,
mutate the tree and synchronously measure the result. The next dispatch reads a
new propagation path. No callback crosses two JS engines.

For HTML/text replacement, children are detached through `DocumentMutator` and
then replacement content is parsed through the public `DocumentHtmlParser` API.
Calling Blitz's `set_inner_html` directly would destroy old nodes, invalidating
wrappers still referenced by JS. This experiment retains detached nodes and
wrappers until the entire document is dropped. It does not prove long-running
per-node garbage collection.

## Explicit limits

- No Three.js canvas, GPU device, paint, compositor, window or native input.
- Only the fixture's DOM methods/prototypes exist. `querySelectorAll` returns an
  array; CSSOM, live collections, most WebIDL conversions and DOM exceptions are
  incomplete. Some unsupported prototype operations are not yet guarded.
- Synthetic event dispatch only. Native default actions, event trust,
  composed/shadow paths and browser exception-reporting semantics are absent.
- HTML parsing does not execute page scripts; the harness evaluates fixture
  files separately in the same realm.
- No Worker, WebSocket, Web Audio, MutationObserver or canvas `getContext`.
- RAF is manually advanced by the harness. It tests callback plumbing with
  supplied timestamps, not clocks, display pacing or a native frame scheduler.
- No release-size, performance, CSS visual or hardware-conformance claim.

Use these findings to design a maintained binding surface, not to promote these
partial classes into the runtime by copying them wholesale.
