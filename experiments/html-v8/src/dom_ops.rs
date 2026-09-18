use std::time::Instant;

use blitz_dom::{BaseDocument, DocumentMutator, LocalName, NodeData, NodeId, QualName, ns};
use deno_core::{OpState, op2};
use deno_error::JsErrorBox;
use serde::Deserialize;
use serde_json::{Value, json};

#[path = "capabilities.rs"]
mod capabilities;
#[path = "dom_focus.rs"]
mod dom_focus;
#[cfg(test)]
#[path = "dom_focus_tests.rs"]
mod dom_focus_tests;
#[path = "dom_tree.rs"]
mod dom_tree;
#[cfg(test)]
#[path = "dom_tree_tests.rs"]
mod dom_tree_tests;

/// Hosts supply HTML parsing explicitly; ordinary tree operations do not depend on it.
pub type HtmlFragmentParser = for<'document> fn(&mut DocumentMutator<'document>, NodeId, &str);

struct DomState {
    document: BaseDocument,
    started: Instant,
    messages: Vec<Value>,
    html_fragment_parser: Option<HtmlFragmentParser>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Read {
    Focused,
    FocusRemoval {
        mutation: Mutation,
    },
    Focusability {
        id: String,
    },
    FocusCandidates,
    FocusNext {
        backward: bool,
    },
    FindById {
        value: String,
    },
    Describe {
        id: Option<String>,
    },
    Query {
        id: String,
        selector: String,
        all: bool,
    },
    Attribute {
        id: String,
        name: String,
    },
    Text {
        id: String,
    },
    Style {
        id: String,
        name: Option<String>,
    },
    Rect {
        id: String,
    },
    Path {
        id: String,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Mutation {
    Focus {
        id: Option<String>,
    },
    Create {
        tag: String,
    },
    CreateText {
        value: String,
    },
    Attribute {
        id: String,
        name: String,
        value: String,
    },
    RemoveAttribute {
        id: String,
        name: String,
    },
    CharacterData {
        id: String,
        value: String,
    },
    Text {
        id: String,
        value: String,
    },
    Html {
        id: String,
        value: String,
    },
    Append {
        id: String,
        child: String,
    },
    Insert {
        id: String,
        child: String,
        before: Option<String>,
    },
    Remove {
        id: String,
        child: String,
    },
    Style {
        id: String,
        name: String,
        value: String,
        #[serde(default)]
        important: bool,
    },
    StyleText {
        id: String,
        value: String,
    },
}

fn node_id(document: &BaseDocument, raw: &str) -> Result<NodeId, JsErrorBox> {
    let id = raw
        .parse()
        .map(NodeId::from_u64)
        .map_err(|_| JsErrorBox::type_error("Invalid node identifier"))?;
    if document.get_node(id).is_none() {
        return Err(JsErrorBox::type_error("Node is no longer available"));
    }
    Ok(id)
}

fn id_value(id: Option<NodeId>) -> Value {
    id.map(|id| Value::String(id.as_u64().to_string()))
        .unwrap_or(Value::Null)
}

fn attr_name(name: String) -> QualName {
    QualName::new(None, ns!(), LocalName::from(name))
}

fn attribute_name(document: &BaseDocument, id: NodeId, name: String) -> String {
    if document
        .get_node(id)
        .and_then(|node| node.element_data())
        .is_some_and(|element| element.name.ns.as_ref() == capabilities::HTML_NAMESPACE)
    {
        name.to_ascii_lowercase()
    } else {
        name
    }
}

#[op2]
#[serde]
fn op_dom_read(
    state: &mut OpState,
    #[serde] request: Read,
) -> Result<serde_json::Value, JsErrorBox> {
    read_dom(state.borrow_mut::<DomState>(), request)
}

fn read_dom(state: &mut DomState, request: Read) -> Result<Value, JsErrorBox> {
    let doc = &mut state.document;
    match request {
        Read::Focused => Ok(id_value(dom_focus::focused(doc))),
        Read::FocusRemoval { mutation } => {
            focus_removal(doc, state.html_fragment_parser.is_some(), mutation)
        }
        Read::Focusability { id } => {
            let id = node_id(doc, &id)?;
            doc.resolve(state.started.elapsed().as_secs_f64());
            Ok(json!(dom_focus::focusability(doc, id)))
        }
        Read::FocusCandidates => {
            doc.resolve(state.started.elapsed().as_secs_f64());
            Ok(Value::Array(
                dom_focus::candidates(doc)
                    .into_iter()
                    .map(|id| id_value(Some(id)))
                    .collect(),
            ))
        }
        Read::FocusNext { backward } => {
            doc.resolve(state.started.elapsed().as_secs_f64());
            Ok(id_value(dom_focus::next(doc, backward)))
        }
        Read::FindById { value } => Ok(id_value(doc.get_element_by_id(&value))),
        Read::Describe { id } => {
            let id = match id {
                Some(id) => node_id(doc, &id)?,
                None => doc.root_node().id,
            };
            dom_tree::describe(doc, id)
        }
        Read::Query { id, selector, all } => {
            let id = node_id(doc, &id)?;
            if all {
                let ids = doc
                    .query_selector_all_in(id, &selector)
                    .map_err(|error| JsErrorBox::generic(format!("Invalid selector: {error:?}")))?;
                Ok(Value::Array(
                    ids.into_iter().map(|id| id_value(Some(id))).collect(),
                ))
            } else {
                let id = doc
                    .query_selector_in(id, &selector)
                    .map_err(|error| JsErrorBox::generic(format!("Invalid selector: {error:?}")))?;
                Ok(id_value(id))
            }
        }
        Read::Attribute { id, name } => {
            let id = node_id(doc, &id)?;
            let name = attribute_name(doc, id, name);
            let value = doc
                .get_node(id)
                .unwrap()
                .element_data()
                .and_then(|element| element.attr(LocalName::from(name)));
            Ok(value.map(|value| json!(value)).unwrap_or(Value::Null))
        }
        Read::Text { id } => {
            let id = node_id(doc, &id)?;
            dom_tree::text_content(doc, id)
        }
        Read::Style { id, name } => {
            let id = node_id(doc, &id)?;
            let attribute = dom_tree::style_attribute(doc, id)?;
            Ok(json!(match name {
                Some(name) => doc.style_attr_get_property(attribute, &name),
                None => doc.style_attr_serialize(attribute),
            }))
        }
        Read::Rect { id } => {
            let id = node_id(doc, &id)?;
            doc.resolve(state.started.elapsed().as_secs_f64());
            let rect = doc
                .get_client_bounding_rect(id)
                .ok_or_else(|| JsErrorBox::generic("No layout box for node"))?;
            Ok(
                json!({"x":rect.x,"y":rect.y,"width":rect.width,"height":rect.height,
                "top":rect.y,"left":rect.x,"right":rect.x+rect.width,"bottom":rect.y+rect.height}),
            )
        }
        Read::Path { id } => {
            let mut current = Some(node_id(doc, &id)?);
            let mut path = Vec::new();
            while let Some(id) = current {
                let node = doc.get_node(id).unwrap();
                if !matches!(node.data, NodeData::AnonymousBlock(_)) {
                    path.push(id_value(Some(id)));
                }
                current = node.parent;
            }
            Ok(Value::Array(path))
        }
    }
}

// Preflight runs without mutation. JS can then dispatch blur while the old tree
// is still connected; the actual mutator validates again after those callbacks.
fn focus_removal(
    doc: &BaseDocument,
    has_parser: bool,
    mutation: Mutation,
) -> Result<Value, JsErrorBox> {
    let (subtree, include_root) = match mutation {
        Mutation::Remove { id, child } => {
            let parent = node_id(doc, &id)?;
            let child = node_id(doc, &child)?;
            dom_tree::require_child(doc, parent, child)?;
            (child, true)
        }
        Mutation::Append { id, child } => {
            let parent = node_id(doc, &id)?;
            let child = node_id(doc, &child)?;
            dom_tree::validate_insert(doc, parent, child, None)?;
            (child, true)
        }
        Mutation::Insert { id, child, before } => {
            let parent = node_id(doc, &id)?;
            let child = node_id(doc, &child)?;
            let before = before.map(|id| node_id(doc, &id)).transpose()?;
            dom_tree::validate_insert(doc, parent, child, before)?;
            (child, true)
        }
        Mutation::Text { id, .. } => {
            let id = node_id(doc, &id)?;
            if !matches!(doc.get_node(id).unwrap().data, NodeData::Element(_)) {
                return Ok(Value::Null);
            }
            (id, false)
        }
        Mutation::Html { id, .. } => {
            if !has_parser {
                return Err(JsErrorBox::generic(capabilities::HTML_PARSER_UNAVAILABLE));
            }
            let id = node_id(doc, &id)?;
            dom_tree::require_element(doc, id)?;
            (id, false)
        }
        _ => return Ok(Value::Null),
    };
    let focused = dom_focus::focused(doc);
    let mut current = focused;
    while let Some(id) = current {
        if id == subtree {
            return Ok(id_value(
                focused.filter(|id| include_root || *id != subtree),
            ));
        }
        current = doc.get_node(id).and_then(|node| node.parent);
    }
    Ok(Value::Null)
}

#[op2]
#[serde]
fn op_dom_mutate(
    state: &mut OpState,
    #[serde] request: Mutation,
) -> Result<serde_json::Value, JsErrorBox> {
    mutate_dom(state.borrow_mut::<DomState>(), request)
}

fn mutate_dom(state: &mut DomState, request: Mutation) -> Result<Value, JsErrorBox> {
    let parser = state.html_fragment_parser;
    let doc = &mut state.document;
    match request {
        Mutation::Focus { id } => {
            match id {
                None => doc.clear_focus(),
                Some(raw) => {
                    if let Ok(id) = node_id(doc, &raw) {
                        doc.resolve(state.started.elapsed().as_secs_f64());
                        if dom_focus::focusability(doc, id).programmatic {
                            doc.set_focus_to(id);
                        }
                    }
                }
            }
            Ok(id_value(dom_focus::focused(doc)))
        }
        Mutation::Create { tag } => {
            if parser.is_none()
                && let Some(reason) = capabilities::element_html_parser_requirement(
                    capabilities::HTML_NAMESPACE,
                    &tag,
                )
            {
                return Err(JsErrorBox::generic(format!(
                    "{}: {reason}",
                    capabilities::HTML_PARSER_UNAVAILABLE,
                )));
            }
            let name = QualName::new(None, ns!(html), LocalName::from(tag));
            Ok(id_value(Some(doc.mutate().create_element(name, vec![]))))
        }
        Mutation::CreateText { value } => Ok(id_value(Some(doc.mutate().create_text_node(&value)))),
        Mutation::Attribute { id, name, value } => {
            let id = node_id(doc, &id)?;
            dom_tree::require_element(doc, id)?;
            let name = attribute_name(doc, id, name);
            doc.mutate()
                .set_attribute(id, attr_name(name.clone()), &value);
            Ok(json!(name))
        }
        Mutation::RemoveAttribute { id, name } => {
            let id = node_id(doc, &id)?;
            dom_tree::require_element(doc, id)?;
            let name = attribute_name(doc, id, name);
            doc.mutate().clear_attribute(id, attr_name(name.clone()));
            Ok(json!(name))
        }
        Mutation::CharacterData { id, value } => {
            let id = node_id(doc, &id)?;
            dom_tree::set_character_data(doc, id, &value)?;
            Ok(Value::Null)
        }
        Mutation::Text { id, value } => {
            let id = node_id(doc, &id)?;
            dom_tree::set_text_content(doc, id, &value)?;
            Ok(Value::Null)
        }
        Mutation::Html { id, value } => {
            let parse =
                parser.ok_or_else(|| JsErrorBox::generic(capabilities::HTML_PARSER_UNAVAILABLE))?;
            let id = node_id(doc, &id)?;
            let mut mutator = doc.mutate();
            // set_inner_html drops old children, which would invalidate retained wrappers.
            for child in mutator.child_ids(id) {
                mutator.remove_node(child);
            }
            parse(&mut mutator, id, &value);
            Ok(Value::Null)
        }
        Mutation::Append { id, child } => {
            let parent = node_id(doc, &id)?;
            let child = node_id(doc, &child)?;
            dom_tree::insert(doc, parent, child, None)?;
            Ok(id_value(Some(child)))
        }
        Mutation::Insert { id, child, before } => {
            let parent = node_id(doc, &id)?;
            let child = node_id(doc, &child)?;
            let before = before.map(|id| node_id(doc, &id)).transpose()?;
            dom_tree::insert(doc, parent, child, before)?;
            Ok(id_value(Some(child)))
        }
        Mutation::Remove { id, child } => {
            let parent = node_id(doc, &id)?;
            let child = node_id(doc, &child)?;
            dom_tree::require_child(doc, parent, child)?;
            doc.mutate().remove_node(child);
            Ok(id_value(Some(child)))
        }
        Mutation::Style {
            id,
            name,
            value,
            important,
        } => {
            let id = node_id(doc, &id)?;
            let attribute = dom_tree::style_attribute(doc, id)?;
            if let Some(attribute) =
                doc.style_attr_set_property(attribute, &name, &value, important)
            {
                // A no-op must retain the original attribute, including absence
                // and author formatting, instead of emitting a mutation.
                if attribute != doc.style_attr_serialize(dom_tree::style_attribute(doc, id)?) {
                    doc.mutate()
                        .set_attribute(id, attr_name("style".into()), &attribute);
                }
            }
            Ok(Value::Null)
        }
        Mutation::StyleText { id, value } => {
            let id = node_id(doc, &id)?;
            dom_tree::require_element(doc, id)?;
            let attribute = doc.style_attr_serialize(&value);
            doc.mutate()
                .set_attribute(id, attr_name("style".into()), &attribute);
            Ok(Value::Null)
        }
    }
}

#[op2(fast)]
fn op_observe(state: &mut OpState, #[string] message: String) -> Result<(), JsErrorBox> {
    let value =
        serde_json::from_str(&message).map_err(|error| JsErrorBox::generic(error.to_string()))?;
    state.borrow_mut::<DomState>().messages.push(value);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(parser: Option<HtmlFragmentParser>) -> (DomState, NodeId, NodeId) {
        let mut document = BaseDocument::new(Default::default());
        let root = document.root_node().id;
        let (parent, retained) = {
            let mut dom = document.mutate();
            let parent = dom.create_element(
                QualName::new(None, ns!(html), LocalName::from("div")),
                vec![],
            );
            let retained = dom.create_text_node("retained");
            dom.append_children(parent, &[retained]);
            dom.append_children(root, &[parent]);
            (parent, retained)
        };
        (
            DomState {
                document,
                started: Instant::now(),
                messages: vec![],
                html_fragment_parser: parser,
            },
            parent,
            retained,
        )
    }

    fn fragment_callback(dom: &mut DocumentMutator<'_>, parent: NodeId, value: &str) {
        let text = dom.create_text_node(&format!("callback:{value}"));
        dom.append_children(parent, &[text]);
    }

    #[test]
    fn absent_parser_rejects_html_before_detaching_children() {
        let (mut state, parent, retained) = state(None);
        let error = mutate_dom(
            &mut state,
            Mutation::Html {
                id: parent.as_u64().to_string(),
                value: "<span>replacement</span>".into(),
            },
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains(capabilities::HTML_PARSER_UNAVAILABLE)
        );
        assert_eq!(
            state.document.get_node(parent).unwrap().children.as_slice(),
            &[retained]
        );
        assert_eq!(
            state.document.get_node(retained).unwrap().parent,
            Some(parent)
        );
        assert_eq!(
            state.document.get_node(retained).unwrap().text_content(),
            "retained"
        );
    }

    #[test]
    fn supplied_parser_receives_fragment_without_dropping_retained_nodes() {
        let (mut state, parent, retained) = state(Some(fragment_callback));
        mutate_dom(
            &mut state,
            Mutation::Html {
                id: parent.as_u64().to_string(),
                value: "<span>replacement</span>".into(),
            },
        )
        .unwrap();
        assert_eq!(state.document.get_node(retained).unwrap().parent, None);
        assert_eq!(
            state.document.get_node(retained).unwrap().text_content(),
            "retained"
        );
        assert_eq!(
            state.document.get_node(parent).unwrap().text_content(),
            "callback:<span>replacement</span>"
        );
        assert_eq!(state.document.get_node(parent).unwrap().children.len(), 1);
    }

    #[test]
    fn parserless_creation_rejects_subdocuments_but_keeps_ordinary_elements() {
        let (mut state, _, _) = state(None);
        let error = mutate_dom(
            &mut state,
            Mutation::Create {
                tag: "iframe".into(),
            },
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains(capabilities::HTML_PARSER_UNAVAILABLE)
        );
        let created = mutate_dom(&mut state, Mutation::Create { tag: "div".into() }).unwrap();
        let node = node_id(&state.document, created.as_str().unwrap()).unwrap();
        assert_eq!(
            state
                .document
                .get_node(node)
                .unwrap()
                .element_data()
                .unwrap()
                .name
                .local
                .as_ref(),
            "div"
        );
        state.html_fragment_parser = Some(fragment_callback);
        assert!(
            mutate_dom(
                &mut state,
                Mutation::Create {
                    tag: "iframe".into()
                }
            )
            .is_ok()
        );
    }
}
