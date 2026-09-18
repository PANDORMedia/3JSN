use super::*;

fn raw(id: NodeId) -> String {
    id.as_u64().to_string()
}

fn fixture() -> (DomState, NodeId, [NodeId; 3]) {
    let mut document = BaseDocument::new(Default::default());
    let root = document.root_node().id;
    let mut dom = document.mutate();
    let parent = dom.create_element(QualName::new(None, ns!(html), "main".into()), vec![]);
    let children = ["a", "b", "c"].map(|name| {
        let child = dom.create_element(QualName::new(None, ns!(html), "span".into()), vec![]);
        let text = dom.create_text_node(name);
        dom.append_children(child, &[text]);
        child
    });
    dom.append_children(parent, &children);
    dom.append_children(root, &[parent]);
    drop(dom);
    (
        DomState {
            document,
            started: Instant::now(),
            messages: vec![],
            html_fragment_parser: None,
        },
        parent,
        children,
    )
}

fn describe(state: &mut DomState, id: NodeId) -> Value {
    read_dom(state, Read::Describe { id: Some(raw(id)) }).unwrap()
}

fn snapshot(state: &mut DomState, ids: &[NodeId]) -> Value {
    Value::Array(
        ids.iter()
            .map(|id| {
                json!({
                    "description": describe(state, *id),
                    "text": read_dom(state, Read::Text { id: raw(*id) }).unwrap(),
                })
            })
            .collect(),
    )
}

fn insert(parent: NodeId, child: NodeId, before: Option<NodeId>) -> Mutation {
    Mutation::Insert {
        id: raw(parent),
        child: raw(child),
        before: before.map(raw),
    }
}

fn style(state: &mut DomState, id: NodeId, name: Option<&str>) -> String {
    read_dom(
        state,
        Read::Style {
            id: raw(id),
            name: name.map(str::to_string),
        },
    )
    .unwrap()
    .as_str()
    .unwrap()
    .to_string()
}

fn attribute(state: &mut DomState, id: NodeId, name: &str) -> Value {
    read_dom(
        state,
        Read::Attribute {
            id: raw(id),
            name: name.into(),
        },
    )
    .unwrap()
}

#[test]
fn reordering_detaching_and_reattaching_preserve_node_identity_and_text() {
    let (mut state, parent, [a, b, c]) = fixture();
    assert_eq!(
        mutate_dom(&mut state, insert(parent, c, Some(a))).unwrap(),
        id_value(Some(c))
    );
    assert_eq!(
        describe(&mut state, parent)["children"],
        json!([raw(c), raw(a), raw(b)])
    );
    assert_eq!(describe(&mut state, a)["previousSibling"], raw(c));
    assert_eq!(describe(&mut state, a)["nextSibling"], raw(b));
    let before = snapshot(&mut state, &[parent, a, b, c]);
    mutate_dom(&mut state, insert(parent, a, Some(a))).unwrap();
    assert_eq!(snapshot(&mut state, &[parent, a, b, c]), before);
    mutate_dom(
        &mut state,
        Mutation::Append {
            id: raw(parent),
            child: raw(c),
        },
    )
    .unwrap();
    assert_eq!(
        describe(&mut state, parent)["children"],
        json!([raw(a), raw(b), raw(c)])
    );
    assert_eq!(
        mutate_dom(
            &mut state,
            Mutation::Remove {
                id: raw(parent),
                child: raw(a)
            }
        )
        .unwrap(),
        id_value(Some(a))
    );
    assert_eq!(describe(&mut state, a)["parent"], Value::Null);
    assert_eq!(
        read_dom(&mut state, Read::Text { id: raw(a) }).unwrap(),
        "a"
    );
    mutate_dom(&mut state, insert(parent, a, Some(b))).unwrap();
    assert_eq!(
        describe(&mut state, parent)["children"],
        json!([raw(a), raw(b), raw(c)])
    );
}

#[test]
fn invalid_tree_operations_leave_all_existing_relationships_unchanged() {
    let (mut state, parent, [a, b, c]) = fixture();
    let root = state.document.root_node().id;
    let text = state.document.get_node(a).unwrap().children[0];
    let detached = state
        .document
        .mutate()
        .create_element(QualName::new(None, ns!(html), "aside".into()), vec![]);
    let ids = [root, parent, a, b, c, text, detached];
    let before = snapshot(&mut state, &ids);
    let invalid = [
        insert(a, parent, None),
        insert(text, b, None),
        insert(parent, root, None),
        insert(a, b, Some(c)),
        insert(parent, detached, Some(detached)),
        insert(root, text, None),
        insert(root, detached, None),
        Mutation::Remove {
            id: raw(a),
            child: raw(b),
        },
    ];
    for request in invalid {
        assert!(mutate_dom(&mut state, request).is_err());
        assert_eq!(snapshot(&mut state, &ids), before);
    }
}

