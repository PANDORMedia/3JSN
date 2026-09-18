use blitz_dom::{BaseDocument, DocumentConfig, NodeId};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};

fn fixture(z_index: &str) -> (BaseDocument, NodeId, NodeId, NodeId) {
    let mut doc = HtmlDocument::from_html(
        include_str!("../../../fixtures/paint-order/hit.html"),
        DocumentConfig {
            viewport: Some(Viewport::new(448, 256, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
    .into_inner();
    let body = doc.get_element_by_id("body").unwrap();
    let earlier = doc.get_element_by_id("earlier").unwrap();
    let later = doc.get_element_by_id("later").unwrap();
    for id in [earlier, later] {
        doc.mutate().set_style_property(id, "z-index", z_index);
    }
    (doc, body, earlier, later)
}

fn verify_reordering(z_index: &str) {
    let (mut doc, body, earlier, later) = fixture(z_index);
    for _ in 0..3 {
        doc.mutate().append_children(body, &[later]);
        for _ in 0..2 {
            doc.resolve(0.0);
            assert_eq!(doc.element_from_point(80.0, 70.0), Some(later));
            assert_eq!(doc.element_from_point(50.0, 45.0), Some(earlier));
            assert_eq!(doc.element_from_point(164.0, 120.0), Some(later));
        }
        doc.mutate().append_children(body, &[earlier]);
        doc.resolve(0.0);
        assert_eq!(doc.element_from_point(80.0, 70.0), Some(earlier));
        assert_eq!(doc.element_from_point(164.0, 120.0), Some(later));
    }
}

#[test]
fn positive_z_hit_targets_follow_order_across_geometry_owners() {
    verify_reordering("1");
}

#[test]
fn negative_z_hit_targets_follow_order_across_geometry_owners() {
    // Transparent backgrounds still take hits; pointer-events:none on ancestors
    // lets this test observe the two explicitly interactive negative-z boxes.
    verify_reordering("-1");
}
