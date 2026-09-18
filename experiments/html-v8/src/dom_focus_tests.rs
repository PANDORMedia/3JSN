use super::*;

fn raw(id: NodeId) -> String {
    id.as_u64().to_string()
}

fn fixture() -> (DomState, NodeId) {
    let mut state = DomState {
        document: BaseDocument::new(Default::default()),
        started: Instant::now(),
        messages: vec![],
        html_fragment_parser: None,
    };
    let root = state.document.root_node().id;
    let html = element(&mut state, Some(root), "html", &[]);
    let body = element(&mut state, Some(html), "body", &[]);
    (state, body)
}

fn element(
    state: &mut DomState,
    parent: Option<NodeId>,
    tag: &str,
    attrs: &[(&str, &str)],
) -> NodeId {
    let mut dom = state.document.mutate();
    let id = dom.create_element(QualName::new(None, ns!(html), tag.into()), vec![]);
    for (name, value) in attrs {
        dom.set_attribute(id, attr_name((*name).into()), value);
    }
    if let Some(parent) = parent {
        dom.append_children(parent, &[id]);
    }
    id
}

fn attribute(state: &mut DomState, id: NodeId, name: &str, value: Option<&str>) {
    let request = match value {
        Some(value) => Mutation::Attribute {
            id: raw(id),
            name: name.into(),
            value: value.into(),
        },
        None => Mutation::RemoveAttribute {
            id: raw(id),
            name: name.into(),
        },
    };
    mutate_dom(state, request).unwrap();
}

fn eligibility(state: &mut DomState, id: NodeId) -> Value {
    read_dom(state, Read::Focusability { id: raw(id) }).unwrap()
}

fn focus(state: &mut DomState, id: Option<NodeId>) -> Value {
    mutate_dom(state, Mutation::Focus { id: id.map(raw) }).unwrap()
}

fn expected(programmatic: bool, sequential: bool, tab_index: i32) -> Value {
    json!({ "programmatic": programmatic, "sequential": sequential, "tabIndex": tab_index })
}

#[test]
fn dom_focus_html_attribute_case_does_not_bypass_eligibility() {
    let (mut state, body) = fixture();
    let target = element(&mut state, Some(body), "button", &[]);
    for name in ["DiSaBlEd", "INERT", "hIdDeN"] {
        attribute(&mut state, target, name, Some(""));
        assert_eq!(
            read_dom(
                &mut state,
                Read::Attribute {
                    id: raw(target),
                    name: name.to_ascii_uppercase()
                }
            )
            .unwrap(),
            json!("")
        );
        assert!(
            !eligibility(&mut state, target)["programmatic"]
                .as_bool()
                .unwrap()
        );
        attribute(&mut state, target, &name.to_ascii_lowercase(), None);
        assert!(
            eligibility(&mut state, target)["programmatic"]
                .as_bool()
                .unwrap()
        );
    }
    attribute(&mut state, target, "TaBiNdEx", Some("-1"));
    assert_eq!(eligibility(&mut state, target), expected(true, false, -1));
    attribute(&mut state, target, "TABINDEX", None);
    assert_eq!(eligibility(&mut state, target), expected(true, true, 0));
    let svg = state
        .document
        .mutate()
        .create_element(QualName::new(None, ns!(svg), "svg".into()), vec![]);
    attribute(&mut state, svg, "viewBox", Some("0 0 10 10"));
    assert_eq!(
        read_dom(
            &mut state,
            Read::Attribute {
                id: raw(svg),
                name: "viewBox".into()
            }
        )
        .unwrap(),
        json!("0 0 10 10")
    );
    assert_eq!(
        read_dom(
            &mut state,
            Read::Attribute {
                id: raw(svg),
                name: "viewbox".into()
            }
        )
        .unwrap(),
        Value::Null
    );
}

