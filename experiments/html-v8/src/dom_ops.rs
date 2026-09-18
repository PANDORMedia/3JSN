use std::time::Instant;

use blitz_dom::{BaseDocument, DocumentMutator, LocalName, NodeData, NodeId, QualName, ns};
use deno_core::{OpState, op2};
use deno_error::JsErrorBox;
use serde::Deserialize;
use serde_json::{Value, json};

#[path = "capabilities.rs"]
mod capabilities;

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
    Create {
        tag: String,
    },
    Attribute {
        id: String,
        name: String,
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
    Remove {
        id: String,
        child: String,
    },
    Style {
        id: String,
        name: String,
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

#[op2]
#[serde]
fn op_dom_read(
    state: &mut OpState,
    #[serde] request: Read,
) -> Result<serde_json::Value, JsErrorBox> {
    let state = state.borrow_mut::<DomState>();
    let doc = &mut state.document;
    match request {
        Read::FindById { value } => Ok(id_value(doc.get_element_by_id(&value))),
        Read::Describe { id } => {
            let id = match id {
                Some(id) => node_id(doc, &id)?,
                None => doc.root_node().id,
            };
            let node = doc.get_node(id).unwrap();
            let tag = match &node.data {
                NodeData::Document(_) => "#document".into(),
                NodeData::Text(_) => "#text".into(),
                NodeData::Element(element) => element.name.local.to_string(),
                _ => "#other".into(),
            };
            Ok(json!({"id": id_value(Some(id)), "tag": tag, "parent": id_value(node.parent)}))
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
            let value = doc
                .get_node(id)
                .unwrap()
                .element_data()
                .and_then(|element| element.attr(LocalName::from(name)));
            Ok(value.map(|value| json!(value)).unwrap_or(Value::Null))
        }
        Read::Text { id } => {
            let id = node_id(doc, &id)?;
            Ok(json!(doc.get_node(id).unwrap().text_content()))
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
        Mutation::Attribute { id, name, value } => {
            let id = node_id(doc, &id)?;
            doc.mutate().set_attribute(id, attr_name(name), &value);
            Ok(Value::Null)
        }
        Mutation::Text { id, value } => {
            let id = node_id(doc, &id)?;
            let mut mutator = doc.mutate();
            // Keep removed nodes alive because existing JS wrappers remain observable.
            for child in mutator.child_ids(id) {
                mutator.remove_node(child);
            }
            if !value.is_empty() {
                let text = mutator.create_text_node(&value);
                mutator.append_children(id, &[text]);
            }
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
            let mut current = Some(parent);
            while let Some(id) = current {
                if id == child {
                    return Err(JsErrorBox::generic("HierarchyRequestError"));
                }
                current = doc.get_node(id).unwrap().parent;
            }
            let mut mutator = doc.mutate();
            mutator.remove_node(child);
            mutator.append_children(parent, &[child]);
            Ok(id_value(Some(child)))
        }
        Mutation::Remove { id, child } => {
            let parent = node_id(doc, &id)?;
            let child = node_id(doc, &child)?;
            if doc.get_node(child).unwrap().parent != Some(parent) {
                return Err(JsErrorBox::generic("NotFoundError"));
            }
            doc.mutate().remove_node(child);
            Ok(id_value(Some(child)))
        }
        Mutation::Style { id, name, value } => {
            let id = node_id(doc, &id)?;
            doc.mutate().set_style_property(id, &name, &value);
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
