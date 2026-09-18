//! Focus ownership for the shared HTML tree; JS dispatches events outside DOM borrows.
//!
//! This checkpoint supports ordinary HTML controls, links and explicit tabindex.
//! It does not implement SVG/MathML, shadow/subdocument focus delegation, editing
//! hosts, summary defaults, image-map areas, media subcontrols, radio-group tab
//! stops or scroll-into-view.
//! Queries do not run focus-fixup when styling/attributes make the current target
//! ineligible; tree removals retain the native mutator's existing focus teardown.

use blitz_dom::{BaseDocument, LocalName, Node, NodeId};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Focusability {
    pub programmatic: bool,
    pub sequential: bool,
    pub tab_index: i32,
}

pub(super) fn focused(document: &BaseDocument) -> Option<NodeId> {
    // Blitz's getter falls back to the root even when no element owns focus.
    document.get_focussed_node_id().filter(|id| {
        document
            .get_node(*id)
            .is_some_and(|node| node.flags.is_in_document() && node.is_focussed())
    })
}

fn attribute<'a>(node: &'a Node, name: &str) -> Option<&'a str> {
    node.element_data()?.attr(LocalName::from(name))
}

fn html_tag(node: &Node) -> Option<&str> {
    let element = node.element_data()?;
    (element.name.ns.as_ref() == super::capabilities::HTML_NAMESPACE)
        .then_some(element.name.local.as_ref())
}

fn integer(value: &str) -> Option<i32> {
    // HTML integer parsing accepts a signed digit prefix, not Rust's full-string
    // parse. The reflected long falls back to its default outside the i32 range.
    let mut bytes = value
        .trim_start_matches(['\t', '\n', '\u{000c}', '\r', ' '])
        .bytes()
        .peekable();
    let negative = match bytes.peek() {
        Some(b'-') => {
            bytes.next();
            true
        }
        Some(b'+') => {
            bytes.next();
            false
        }
        _ => false,
    };
    let mut magnitude = 0_u64;
    let mut digits = false;
    while let Some(digit @ b'0'..=b'9') = bytes.peek().copied() {
        digits = true;
        magnitude = magnitude
            .checked_mul(10)?
            .checked_add(u64::from(digit - b'0'))?;
        bytes.next();
    }
    if !digits {
        return None;
    }
    let value = if negative {
        -(i128::from(magnitude))
    } else {
        i128::from(magnitude)
    };
    i32::try_from(value).ok()
}

fn within(document: &BaseDocument, mut id: NodeId, ancestor: NodeId) -> bool {
    loop {
        if id == ancestor {
            return true;
        }
        let Some(parent) = document.get_node(id).and_then(|node| node.parent) else {
            return false;
        };
        id = parent;
    }
}

fn blocked_by_ancestors(document: &BaseDocument, id: NodeId, form_control: bool) -> bool {
    let mut current = Some(id);
    while let Some(ancestor) = current {
        let Some(node) = document.get_node(ancestor) else {
            return true;
        };
        if attribute(node, "inert").is_some()
            || node
                .primary_styles()
                .is_some_and(|style| style.clone_display().is_none())
        {
            return true;
        }
        if form_control
            && html_tag(node) == Some("fieldset")
            && attribute(node, "disabled").is_some()
        {
            let first_legend = node.children.iter().copied().find(|child| {
                document
                    .get_node(*child)
                    .is_some_and(|node| html_tag(node) == Some("legend"))
            });
            if first_legend.is_none_or(|legend| !within(document, id, legend)) {
                return true;
            }
        }
        current = node.parent;
    }
    false
}

/// Caller resolves styles once before evaluating one node or a candidate list.
pub(super) fn focusability(document: &BaseDocument, id: NodeId) -> Focusability {
    let mut result = Focusability {
        programmatic: false,
        sequential: false,
        tab_index: -1,
    };
    let Some(node) = document.get_node(id) else {
        return result;
    };
    let Some(tag) = html_tag(node) else {
        return result;
    };
    let explicit = attribute(node, "tabindex").and_then(integer);
    let form_control = matches!(tag, "button" | "input" | "select" | "textarea");
    let reflected_default =
        if form_control || matches!(tag, "a" | "area" | "frame" | "iframe" | "object") {
            0
        } else {
            -1
        };
    result.tab_index = explicit.unwrap_or(reflected_default);
    let natural = form_control || tag == "a" && attribute(node, "href").is_some();
    if !node.flags.is_in_document()
        || (!natural && explicit.is_none())
        || form_control && attribute(node, "disabled").is_some()
        || tag == "input"
            && attribute(node, "type").is_some_and(|value| value.eq_ignore_ascii_case("hidden"))
        || blocked_by_ancestors(document, id, form_control)
        || node.primary_styles().is_none()
        || node
            .primary_styles()
            .is_some_and(|style| style.clone_display().is_contents())
        || document.resolved_style_value(id, "visibility") != "visible"
    {
        return result;
    }
    result.programmatic = true;
    result.sequential = result.tab_index >= 0;
    result
}

pub(super) fn candidates(document: &BaseDocument) -> Vec<NodeId> {
    let mut pending = vec![document.root_node().id];
    let mut eligible = Vec::new();
    while let Some(id) = pending.pop() {
        let node = document.get_node(id).unwrap();
        pending.extend(node.children.iter().rev().copied());
        let focus = focusability(document, id);
        if focus.sequential {
            eligible.push((id, focus.tab_index));
        }
    }
    // Stable sorting retains DOM order for equal positives and zero/defaults.
    eligible.sort_by_key(|(_, index)| (*index == 0, *index));
    eligible.into_iter().map(|(id, _)| id).collect()
}

pub(super) fn next(document: &BaseDocument, backward: bool) -> Option<NodeId> {
    let ordered = candidates(document);
    let boundary = if backward {
        ordered.last()
    } else {
        ordered.first()
    }
    .copied();
    let Some(current) = focused(document) else {
        return boundary;
    };
    if let Some(index) = ordered.iter().position(|id| *id == current) {
        return if backward {
            index
                .checked_sub(1)
                .map(|index| ordered[index])
                .or(boundary)
        } else {
            ordered.get(index + 1).copied().or(boundary)
        };
    }
    // Programmatic-only targets start from DOM order, not positive-tabindex
    // order. This native application cycles at the edge of its own window.
    let eligible: std::collections::HashSet<_> = ordered.into_iter().collect();
    let mut pending = vec![document.root_node().id];
    let mut previous = None;
    let mut after_current = false;
    while let Some(id) = pending.pop() {
        pending.extend(
            document
                .get_node(id)
                .unwrap()
                .children
                .iter()
                .rev()
                .copied(),
        );
        if id == current {
            if backward {
                return previous.or(boundary);
            }
            after_current = true;
        } else if eligible.contains(&id) {
            if after_current {
                return Some(id);
            }
            previous = Some(id);
        }
    }
    boundary
}