#[test]
fn dom_focus_navigation_uses_dom_order_from_negative_and_cycles_native_window() {
    let (mut state, body) = fixture();
    let two = element(&mut state, Some(body), "button", &[("tabindex", "2")]);
    let a = element(&mut state, Some(body), "button", &[]);
    let negative = element(&mut state, Some(body), "div", &[("tabindex", "-1")]);
    let one = element(&mut state, Some(body), "button", &[("tabindex", "1")]);
    let zero = element(&mut state, Some(body), "div", &[("tabindex", "0")]);
    let b = element(&mut state, Some(body), "button", &[]);
    let _disabled = element(&mut state, Some(body), "button", &[("disabled", "")]);
    for (from, backward, to) in [
        (None, false, one),
        (None, true, b),
        (Some(one), false, two),
        (Some(two), false, a),
        (Some(a), false, zero),
        (Some(zero), false, b),
        (Some(negative), false, one),
        (Some(negative), true, a),
        (Some(b), false, one),
        (Some(one), true, b),
    ] {
        focus(&mut state, from);
        assert_eq!(
            read_dom(&mut state, Read::FocusNext { backward }).unwrap(),
            id_value(Some(to))
        );
        assert_eq!(read_dom(&mut state, Read::Focused).unwrap(), id_value(from));
    }
}

#[test]
fn dom_focus_removal_preflight_preserves_state_and_checks_errors_first() {
    let (mut state, body) = fixture();
    let parent = element(&mut state, Some(body), "div", &[]);
    let focused = element(&mut state, Some(parent), "button", &[]);
    let other = element(&mut state, Some(body), "div", &[]);
    focus(&mut state, Some(focused));
    for mutation in [
        Mutation::Remove {
            id: raw(parent),
            child: raw(focused),
        },
        Mutation::Append {
            id: raw(other),
            child: raw(parent),
        },
        Mutation::Text {
            id: raw(parent),
            value: "replacement".into(),
        },
    ] {
        assert_eq!(
            read_dom(&mut state, Read::FocusRemoval { mutation }).unwrap(),
            id_value(Some(focused))
        );
        assert_eq!(
            read_dom(&mut state, Read::Focused).unwrap(),
            id_value(Some(focused))
        );
        assert_eq!(
            state.document.get_node(focused).unwrap().parent,
            Some(parent)
        );
    }
    for mutation in [
        Mutation::Remove {
            id: raw(other),
            child: raw(focused),
        },
        Mutation::Append {
            id: raw(focused),
            child: raw(parent),
        },
        Mutation::Insert {
            id: raw(parent),
            child: raw(other),
            before: Some(raw(body)),
        },
        Mutation::Html {
            id: raw(parent),
            value: "<span>replacement</span>".into(),
        },
    ] {
        assert!(read_dom(&mut state, Read::FocusRemoval { mutation }).is_err());
        assert_eq!(
            read_dom(&mut state, Read::Focused).unwrap(),
            id_value(Some(focused))
        );
        assert_eq!(
            state.document.get_node(focused).unwrap().parent,
            Some(parent)
        );
    }
    assert_eq!(
        read_dom(
            &mut state,
            Read::FocusRemoval {
                mutation: Mutation::Text {
                    id: raw(focused),
                    value: "new label".into()
                }
            }
        )
        .unwrap(),
        Value::Null
    );
}

#[test]
fn dom_focus_uses_native_state_and_invalidates_focus_styles() {
    let (mut state, body) = fixture();
    let a = element(&mut state, Some(body), "button", &[]);
    let b = element(&mut state, Some(body), "button", &[]);
    let plain = element(&mut state, Some(body), "div", &[]);
    let detached = element(&mut state, None, "button", &[]);
    state
        .document
        .add_user_agent_stylesheet("button { opacity: 0.25 } button:focus { opacity: 0.75 }");
    assert_eq!(read_dom(&mut state, Read::Focused).unwrap(), Value::Null);
    assert_eq!(focus(&mut state, Some(a)), id_value(Some(a)));
    state.document.resolve(0.0);
    assert_eq!(state.document.resolved_style_value(a, "opacity"), "0.75");
    assert_eq!(state.document.resolved_style_value(b, "opacity"), "0.25");
    assert_eq!(focus(&mut state, Some(plain)), id_value(Some(a)));
    assert_eq!(focus(&mut state, Some(detached)), id_value(Some(a)));
    for invalid in ["invalid", "18446744073709551615"] {
        assert_eq!(
            mutate_dom(
                &mut state,
                Mutation::Focus {
                    id: Some(invalid.into())
                }
            )
            .unwrap(),
            id_value(Some(a))
        );
    }
    assert_eq!(focus(&mut state, Some(b)), id_value(Some(b)));
    state.document.resolve(0.0);
    assert_eq!(state.document.resolved_style_value(a, "opacity"), "0.25");
    assert_eq!(state.document.resolved_style_value(b, "opacity"), "0.75");
    assert_eq!(focus(&mut state, None), Value::Null);
    assert_eq!(read_dom(&mut state, Read::Focused).unwrap(), Value::Null);
    state.document.resolve(0.0);
    assert_eq!(state.document.resolved_style_value(b, "opacity"), "0.25");
}

