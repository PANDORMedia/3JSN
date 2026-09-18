//! Shared live-tree operations. Validate browser-visible relationships before
//! calling mutators whose unchecked anchors otherwise panic or detach nodes.

use blitz_dom::{BaseDocument, NodeData, NodeId};
use deno_error::JsErrorBox;
use serde_json::{Value, json};

use super::id_value;

fn hierarchy(message: &'static str) -> JsErrorBox {
    JsErrorBox::new("DOMExceptionHierarchyRequestError", message)
}

fn parent(document: &BaseDocument, id: NodeId) -> Option<NodeId> {
    let mut current = document.get_node(id)?.parent;
    while let Some(id) = current {
        let node = document.get_node(id)?;
        if !matches!(node.data, NodeData::AnonymousBlock(_)) {
            return Some(id);
        }
        current = node.parent;
    }
    None
}

fn children(document: &BaseDocument, id: NodeId) -> Vec<NodeId> {
    let mut result = Vec::new();
    for child in document.get_node(id).unwrap().children.iter().copied() {
        if matches!(
            document.get_node(child).unwrap().data,
            NodeData::AnonymousBlock(_)
        ) {
            result.extend(children(document, child));
        } else {
            result.push(child);
        }
    }
    result
}

pub(super) fn describe(document: &BaseDocument, id: NodeId) -> Result<Value, JsErrorBox> {
    let node = document.get_node(id).unwrap();
    let (tag, node_type, node_name, namespace, local_name, prefix) = match &node.data {
        NodeData::Document(_) => ("#document".into(), 9, "#document".into(), None, None, None),
        NodeData::Text(_) => ("#text".into(), 3, "#text".into(), None, None, None),
        // Keep the old tag field while exposing the actual DOM node kind.
        NodeData::Comment { .. } => ("#other".into(), 8, "#comment".into(), None, None, None),
        NodeData::Element(element) => {
            let name = &element.name;
            let local = name.local.to_string();
            let prefix = name.prefix.as_ref().map(ToString::to_string);
            let qualified = prefix
                .as_ref()
                .map_or_else(|| local.clone(), |prefix| format!("{prefix}:{local}"));
            let node_name = if name.ns.as_ref() == super::capabilities::HTML_NAMESPACE {
                qualified.to_ascii_uppercase()
            } else {
                qualified
            };
            (
                local.clone(),
                1,
                node_name,
                (!name.ns.is_empty()).then(|| name.ns.to_string()),
                Some(local),
                prefix,
            )
        }
        NodeData::AnonymousBlock(_) => {
            return Err(JsErrorBox::type_error("Layout boxes are not DOM nodes"));
        }
    };
    let parent = parent(document, id);
    let siblings = parent
        .map(|parent| children(document, parent))
        .unwrap_or_default();
    let index = siblings.iter().position(|sibling| *sibling == id);
    let previous = index
        .and_then(|index| index.checked_sub(1))
        .map(|index| siblings[index]);
    let next = index.and_then(|index| siblings.get(index + 1)).copied();
    Ok(json!({
        "id": id_value(Some(id)), "tag": tag, "parent": id_value(parent),
        "nodeType": node_type, "nodeName": node_name, "namespace": namespace,
        "localName": local_name, "prefix": prefix,
        "children": children(document, id).into_iter().map(|id| id_value(Some(id))).collect::<Vec<_>>(),
        "previousSibling": id_value(previous), "nextSibling": id_value(next),
    }))
}

pub(super) fn text_content(document: &BaseDocument, id: NodeId) -> Result<Value, JsErrorBox> {
    let node = document.get_node(id).unwrap();
    match &node.data {
        NodeData::Document(_) => Ok(Value::Null),
        NodeData::Comment { contents } => Ok(json!(contents)),
        NodeData::Text(_) | NodeData::Element(_) => Ok(json!(node.text_content())),
        NodeData::AnonymousBlock(_) => {
            Err(JsErrorBox::type_error("Layout boxes are not DOM nodes"))
        }
    }
}

