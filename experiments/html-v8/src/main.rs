use std::{error::Error, fs, time::Instant};

use blitz_dom::{BaseDocument, DocumentConfig, LocalName, NodeData, NodeId, QualName, ns};
use blitz_html::{DocumentHtmlParser, HtmlDocument};
use deno_core::{JsRuntime, OpState, RuntimeOptions, op2};
use deno_error::JsErrorBox;
use serde::Deserialize;
use serde_json::{Value, json};

struct DomState {
    document: BaseDocument,
    started: Instant,
    messages: Vec<Value>,
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
    let doc = &mut state.borrow_mut::<DomState>().document;
    match request {
        Mutation::Create { tag } => {
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
            let id = node_id(doc, &id)?;
            let mut mutator = doc.mutate();
            // set_inner_html drops old children, which would invalidate retained wrappers.
            for child in mutator.child_ids(id) {
                mutator.remove_node(child);
            }
            DocumentHtmlParser::parse_inner_html_into_mutator(&mut mutator, id, &value);
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

deno_core::extension!(
    html_v8_probe,
    ops = [op_dom_read, op_dom_mutate, op_observe],
    esm_entry_point = "ext:html_v8_probe/bindings.js",
    esm = [dir "src", "bindings.js"],
    options = { dom: DomState },
    state = |state, options| state.put(options.dom),
);

fn main() -> Result<(), Box<dyn Error>> {
    let files: Vec<_> = std::env::args().skip(1).collect();
    if files.len() != 2 {
        return Err("usage: html-v8-probe <original-fixture.js> <behavior.js>".into());
    }
    let doc = HtmlDocument::from_html(
        "<!doctype html><html><body><div id='root'></div></body></html>",
        DocumentConfig::default(),
    )
    .into_inner();
    let mut runtime = JsRuntime::new(RuntimeOptions {
        extensions: vec![html_v8_probe::init(DomState {
            document: doc,
            started: Instant::now(),
            messages: vec![],
        })],
        ..Default::default()
    });
    for file in &files {
        let name = fs::canonicalize(file)?.to_string_lossy().into_owned();
        runtime.execute_script(name, fs::read_to_string(file)?)?;
    }
    runtime.execute_script(
        "probe:manual-frames",
        "__advanceProbeFrame(100); __advanceProbeFrame(116.6666666667);",
    )?;
    let messages = std::mem::take(
        &mut runtime
            .op_state()
            .borrow_mut()
            .borrow_mut::<DomState>()
            .messages,
    );
    let observed = messages
        .first()
        .ok_or("Original fixture produced no observations")?;
    for key in [
        "identity",
        "mutation",
        "detachedIdentity",
        "classListSameObject",
        "inputPrototype",
    ] {
        if observed[key] != true {
            return Err(format!("Failed original fixture observation: {key}").into());
        }
    }
    if observed["geometry"] != json!([120, 240])
        || observed["eventOrder"] != json!(["capture", "target", "bubble"])
    {
        return Err("Original layout/event observations disagree with browser baseline".into());
    }
    let behavior = messages
        .iter()
        .find_map(|value| value.get("behavior"))
        .ok_or("Missing behavioral checks")?;
    if !behavior
        .as_object()
        .is_some_and(|checks| checks.len() == 15 && checks.values().all(|value| value == true))
    {
        return Err(format!("Behavior check failed: {behavior}").into());
    }
    if messages.iter().find_map(|value| value.get("frames")) != Some(&json!([100, 116.6666666667]))
    {
        return Err("Manually driven RAF observations disagree with host timestamps".into());
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "fixture":"v8-blitz-dom", "result":"pass-for-declared-probe-subset",
            "blitzRevision":"9d92719b37c801b8b41c81b799a2a474db8b3936",
            "denoCore":"0.412.0", "v8":deno_core::v8::V8::get_version(),
            "messages":messages,
            "limits":["No GPU, HTML painting or window integration.","Synthetic DOM events only; native input and default actions are not implemented.","Wrappers and detached nodes retained until document destruction; no per-node garbage collection.","Manually driven RAF timestamps are a test hook, not display scheduling.","Only fixture-required DOM methods and prototypes are implemented."]
        }))?
    );
    Ok(())
}