#[test]
fn dom_focus_tabindex_parses_html_integer_prefixes_and_reflects_long_defaults() {
    let (mut state, body) = fixture();
    let div = element(&mut state, Some(body), "div", &[]);
    for (value, index, programmatic) in [
        (" -1", -1, true),
        ("\t+2suffix", 2, true),
        ("1.5", 1, true),
        ("-0", 0, true),
        ("2147483647", i32::MAX, true),
        ("-2147483648", i32::MIN, true),
        ("2147483648", -1, false),
        ("-2147483649", -1, false),
        ("99999999999999999999999999999", -1, false),
        ("", -1, false),
        ("+ 1", -1, false),
        ("\u{000b}1", -1, false),
        ("\u{00a0}1", -1, false),
    ] {
        attribute(&mut state, div, "tabindex", Some(value));
        assert_eq!(
            eligibility(&mut state, div),
            expected(programmatic, programmatic && index >= 0, index),
            "{value:?}"
        );
    }
    let button = element(&mut state, Some(body), "button", &[("tabindex", "invalid")]);
    assert_eq!(eligibility(&mut state, button), expected(true, true, 0));
    attribute(&mut state, div, "tabindex", None);
    assert_eq!(eligibility(&mut state, div), expected(false, false, -1));
}

#[test]
fn dom_focus_control_and_link_eligibility_rejects_disabled_and_hidden_inputs() {
    let (mut state, body) = fixture();
    for tag in ["button", "input", "select", "textarea"] {
        let id = element(&mut state, Some(body), tag, &[]);
        assert_eq!(
            eligibility(&mut state, id),
            expected(true, true, 0),
            "{tag}"
        );
        for value in ["", "disabled", "false"] {
            attribute(&mut state, id, "disabled", Some(value));
            assert_eq!(eligibility(&mut state, id), expected(false, false, 0));
        }
        attribute(&mut state, id, "disabled", None);
        attribute(&mut state, id, "tabindex", Some("-1"));
        assert_eq!(eligibility(&mut state, id), expected(true, false, -1));
    }
    let link = element(&mut state, Some(body), "a", &[]);
    assert_eq!(eligibility(&mut state, link), expected(false, false, 0));
    attribute(&mut state, link, "href", Some("#target"));
    assert_eq!(eligibility(&mut state, link), expected(true, true, 0));
    let hidden = element(
        &mut state,
        Some(body),
        "input",
        &[("type", "HiDdEn"), ("tabindex", "0")],
    );
    assert_eq!(eligibility(&mut state, hidden), expected(false, false, 0));
    let generic = element(
        &mut state,
        Some(body),
        "div",
        &[("tabindex", "0"), ("disabled", "")],
    );
    assert_eq!(eligibility(&mut state, generic), expected(true, true, 0));
}

#[test]
fn dom_focus_resolves_display_inert_and_overridden_visibility() {
    let (mut state, body) = fixture();
    let parent = element(&mut state, Some(body), "div", &[]);
    let child = element(&mut state, Some(parent), "button", &[]);
    assert_eq!(eligibility(&mut state, child), expected(true, true, 0));
    attribute(&mut state, parent, "style", Some("visibility: hidden"));
    assert_eq!(eligibility(&mut state, child), expected(false, false, 0));
    attribute(&mut state, child, "style", Some("visibility: visible"));
    assert_eq!(eligibility(&mut state, child), expected(true, true, 0));
    attribute(&mut state, parent, "style", Some("display: none"));
    assert_eq!(eligibility(&mut state, child), expected(false, false, 0));
    attribute(&mut state, parent, "style", Some("display: block"));
    assert_eq!(eligibility(&mut state, child), expected(true, true, 0));
    attribute(&mut state, parent, "inert", Some("false"));
    assert_eq!(eligibility(&mut state, child), expected(false, false, 0));
    attribute(&mut state, parent, "inert", None);
    attribute(&mut state, child, "hidden", Some(""));
    assert_eq!(eligibility(&mut state, child), expected(false, false, 0));
    attribute(&mut state, child, "style", Some("display: block"));
    assert_eq!(eligibility(&mut state, child), expected(true, true, 0));
    attribute(&mut state, child, "style", Some("display: contents"));
    assert_eq!(eligibility(&mut state, child), expected(false, false, 0));
    attribute(&mut state, child, "style", Some("display: block"));
    attribute(&mut state, parent, "style", Some("display: contents"));
    attribute(&mut state, parent, "tabindex", Some("0"));
    assert_eq!(eligibility(&mut state, parent), expected(false, false, 0));
    assert_eq!(eligibility(&mut state, child), expected(true, true, 0));
}

