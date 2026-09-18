//! Runs the shared native mutation controls even though the runtime binary has
//! `test = false`. Both feature modes exercise actual Blitz nodes and mutation
//! dispatch; these CPU tests do not establish native window or GPU behavior.

#[allow(
    dead_code,
    reason = "Only the shared mutation tests are exercised here."
)]
#[path = "../../html-v8/src/dom_ops.rs"]
mod dom_ops;