#[test]
fn document_allows_comments_and_moving_its_single_existing_root() {
    let (mut state, parent, _) = fixture();
    let root = state.document.root_node().id;
    let comment = state.document.mutate().create_comment_node("kept");
    mutate_dom(&mut state, insert(root, comment, Some(parent))).unwrap();
    mutate_dom(&mut state, insert(root, parent, Some(comment))).unwrap();
    assert_eq!(
        describe(&mut state, root)["children"],
        json!([raw(parent), raw(comment)])
    );
    mutate_dom(&mut state, insert(root, parent, None)).unwrap();
    assert_eq!(
        describe(&mut state, root)["children"],
        json!([raw(comment), raw(parent)])
    );
}

#[test]
fn descriptions_expose_dom_kinds_names_and_namespace_without_layout_boxes() {
    let (mut state, parent, [a, _, _]) = fixture();
    let root = state.document.root_node().id;
    let text = state.document.get_node(a).unwrap().children[0];
    let comment = state.document.mutate().create_comment_node("comment");
    mutate_dom(&mut state, insert(parent, comment, Some(a))).unwrap();
    let element = describe(&mut state, parent);
    assert_eq!(element["tag"], "main");
    assert_eq!(element["nodeType"], 1);
    assert_eq!(element["nodeName"], "MAIN");
    assert_eq!(element["namespace"], capabilities::HTML_NAMESPACE);
    assert_eq!(element["localName"], "main");
    assert_eq!(element["prefix"], Value::Null);
    assert_eq!(describe(&mut state, text)["nodeType"], 3);
    assert_eq!(describe(&mut state, text)["nodeName"], "#text");
    assert_eq!(describe(&mut state, text)["children"], json!([]));
    assert_eq!(describe(&mut state, comment)["nodeType"], 8);
    assert_eq!(describe(&mut state, comment)["nodeName"], "#comment");
    assert_eq!(describe(&mut state, root)["nodeType"], 9);
    assert_eq!(describe(&mut state, root)["parent"], Value::Null);
    assert_eq!(describe(&mut state, root)["namespace"], Value::Null);
    let foreign = state.document.mutate().create_element(
        QualName::new(Some("s".into()), ns!(svg), "linearGradient".into()),
        vec![],
    );
    let foreign_description = describe(&mut state, foreign);
    assert_eq!(foreign_description["nodeName"], "s:linearGradient");
    assert_eq!(foreign_description["localName"], "linearGradient");
    assert_eq!(foreign_description["prefix"], "s");
    assert_eq!(
        foreign_description["namespace"],
        "http://www.w3.org/2000/svg"
    );
    assert_eq!(foreign_description["previousSibling"], Value::Null);
}

#[test]
fn character_data_changes_existing_text_and_comment_payloads_only() {
    let (mut state, parent, [a, _, _]) = fixture();
    let text = state.document.get_node(a).unwrap().children[0];
    let comment = state.document.mutate().create_comment_node("before");
    for id in [text, comment] {
        mutate_dom(
            &mut state,
            Mutation::CharacterData {
                id: raw(id),
                value: "after".into(),
            },
        )
        .unwrap();
        assert_eq!(
            read_dom(&mut state, Read::Text { id: raw(id) }).unwrap(),
            "after"
        );
        mutate_dom(
            &mut state,
            Mutation::Text {
                id: raw(id),
                value: "".into(),
            },
        )
        .unwrap();
        assert_eq!(
            read_dom(&mut state, Read::Text { id: raw(id) }).unwrap(),
            ""
        );
        assert_eq!(describe(&mut state, id)["children"], json!([]));
    }
    assert_eq!(describe(&mut state, text)["parent"], raw(a));
    let before = snapshot(&mut state, &[parent, a, text]);
    assert!(
        mutate_dom(
            &mut state,
            Mutation::CharacterData {
                id: raw(parent),
                value: "invalid".into()
            }
        )
        .is_err()
    );
    assert_eq!(snapshot(&mut state, &[parent, a, text]), before);
}

#[test]
fn text_content_replaces_element_children_but_keeps_detached_subtrees_alive() {
    let (mut state, parent, [a, b, c]) = fixture();
    let root = state.document.root_node().id;
    let text = state.document.get_node(a).unwrap().children[0];
    let before = snapshot(&mut state, &[root, parent, a, b, c, text]);
    mutate_dom(
        &mut state,
        Mutation::Text {
            id: raw(root),
            value: "ignored".into(),
        },
    )
    .unwrap();
    assert_eq!(
        read_dom(&mut state, Read::Text { id: raw(root) }).unwrap(),
        Value::Null
    );
    assert_eq!(snapshot(&mut state, &[root, parent, a, b, c, text]), before);
    mutate_dom(
        &mut state,
        Mutation::Text {
            id: raw(parent),
            value: "replacement".into(),
        },
    )
    .unwrap();
    assert_eq!(
        read_dom(&mut state, Read::Text { id: raw(parent) }).unwrap(),
        "replacement"
    );
    for child in [a, b, c] {
        assert_eq!(describe(&mut state, child)["parent"], Value::Null);
    }
    assert_eq!(describe(&mut state, text)["parent"], raw(a));
    assert_eq!(
        read_dom(&mut state, Read::Text { id: raw(text) }).unwrap(),
        "a"
    );
    let created = mutate_dom(
        &mut state,
        Mutation::CreateText {
            value: "new".into(),
        },
    )
    .unwrap();
    let created = node_id(&state.document, created.as_str().unwrap()).unwrap();
    assert_eq!(describe(&mut state, created)["nodeType"], 3);
    assert_eq!(describe(&mut state, created)["parent"], Value::Null);
    assert_eq!(
        read_dom(&mut state, Read::Text { id: raw(created) }).unwrap(),
        "new"
    );
}