#[test]
fn dom_focus_disabled_fieldsets_exempt_only_the_first_legend_subtree() {
    let (mut state, body) = fixture();
    let fieldset = element(&mut state, Some(body), "fieldset", &[("disabled", "")]);
    let first = element(&mut state, Some(fieldset), "legend", &[]);
    let second = element(&mut state, Some(fieldset), "legend", &[]);
    let exempt = element(&mut state, Some(first), "button", &[]);
    let blocked = element(&mut state, Some(second), "button", &[]);
    let ordinary = element(&mut state, Some(fieldset), "input", &[]);
    let generic = element(&mut state, Some(fieldset), "div", &[("tabindex", "0")]);
    assert_eq!(eligibility(&mut state, exempt), expected(true, true, 0));
    assert_eq!(eligibility(&mut state, blocked), expected(false, false, 0));
    assert_eq!(eligibility(&mut state, ordinary), expected(false, false, 0));
    assert_eq!(eligibility(&mut state, generic), expected(true, true, 0));
    let nested = element(&mut state, Some(first), "fieldset", &[("disabled", "")]);
    let nested_input = element(&mut state, Some(nested), "input", &[]);
    assert_eq!(
        eligibility(&mut state, nested_input),
        expected(false, false, 0)
    );
    attribute(&mut state, fieldset, "disabled", None);
    assert_eq!(eligibility(&mut state, blocked), expected(true, true, 0));
}

#[test]
fn dom_focus_candidates_sort_positive_then_natural_in_current_dom_order() {
    let (mut state, body) = fixture();
    let natural = element(&mut state, Some(body), "button", &[]);
    let two_a = element(&mut state, Some(body), "div", &[("tabindex", "2")]);
    let one = element(&mut state, Some(body), "div", &[("tabindex", "1")]);
    let two_b = element(&mut state, Some(body), "button", &[("tabindex", "2")]);
    let zero = element(&mut state, Some(body), "div", &[("tabindex", "0")]);
    element(&mut state, Some(body), "button", &[("tabindex", "-1")]);
    element(
        &mut state,
        Some(body),
        "button",
        &[("tabindex", "1"), ("disabled", "")],
    );
    element(
        &mut state,
        Some(body),
        "button",
        &[("style", "display: none")],
    );
    assert_eq!(
        read_dom(&mut state, Read::FocusCandidates).unwrap(),
        json!([raw(one), raw(two_a), raw(two_b), raw(natural), raw(zero)])
    );
    mutate_dom(
        &mut state,
        Mutation::Insert {
            id: raw(body),
            child: raw(two_b),
            before: Some(raw(two_a)),
        },
    )
    .unwrap();
    assert_eq!(
        read_dom(&mut state, Read::FocusCandidates).unwrap(),
        json!([raw(one), raw(two_b), raw(two_a), raw(natural), raw(zero)])
    );
}

#[test]
fn dom_focus_subtree_removal_clears_focus_without_invalidating_retained_nodes() {
    let (mut state, body) = fixture();
    let parent = element(&mut state, Some(body), "div", &[]);
    let button = element(&mut state, Some(parent), "button", &[]);
    assert_eq!(focus(&mut state, Some(button)), id_value(Some(button)));
    mutate_dom(
        &mut state,
        Mutation::Remove {
            id: raw(body),
            child: raw(parent),
        },
    )
    .unwrap();
    assert_eq!(read_dom(&mut state, Read::Focused).unwrap(), Value::Null);
    assert!(state.document.get_node(button).is_some());
    assert_eq!(eligibility(&mut state, button), expected(false, false, 0));
    mutate_dom(
        &mut state,
        Mutation::Append {
            id: raw(body),
            child: raw(parent),
        },
    )
    .unwrap();
    assert_eq!(focus(&mut state, Some(button)), id_value(Some(button)));
    mutate_dom(
        &mut state,
        Mutation::Text {
            id: raw(parent),
            value: String::new(),
        },
    )
    .unwrap();
    assert_eq!(read_dom(&mut state, Read::Focused).unwrap(), Value::Null);
    assert!(state.document.get_node(button).is_some());
}
