use blitz_dom::{BaseDocument, DocumentConfig, NodeId, qual_name};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};

const ZERO: [f64; 4] = [0.0; 4];

fn fixture() -> (BaseDocument, NodeId, NodeId, NodeId, NodeId) {
    let mut doc = HtmlDocument::from_html(
        r#"<!doctype html><html><body id="body" style="margin:0">
        <div id="parent" style="position:absolute;left:20px;top:30px;width:100px;height:80px">
          <div id="contents" style="display:contents">
            <div id="child" style="position:absolute;left:3px;top:4px;width:10px;height:12px"></div>
          </div>
        </div></body></html>"#,
        DocumentConfig {
            viewport: Some(Viewport::new(448, 256, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
    .into_inner();
    let ids = ["body", "parent", "contents", "child"].map(|id| doc.get_element_by_id(id).unwrap());
    doc.resolve(0.0);
    (doc, ids[0], ids[1], ids[2], ids[3])
}

// BoundingRect is not re-exported by Blitz; inspect the public query's fields
// without depending on its private module path or introducing another DOM type.
fn bounds(doc: &BaseDocument, id: NodeId) -> Option<[f64; 4]> {
    doc.get_client_bounding_rect(id)
        .map(|rect| [rect.x, rect.y, rect.width, rect.height])
}

fn fragments(doc: &BaseDocument, id: NodeId) -> Vec<[f64; 4]> {
    doc.node_client_rects(id)
        .into_iter()
        .map(|rect| [rect.x, rect.y, rect.width, rect.height])
        .collect()
}

fn assert_no_box(doc: &BaseDocument, id: NodeId) {
    assert!(!doc.get_node(id).unwrap().has_boxes());
    assert_eq!(bounds(doc, id), Some(ZERO));
    assert!(fragments(doc, id).is_empty());
}

#[test]
fn hidden_ancestor_suppresses_retained_descendant_geometry_and_restore_recovers_it() {
    let (mut doc, _, parent, contents, child) = fixture();
    let before = bounds(&doc, child).unwrap();
    assert_eq!(&before[2..], &[10.0, 12.0]);

    doc.mutate().set_style_property(parent, "display", "none");
    doc.resolve(0.0);
    for id in [parent, contents, child] {
        assert_no_box(&doc, id);
    }
    doc.mutate().set_style_property(parent, "display", "block");
    doc.resolve(0.0);
    assert_eq!(bounds(&doc, child), Some(before));
    assert_eq!(fragments(&doc, child), vec![before]);

    doc.mutate().set_style_property(child, "display", "none");
    doc.resolve(0.0);
    assert_no_box(&doc, child);
    assert!(doc.get_node(parent).unwrap().has_boxes());
}

#[test]
fn contents_are_boxless_without_suppressing_nested_descendants() {
    let (mut doc, _, parent, contents, child) = fixture();
    assert_no_box(&doc, contents);
    assert!(doc.get_node(child).unwrap().has_boxes());
    assert_eq!(fragments(&doc, child).len(), 1);
    doc.mutate()
        .set_style_property(parent, "display", "contents");
    doc.resolve(0.0);
    assert_no_box(&doc, parent);
    assert_no_box(&doc, contents);
    let rect = bounds(&doc, child).unwrap();
    assert_eq!(&rect[2..], &[10.0, 12.0]);
    assert_eq!(fragments(&doc, child), vec![rect]);
}

#[test]
fn retained_detached_subtree_has_zero_geometry_until_reattached() {
    let (mut doc, body, parent, contents, child) = fixture();
    let before = bounds(&doc, child).unwrap();
    doc.mutate().remove_node(parent);
    doc.resolve(0.0);
    for id in [parent, contents, child] {
        assert_no_box(&doc, id);
    }
    doc.mutate().append_children(body, &[parent]);
    doc.resolve(0.0);
    assert_eq!(bounds(&doc, child), Some(before));
    assert_eq!(fragments(&doc, child), vec![before]);

    let detached = doc.mutate().create_element(qual_name!("div", html), vec![]);
    doc.resolve(0.0);
    assert_no_box(&doc, detached);
    let missing = NodeId::from_u64(u64::MAX);
    assert_eq!(bounds(&doc, missing), None);
    assert!(fragments(&doc, missing).is_empty());
}

#[test]
fn invisible_and_zero_sized_boxes_keep_their_geometry() {
    let (mut doc, _, parent, _, child) = fixture();
    let before = bounds(&doc, child).unwrap();
    for (property, value) in [("visibility", "hidden"), ("opacity", "0")] {
        doc.mutate().set_style_property(parent, property, value);
        doc.resolve(0.0);
        assert_eq!(bounds(&doc, child), Some(before));
        assert_eq!(fragments(&doc, child), vec![before]);
    }

    doc.mutate()
        .set_style_property(parent, "overflow", "hidden");
    doc.mutate().set_style_property(child, "left", "5000px");
    doc.resolve(0.0);
    let clipped = bounds(&doc, child).unwrap();
    assert!(clipped[0] > 448.0);
    assert_eq!(&clipped[2..], &[10.0, 12.0]);
    assert_eq!(fragments(&doc, child), vec![clipped]);
    doc.mutate().set_style_property(child, "left", "3px");
    doc.mutate().set_style_property(child, "width", "0px");
    doc.mutate().set_style_property(child, "height", "0px");
    doc.resolve(0.0);
    let zero_size = [before[0], before[1], 0.0, 0.0];
    assert!(zero_size[0] != 0.0 && zero_size[1] != 0.0);
    assert_eq!(bounds(&doc, child), Some(zero_size));
    assert_eq!(fragments(&doc, child), vec![zero_size]);

    doc.mutate().set_style_property(child, "left", "-5000px");
    doc.resolve(0.0);
    let offscreen = bounds(&doc, child).unwrap();
    assert!(offscreen[0] < 0.0);
    assert_eq!(fragments(&doc, child), vec![offscreen]);
}

#[test]
fn inline_fragments_survive_hide_restore_and_empty_lists_have_zero_bounds() {
    let mut doc = HtmlDocument::from_html(
        r#"<!doctype html><html><body style="margin:0"><div id="parent" style="position:absolute;left:20px;top:30px;width:100px;font-size:0;line-height:0"><span id="inline"><span id="box" style="display:inline-block;width:17px;height:13px;vertical-align:top"></span></span><span id="empty"></span></div></body></html>"#,
        DocumentConfig {
            viewport: Some(Viewport::new(448, 256, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
    .into_inner();
    let [parent, inline, inline_box, empty] =
        ["parent", "inline", "box", "empty"].map(|id| doc.get_element_by_id(id).unwrap());
    doc.resolve(0.0);

    let initial_fragments = doc
        .inline_fragment_rects(inline)
        .expect("the inline wrapper must exercise the fragment query");
    assert_eq!(initial_fragments.len(), 1);
    let before = bounds(&doc, inline).unwrap();
    assert_eq!(&before[2..], &[17.0, 13.0]);
    assert_eq!(fragments(&doc, inline), vec![before]);
    assert_eq!(bounds(&doc, inline_box), Some(before));

    // This checks the empty fragment result, without asserting that upstream
    // fragment generation covers every browser inline-layout case.
    assert!(doc.inline_fragment_rects(empty).unwrap().is_empty());
    assert_eq!(bounds(&doc, empty), Some(ZERO));
    assert!(fragments(&doc, empty).is_empty());

    doc.mutate().set_style_property(parent, "display", "none");
    doc.resolve(0.0);
    for id in [parent, inline, inline_box, empty] {
        assert_no_box(&doc, id);
    }

    doc.mutate().set_style_property(parent, "display", "block");
    doc.resolve(0.0);
    assert_eq!(bounds(&doc, inline), Some(before));
    assert_eq!(fragments(&doc, inline), vec![before]);
    assert_eq!(bounds(&doc, inline_box), Some(before));
    assert!(doc.inline_fragment_rects(empty).unwrap().is_empty());
    assert_eq!(bounds(&doc, empty), Some(ZERO));
    assert!(fragments(&doc, empty).is_empty());
}