pub(super) fn set_character_data(
    document: &mut BaseDocument,
    id: NodeId,
    value: &str,
) -> Result<(), JsErrorBox> {
    match &mut document.get_node_mut(id).unwrap().data {
        NodeData::Text(_) => document.mutate().set_node_text(id, value),
        // Comments do not participate in style/layout. The pinned public mutator
        // only changes Text, so update the public comment payload in place.
        NodeData::Comment { contents } => {
            contents.clear();
            contents.push_str(value);
        }
        _ => {
            return Err(JsErrorBox::type_error(
                "Character data requires a Text or Comment node",
            ));
        }
    }
    Ok(())
}

pub(super) fn set_text_content(
    document: &mut BaseDocument,
    id: NodeId,
    value: &str,
) -> Result<(), JsErrorBox> {
    match &document.get_node(id).unwrap().data {
        NodeData::Document(_) => return Ok(()),
        NodeData::Text(_) | NodeData::Comment { .. } => {
            return set_character_data(document, id, value);
        }
        NodeData::Element(_) => {}
        NodeData::AnonymousBlock(_) => {
            return Err(JsErrorBox::type_error("Layout boxes are not DOM nodes"));
        }
    }
    let mut mutator = document.mutate();
    // Detached wrappers remain observable, including their existing descendants.
    for child in mutator.child_ids(id) {
        mutator.remove_node(child);
    }
    if !value.is_empty() {
        let text = mutator.create_text_node(value);
        mutator.append_children(id, &[text]);
    }
    Ok(())
}

pub(super) fn require_element(document: &BaseDocument, id: NodeId) -> Result<(), JsErrorBox> {
    if !matches!(document.get_node(id).unwrap().data, NodeData::Element(_)) {
        return Err(JsErrorBox::type_error(
            "Attribute operations require an Element",
        ));
    }
    Ok(())
}

pub(super) fn style_attribute(document: &BaseDocument, id: NodeId) -> Result<&str, JsErrorBox> {
    require_element(document, id)?;
    Ok(document
        .get_node(id)
        .unwrap()
        .element_data()
        .unwrap()
        .attr(blitz_dom::LocalName::from("style"))
        .unwrap_or(""))
}

pub(super) fn require_child(
    document: &BaseDocument,
    receiver: NodeId,
    child: NodeId,
) -> Result<(), JsErrorBox> {
    if parent(document, child) != Some(receiver) || !children(document, receiver).contains(&child) {
        return Err(JsErrorBox::new(
            "DOMExceptionNotFoundError",
            "The node is not a child of this parent",
        ));
    }
    Ok(())
}

pub(super) fn insert(
    document: &mut BaseDocument,
    receiver: NodeId,
    child: NodeId,
    before: Option<NodeId>,
) -> Result<(), JsErrorBox> {
    let receiver_node = document.get_node(receiver).unwrap();
    if !matches!(
        receiver_node.data,
        NodeData::Element(_) | NodeData::Document(_)
    ) {
        return Err(hierarchy("Only Element and Document parents are supported"));
    }
    let child_node = document.get_node(child).unwrap();
    if !matches!(
        child_node.data,
        NodeData::Element(_) | NodeData::Text(_) | NodeData::Comment { .. }
    ) {
        return Err(hierarchy(
            "Only Element, Text and Comment children are supported",
        ));
    }
    let mut current = Some(receiver);
    while let Some(id) = current {
        if id == child {
            return Err(hierarchy(
                "The child is an inclusive ancestor of this parent",
            ));
        }
        current = parent(document, id);
    }
    if let Some(anchor) = before {
        require_child(document, receiver, anchor)?;
    }
    if matches!(receiver_node.data, NodeData::Document(_)) {
        if matches!(child_node.data, NodeData::Text(_)) {
            return Err(hierarchy("A Document cannot have a Text child"));
        }
        if matches!(child_node.data, NodeData::Element(_))
            && children(document, receiver).into_iter().any(|id| {
                id != child && matches!(document.get_node(id).unwrap().data, NodeData::Element(_))
            })
        {
            return Err(hierarchy("A Document cannot have multiple root elements"));
        }
    }
    if before == Some(child) {
        return Ok(());
    }
    // These public mutators detach before insertion and retain each NodeId.
    let mut mutator = document.mutate();
    match before {
        Some(anchor) => mutator.insert_nodes_before(anchor, &[child]),
        None => mutator.append_children(receiver, &[child]),
    }
    Ok(())
}