#[test]
fn attribute_removal_updates_id_lookup_and_leaves_other_attributes_intact() {
    let (mut state, parent, _) = fixture();
    for (name, value) in [("id", "retained-id"), ("class", "active")] {
        mutate_dom(
            &mut state,
            Mutation::Attribute {
                id: raw(parent),
                name: name.into(),
                value: value.into(),
            },
        )
        .unwrap();
    }
    assert_eq!(
        read_dom(
            &mut state,
            Read::FindById {
                value: "retained-id".into()
            }
        )
        .unwrap(),
        id_value(Some(parent))
    );
    for _ in 0..2 {
        mutate_dom(
            &mut state,
            Mutation::RemoveAttribute {
                id: raw(parent),
                name: "id".into(),
            },
        )
        .unwrap();
    }
    assert_eq!(attribute(&mut state, parent, "id"), Value::Null);
    assert_eq!(attribute(&mut state, parent, "class"), "active");
    assert_eq!(
        read_dom(
            &mut state,
            Read::FindById {
                value: "retained-id".into()
            }
        )
        .unwrap(),
        Value::Null
    );
}

#[test]
fn cssom_writes_reflect_attributes_ignore_invalid_values_and_remove_properties() {
    let (mut state, parent, _) = fixture();
    mutate_dom(
        &mut state,
        Mutation::StyleText {
            id: raw(parent),
            value: "width: 10px; color: red; --tone: blue; height: invalid".into(),
        },
    )
    .unwrap();
    assert_eq!(style(&mut state, parent, Some("width")), "10px");
    assert_eq!(style(&mut state, parent, Some("height")), "");
    assert_eq!(style(&mut state, parent, Some("--tone")).trim(), "blue");
    assert_eq!(
        attribute(&mut state, parent, "style"),
        style(&mut state, parent, None)
    );
    let before = attribute(&mut state, parent, "style");
    mutate_dom(
        &mut state,
        Mutation::Style {
            id: raw(parent),
            name: "width".into(),
            value: "invalid".into(),
            important: false,
        },
    )
    .unwrap();
    assert_eq!(attribute(&mut state, parent, "style"), before);
    mutate_dom(
        &mut state,
        Mutation::Style {
            id: raw(parent),
            name: "color".into(),
            value: "".into(),
            important: false,
        },
    )
    .unwrap();
    assert_eq!(style(&mut state, parent, Some("color")), "");
    mutate_dom(
        &mut state,
        Mutation::Style {
            id: raw(parent),
            name: "--tone".into(),
            value: "green".into(),
            important: true,
        },
    )
    .unwrap();
    assert_eq!(style(&mut state, parent, Some("--tone")).trim(), "green");
    assert!(
        attribute(&mut state, parent, "style")
            .as_str()
            .unwrap()
            .contains("!important")
    );
    assert_eq!(
        attribute(&mut state, parent, "style"),
        style(&mut state, parent, None)
    );
    mutate_dom(
        &mut state,
        Mutation::RemoveAttribute {
            id: raw(parent),
            name: "style".into(),
        },
    )
    .unwrap();
    assert_eq!(style(&mut state, parent, None), "");
    assert_eq!(style(&mut state, parent, Some("width")), "");
}

#[test]
fn no_op_cssom_mutations_preserve_absent_and_unserialized_style_attributes() {
    let (mut state, parent, _) = fixture();
    for original in [None, Some("color : red;")] {
        if let Some(value) = original {
            mutate_dom(
                &mut state,
                Mutation::Attribute {
                    id: raw(parent),
                    name: "style".into(),
                    value: value.into(),
                },
            )
            .unwrap();
        }
        let before = attribute(&mut state, parent, "style");
        for (name, value) in [("width", ""), ("width", "invalid")] {
            mutate_dom(
                &mut state,
                Mutation::Style {
                    id: raw(parent),
                    name: name.into(),
                    value: value.into(),
                    important: false,
                },
            )
            .unwrap();
            assert_eq!(attribute(&mut state, parent, "style"), before);
        }
        if original.is_some() {
            mutate_dom(
                &mut state,
                Mutation::Style {
                    id: raw(parent),
                    name: "color".into(),
                    value: "red".into(),
                    important: false,
                },
            )
            .unwrap();
            assert_eq!(attribute(&mut state, parent, "style"), before);
        }
    }
}
