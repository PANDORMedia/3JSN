//! Complete Deno's DOM event path for the native document's Window.
//!
//! deno_web 0.290.0 supplies the dispatch algorithm but treats every parent as a
//! Node. Keep its event state/propagation machinery and change only these hooks.
//! Checked source anchors fail the build when the pinned upstream changes.

pub fn patch(code: &str) -> String {
    let mut code = code.to_owned();
    for (before, after) in [
        (
            "function getParent(eventTarget) {\n  return isNode(eventTarget) ? eventTarget.parentNode : null;\n}",
            "function getParent(eventTarget, event) {\n  if (eventTarget?.nodeType === 9) {\n    return event?.type === \"load\" ? null : eventTarget.defaultView ?? null;\n  }\n  return isNode(eventTarget) ? eventTarget.parentNode : null;\n}",
        ),
        (
            "let parent = getParent(targetImpl);",
            "let parent = getParent(targetImpl, eventImpl);",
        ),
        (
            "parent = getParent(parent);",
            "parent = getParent(parent, eventImpl);",
        ),
        (
            "isNode(parent) &&\n        isShadowInclusiveAncestor(getRoot(targetImpl), parent)",
            "parent === globalThis_ ||\n        (isNode(parent) &&\n          isShadowInclusiveAncestor(getRoot(targetImpl), parent))",
        ),
    ] {
        assert_eq!(
            code.matches(before).count(),
            1,
            "Deno DOM event parent patch anchor changed: {before}"
        );
        code = code.replacen(before, after, 1);
    }
    code
}
