use blitz_dom::{BaseDocument, DocumentConfig, NodeId, qual_name};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};

const ROOT: &str = "position:static;left:auto;top:auto;margin:0;border:0;padding:0;width:auto;height:auto;transform:none;";
const ROOT_BOX: &str =
    "margin:12px;border:6px solid #333333;padding:10px;width:300px;height:144px;";
const PERCENTAGES: &str =
    "position:absolute;left:25%;right:auto;top:25%;bottom:auto;width:25%;height:25%;";

fn style(doc: &mut BaseDocument, id: NodeId, css: &str) {
    doc.mutate().set_attribute(id, qual_name!("style"), css);
}

fn fixture() -> (BaseDocument, [NodeId; 4]) {
    let mut doc = HtmlDocument::from_html(
        include_str!("../../../fixtures/initial-containing-block/index.html"),
        DocumentConfig {
            viewport: Some(Viewport::new(448, 256, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
    .into_inner();
    for (id, css) in [
        ("root", ROOT),
        (
            "body",
            "margin:0;border:0;padding:0;width:auto;height:auto;",
        ),
        ("outer", "position:static;width:320px;height:60px;"),
        (
            "middle",
            "position:static;box-sizing:border-box;margin-left:24px;padding-top:12px;width:200px;height:60px;",
        ),
        ("spacer", "display:block;width:8px;height:24px;"),
        (
            "subject",
            "position:absolute;left:24px;top:auto;bottom:0;width:96px;height:24px;",
        ),
    ] {
        let node = doc.get_element_by_id(id).unwrap();
        style(&mut doc, node, css);
    }
    let ids = ["root", "outer", "middle", "subject"].map(|id| doc.get_element_by_id(id).unwrap());
    (doc, ids)
}

fn rect(doc: &BaseDocument, id: NodeId) -> [f64; 4] {
    let rect = doc.get_client_bounding_rect(id).unwrap();
    [rect.x, rect.y, rect.width, rect.height]
}

#[test]
fn viewport_owner_does_not_replace_short_or_tall_document_geometry() {
    let (mut doc, [root, outer, _, subject]) = fixture();
    doc.resolve(0.0);
    assert_eq!(rect(&doc, root), [0.0, 0.0, 448.0, 60.0]);
    assert_eq!(rect(&doc, subject), [24.0, 232.0, 96.0, 24.0]);

    doc.mutate().set_style_property(outer, "height", "384px");
    doc.resolve(0.0);
    assert_eq!(rect(&doc, root), [0.0, 0.0, 448.0, 384.0]);
    assert_eq!(rect(&doc, subject), [24.0, 232.0, 96.0, 24.0]);

    style(
        &mut doc,
        subject,
        "position:fixed;left:240px;top:16px;bottom:16px;width:48px;height:auto;",
    );
    doc.resolve(0.0);
    assert_eq!(rect(&doc, subject), [240.0, 16.0, 48.0, 224.0]);
    assert_eq!(rect(&doc, root), [0.0, 0.0, 448.0, 384.0]);
}

#[test]
fn decorated_root_owns_absolute_only_when_positioned_and_does_not_own_fixed() {
    let (mut doc, [root, outer, middle, subject]) = fixture();
    style(&mut doc, root, &format!("{ROOT}{ROOT_BOX}"));
    style(&mut doc, subject, PERCENTAGES);
    doc.resolve(0.0);
    assert_eq!(rect(&doc, root), [12.0, 12.0, 332.0, 176.0]);
    assert_eq!(rect(&doc, subject), [112.0, 64.0, 112.0, 64.0]);

    style(
        &mut doc,
        root,
        &format!("{ROOT}{ROOT_BOX}position:relative;left:8px;top:6px;"),
    );
    doc.resolve(0.0);
    assert_eq!(rect(&doc, subject), [106.0, 65.0, 80.0, 41.0]);

    for (id, left, top) in [(outer, "8px", "6px"), (middle, "12px", "10px")] {
        doc.mutate().set_style_property(id, "position", "relative");
        doc.mutate().set_style_property(id, "left", left);
        doc.mutate().set_style_property(id, "top", top);
    }
    doc.mutate()
        .set_style_property(subject, "position", "fixed");
    doc.resolve(0.0);
    assert_eq!(rect(&doc, subject), [112.0, 64.0, 112.0, 64.0]);
}

#[test]
fn out_of_flow_root_has_an_external_owner_and_never_paints_itself_as_a_child() {
    let (mut doc, [root, _, _, subject]) = fixture();
    for (root_position, subject_position) in [("absolute", "absolute"), ("fixed", "fixed")] {
        style(
            &mut doc,
            root,
            &format!("{ROOT}{ROOT_BOX}position:{root_position};left:20px;top:16px;"),
        );
        style(
            &mut doc,
            subject,
            &format!("{PERCENTAGES}position:{subject_position};"),
        );
        doc.resolve(0.0);
        let node = doc.get_node(root).unwrap();
        assert_ne!(node.layout_parent.get(), Some(root));
        assert!(
            !node
                .paint_children
                .borrow()
                .iter()
                .flatten()
                .any(|child| *child == root)
        );
        assert!(
            !node
                .stacking_context
                .iter()
                .flat_map(|context| &context.children)
                .any(|child| child.node_id == root)
        );
        if subject_position == "absolute" {
            assert_eq!(&rect(&doc, subject)[2..], &[80.0, 41.0]);
        } else {
            assert_eq!(rect(&doc, subject), [112.0, 64.0, 112.0, 64.0]);
        }
    }
}

#[test]
fn cached_viewport_owner_tracks_resize_scale_and_content_mutations() {
    let (mut doc, [_, outer, _, subject]) = fixture();
    style(&mut doc, subject, PERCENTAGES);
    for (width, height, scale, expected) in [
        (448, 256, 1.0, [112.0, 64.0, 112.0, 64.0]),
        (640, 384, 1.0, [160.0, 96.0, 160.0, 96.0]),
        (1280, 768, 2.0, [160.0, 96.0, 160.0, 96.0]),
        (448, 256, 1.0, [112.0, 64.0, 112.0, 64.0]),
    ] {
        doc.set_viewport(Viewport::new(width, height, scale, ColorScheme::Light));
        for height in ["60px", "384px", "60px"] {
            doc.mutate().set_style_property(outer, "height", height);
            doc.resolve(0.0);
            assert_eq!(rect(&doc, subject), expected);
            doc.resolve(0.0);
            assert_eq!(rect(&doc, subject), expected, "unchanged cached resolve");
        }
    }
}

#[test]
fn auto_anchor_moves_with_flow_while_percentage_size_stays_viewport_relative() {
    let (mut doc, [root, _, _, subject]) = fixture();
    style(
        &mut doc,
        subject,
        "position:absolute;left:auto;right:auto;top:auto;bottom:auto;width:25%;height:24px;",
    );
    for (root_style, expected) in [
        (ROOT.to_owned(), [24.0, 36.0, 112.0, 24.0]),
        (format!("{ROOT}{ROOT_BOX}"), [52.0, 64.0, 112.0, 24.0]),
        (ROOT.to_owned(), [24.0, 36.0, 112.0, 24.0]),
    ] {
        style(&mut doc, root, &root_style);
        doc.resolve(0.0);
        assert_eq!(rect(&doc, subject), expected);
        assert_eq!(doc.get_element_by_id("subject"), Some(subject));
    }
}

#[test]
fn transformed_root_fixed_sizes_follow_root_until_transform_is_removed() {
    let (mut doc, [root, _, _, subject]) = fixture();
    style(
        &mut doc,
        root,
        &format!("{ROOT}{ROOT_BOX}transform:translate(12px,8px);"),
    );
    style(&mut doc, subject, &format!("{PERCENTAGES}position:fixed;"));
    doc.resolve(0.0);
    // Ownership is observed through the percentage basis. Transformed CSSOM
    // x/y coordinates are a separate known failure and are not asserted here.
    assert_eq!(&rect(&doc, subject)[2..], &[80.0, 41.0]);

    doc.mutate().set_style_property(root, "width", "380px");
    doc.mutate().set_style_property(root, "height", "184px");
    doc.resolve(0.0);
    assert_eq!(&rect(&doc, subject)[2..], &[100.0, 51.0]);

    doc.set_viewport(Viewport::new(640, 384, 1.0, ColorScheme::Light));
    doc.resolve(0.0);
    assert_eq!(&rect(&doc, subject)[2..], &[100.0, 51.0]);

    doc.mutate().set_style_property(root, "transform", "none");
    doc.resolve(0.0);
    assert_eq!(rect(&doc, subject), [160.0, 96.0, 160.0, 96.0]);
}
