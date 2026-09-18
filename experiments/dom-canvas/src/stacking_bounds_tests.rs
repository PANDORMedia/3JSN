use blitz_dom::{BaseDocument, DocumentConfig, NodeId, qual_name};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};

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

fn context_bounds(doc: &BaseDocument, owner: NodeId) -> [f32; 4] {
    let bounds = doc
        .get_node(owner)
        .unwrap()
        .stacking_context
        .as_ref()
        .unwrap()
        .content_area;
    [bounds.left, bounds.top, bounds.right, bounds.bottom]
}

#[test]
fn first_resolve_relative_stacking_children_have_current_hit_bounds() {
    for negative in [false, true] {
        let mut doc = document(include_str!("../../../fixtures/transform-context/hit.html"));
        let subject = doc.get_element_by_id("subject").unwrap();
        let peer = doc.get_element_by_id("peer").unwrap();
        if negative {
            for id in [subject, peer] {
                doc.mutate().set_style_property(id, "z-index", "-1");
            }
        }
        doc.resolve(0.0);
        assert_eq!(
            context_bounds(&doc, doc.root_element().id),
            [0.0, 0.0, 128.0, 80.0],
            "first layout must replace initial zero bounds"
        );
        assert_eq!(
            doc.element_from_point(32.0, 32.0),
            Some(if negative { peer } else { subject })
        );
    }
}

#[test]
fn relative_stacking_child_move_and_resize_refresh_bounds_in_the_same_resolve() {
    let mut doc = document(
        r#"<html style="margin:0;pointer-events:none"><body style="margin:0">
        <div id="host" style="position:relative;z-index:0;width:400px;height:240px">
          <div id="subject" style="position:relative;z-index:2;width:40px;height:30px;pointer-events:auto"></div>
        </div></body></html>"#,
    );
    let host = doc.get_element_by_id("host").unwrap();
    let subject = doc.get_element_by_id("subject").unwrap();
    for _ in 0..3 {
        for (left, top, width, height) in [
            (0.0, 0.0, 40.0, 30.0),
            (100.0, 80.0, 80.0, 60.0),
            (220.0, 150.0, 24.0, 18.0),
        ] {
            doc.mutate().set_attribute(
                subject,
                qual_name!("style"),
                &format!(
                    "position:relative;z-index:2;pointer-events:auto;left:{left}px;top:{top}px;width:{width}px;height:{height}px"
                ),
            );
            for sample in 0..2 {
                doc.resolve(0.0);
                assert_eq!(
                    context_bounds(&doc, host),
                    [left, top, left + width, top + height],
                    "location={left},{top}; size={width},{height}; sample={sample}"
                );
                assert_eq!(
                    doc.element_from_point(left + width / 2.0, top + height / 2.0),
                    Some(subject),
                    "hit must see the current box, sample={sample}"
                );
                assert_ne!(
                    doc.element_from_point(left + width + 4.0, top + height / 2.0),
                    Some(subject),
                    "the old larger box must not remain hittable"
                );
            }
        }
    }
}
