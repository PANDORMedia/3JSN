use blitz_dom::{BaseDocument, DocumentConfig, NodeId, qual_name};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};

#[derive(Clone, Copy)]
enum Scenario {
    GridStaticAnchor,
    GridOwnerArea,
}

const STATIC_ANCHOR: [f64; 4] = [76.0, 136.0, 160.0, 24.0];
const GRID_OWNER: [f64; 4] = [144.0, 104.0, 104.0, 32.0];

fn fixture() -> (BaseDocument, NodeId, NodeId) {
    let doc = HtmlDocument::from_html(
        include_str!("../../../fixtures/positioned-layout/index.html"),
        DocumentConfig {
            viewport: Some(Viewport::new(448, 256, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
    .into_inner();
    let outer = doc.get_element_by_id("outer").unwrap();
    let subject = doc.get_element_by_id("subject").unwrap();
    (doc, outer, subject)
}

fn prepare(doc: &mut BaseDocument, scenario: Scenario) {
    let base = [
        (
            "outer",
            "position:absolute;left:32px;top:24px;width:320px;height:176px;",
        ),
        (
            "bridge",
            "position:static;box-sizing:border-box;width:100%;height:100%;padding:16px 24px;",
        ),
        ("middle", "position:static;width:120px;height:80px;"),
        ("spacer", "display:none;width:8px;height:28px;"),
        (
            "subject",
            "position:absolute;left:150px;top:100px;width:50%;height:32px;",
        ),
    ];
    let overrides = match scenario {
        Scenario::GridStaticAnchor => [
            "",
            "",
            "display:grid;width:200px;height:120px;grid-template-columns:60px 100px;grid-template-rows:32px 64px;gap:8px;justify-items:center;align-items:end;",
            "",
            "left:auto;top:auto;height:24px;grid-column:2;grid-row:2;",
        ],
        Scenario::GridOwnerArea => [
            "display:grid;grid-template-columns:96px 192px;grid-template-rows:64px 88px;gap:16px;",
            "",
            "",
            "",
            "left:0;top:0;grid-column:2;grid-row:2;",
        ],
    };
    for ((id, base), extra) in base.into_iter().zip(overrides) {
        let node = doc.get_element_by_id(id).unwrap();
        doc.mutate()
            .set_attribute(node, qual_name!("style"), &format!("{base}{extra}"));
    }
}

fn assert_subject(doc: &BaseDocument, subject: NodeId, expected: [f64; 4]) {
    let rect = doc.get_client_bounding_rect(subject).unwrap();
    let observed = [rect.x, rect.y, rect.width, rect.height];
    for (actual, expected) in observed.into_iter().zip(expected) {
        assert!(
            (actual - expected).abs() < 0.01,
            "subject rectangle {observed:?} does not match expected coordinate {expected}"
        );
    }
    let fragments = doc.node_client_rects(subject);
    assert_eq!(fragments.len(), 1);
    let fragment = &fragments[0];
    assert_eq!(
        [fragment.x, fragment.y, fragment.width, fragment.height],
        observed
    );
}

#[test]
fn grid_owner_to_block_does_not_reuse_old_grid_area() {
    let (mut doc, _, subject) = fixture();
    for (scenario, expected) in [
        (Scenario::GridStaticAnchor, STATIC_ANCHOR),
        (Scenario::GridOwnerArea, GRID_OWNER),
        (Scenario::GridStaticAnchor, STATIC_ANCHOR),
    ] {
        prepare(&mut doc, scenario);
        doc.resolve(0.0);
        assert_subject(&doc, subject, expected);
    }
}

#[test]
fn block_after_grid_keeps_css_geometry_through_repeats_and_dpi_changes() {
    let (mut doc, _, subject) = fixture();
    prepare(&mut doc, Scenario::GridOwnerArea);
    doc.resolve(0.0);
    assert_subject(&doc, subject, GRID_OWNER);
    prepare(&mut doc, Scenario::GridStaticAnchor);

    for scale in [1, 1, 2, 2, 1] {
        doc.set_viewport(Viewport::new(
            448 * scale,
            256 * scale,
            scale as f32,
            ColorScheme::Light,
        ));
        doc.resolve(0.0);
        assert_subject(&doc, subject, STATIC_ANCHOR);
    }
}

#[test]
fn restored_grid_keeps_tracks_across_repeats_and_updates_them_on_mutation() {
    let (mut doc, outer, subject) = fixture();
    for (scenario, expected) in [
        (Scenario::GridOwnerArea, GRID_OWNER),
        (Scenario::GridStaticAnchor, STATIC_ANCHOR),
        (Scenario::GridOwnerArea, GRID_OWNER),
    ] {
        prepare(&mut doc, scenario);
        doc.resolve(0.0);
        assert_subject(&doc, subject, expected);
    }
    for _ in 0..3 {
        doc.resolve(0.0);
        assert_subject(&doc, subject, GRID_OWNER);
    }

    // With an automatic end line, column 2 starts at 64 + 16 and ends at
    // the 320px padding edge: 50% resolves against the remaining 240px.
    doc.mutate()
        .set_style_property(outer, "grid-template-columns", "64px 224px");
    doc.resolve(0.0);
    assert_subject(&doc, subject, [112.0, 104.0, 120.0, 32.0]);
    doc.resolve(0.0);
    assert_subject(&doc, subject, [112.0, 104.0, 120.0, 32.0]);

    doc.mutate()
        .set_style_property(outer, "grid-template-columns", "96px 192px");
    doc.resolve(0.0);
    assert_subject(&doc, subject, GRID_OWNER);
}
