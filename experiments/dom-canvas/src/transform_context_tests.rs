use blitz_dom::{BaseDocument, DocumentConfig, NodeId, qual_name};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};

const HTML: &str = include_str!("../../../fixtures/transform-context/hit.html");
const STATES: [(&str, bool); 19] = [
    ("transform:none", false),
    ("transform:translate(0px)", true),
    ("transform:translate(8px,6px)", true),
    ("transform:none", false),
    ("transform:matrix(1,0,0,1,0,0)", true),
    ("transform:none", false),
    ("translate:0px", true),
    ("translate:8px 6px", true),
    ("translate:none", false),
    ("rotate:0deg", true),
    ("rotate:5deg", true),
    ("rotate:none", false),
    ("scale:1", true),
    ("scale:1.1", true),
    ("scale:none", false),
    ("perspective:600px", true),
    ("perspective:none", false),
    ("transform-style:preserve-3d", true),
    ("transform-style:flat", false),
];

fn document(html: &str) -> BaseDocument {
    HtmlDocument::from_html(
        html,
        DocumentConfig {
            viewport: Some(Viewport::new(448, 256, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
    .into_inner()
}

fn fixture(html: &str, negative_z: bool) -> (BaseDocument, [NodeId; 3]) {
    let mut doc = document(html);
    let ids = ["host", "subject", "peer"].map(|id| doc.get_element_by_id(id).unwrap());
    if negative_z {
        for id in [ids[1], ids[2]] {
            doc.mutate().set_style_property(id, "z-index", "-1");
        }
    }
    (doc, ids)
}

fn context_children(doc: &BaseDocument, owner: NodeId) -> Vec<NodeId> {
    doc.get_node(owner)
        .unwrap()
        .stacking_context
        .as_ref()
        .map(|context| context.children.iter().map(|entry| entry.node_id).collect())
        .unwrap_or_default()
}

fn assert_ownership_and_hit(
    doc: &BaseDocument,
    [host, subject, peer]: [NodeId; 3],
    context: bool,
    negative_z: bool,
    label: &str,
) {
    assert_eq!(
        doc.get_node(host).unwrap().stacking_context.is_some(),
        context,
        "host ownership: {label}"
    );
    let root_children = context_children(doc, doc.root_element().id);
    let host_children = context_children(doc, host);
    assert_eq!(
        root_children.iter().filter(|&&id| id == subject).count(),
        usize::from(!context),
        "subject's root-list membership: {label}"
    );
    assert_eq!(
        host_children,
        if context { vec![subject] } else { vec![] },
        "subject's local-list membership: {label}"
    );
    assert_eq!(
        root_children.iter().filter(|&&id| id == peer).count(),
        1,
        "peer must stay in root context: {label}"
    );
    let expected_hit = if context == negative_z { subject } else { peer };
    assert_eq!(
        doc.element_from_point(32.0, 32.0),
        Some(expected_hit),
        "observable hit order: {label}"
    );
}

fn verify_sequence(negative_z: bool) {
    let (mut doc, ids) = fixture(HTML, negative_z);
    for cycle in 0..3 {
        for (css, context) in STATES {
            doc.mutate().set_attribute(ids[0], qual_name!("style"), css);
            for sample in 0..2 {
                doc.resolve(0.0);
                assert_ownership_and_hit(
                    &doc,
                    ids,
                    context,
                    negative_z,
                    &format!("{css}; cycle={cycle}, sample={sample}"),
                );
            }
        }
    }
}

#[test]
fn positive_descendant_stops_escaping_on_first_resolve_and_resets() {
    verify_sequence(false);
}

#[test]
fn negative_descendant_stays_in_its_transform_context_on_first_resolve_and_resets() {
    verify_sequence(true);
}

#[test]
fn initially_authored_transforms_own_descendants_without_a_warm_resolve() {
    for (css, context) in STATES {
        let html = HTML.replacen(
            "<div id=\"host\">",
            &format!("<div id=\"host\" style=\"{css}\">"),
            1,
        );
        let (mut doc, ids) = fixture(&html, false);
        doc.resolve(0.0);
        assert_ownership_and_hit(&doc, ids, context, false, css);
    }
}

#[test]
fn transform_context_classification_respects_supported_css_box_applicability() {
    let mut doc = document(
        r#"<html><body style="margin:0">
        <div id="block" style="display:block"></div>
        <span id="inline" style="display:inline"></span>
        <span id="inline-block" style="display:inline-block"></span>
        <canvas id="replaced-inline" style="display:inline;width:20px;height:20px"></canvas>
        <input id="image-input" type="image" style="display:inline;width:20px;height:20px">
        <button id="inline-button" style="display:inline;width:20px;height:20px"></button>
        <textarea id="textarea" style="width:20px;height:20px"></textarea>
        <div id="contents" style="display:contents"></div>
        <div id="none" style="display:none"></div>
        <table><colgroup id="column-group"><col id="column"></colgroup>
          <tbody><tr id="row"><td id="cell"></td></tr></tbody>
        </table>
        </body></html>"#,
    );
    let controls = [
        ("block", true),
        ("inline", false),
        ("inline-block", true),
        ("replaced-inline", true),
        ("image-input", true),
        ("inline-button", true),
        ("textarea", true),
        ("contents", false),
        ("none", false),
        ("column", false),
        ("column-group", false),
        ("row", true),
        ("cell", true),
    ]
    .map(|(name, transformable)| (name, doc.get_element_by_id(name).unwrap(), transformable));

    // These controls test applicability separately from the shared overlap
    // fixture; inline fragments and table columns have different paint paths.
    for _ in 0..2 {
        for (css, context) in STATES {
            let (property, value) = css.split_once(':').unwrap();
            for (_, id, _) in controls {
                for property in ["transform", "translate", "rotate", "scale", "perspective"] {
                    doc.mutate().set_style_property(id, property, "none");
                }
                doc.mutate()
                    .set_style_property(id, "transform-style", "flat");
                doc.mutate().set_style_property(id, property, value);
            }
            for sample in 0..2 {
                doc.resolve(0.0);
                for (name, id, transformable) in controls {
                    assert_eq!(
                        doc.get_node(id).unwrap().is_stacking_context_root(false),
                        context && transformable,
                        "{name}, {css}, sample={sample}"
                    );
                }
            }
        }
    }
}

#[test]
fn preserve_3d_keeps_context_when_overflow_forces_flattening() {
    let (mut doc, ids) = fixture(HTML, false);
    for _ in 0..3 {
        for (css, context) in [
            ("transform-style:preserve-3d;overflow:hidden", true),
            ("transform-style:flat;overflow:hidden", false),
        ] {
            doc.mutate().set_attribute(ids[0], qual_name!("style"), css);
            for _ in 0..2 {
                doc.resolve(0.0);
                assert_ownership_and_hit(&doc, ids, context, false, css);
            }
        }
    }
}
