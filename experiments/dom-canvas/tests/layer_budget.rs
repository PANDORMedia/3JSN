use anyrender::{PaintScene, Scene, recording::RenderCommand};
use blitz_dom::{BaseDocument, DocumentConfig, Widget, node::ComputedStyles};
use blitz_html::HtmlDocument;
use blitz_paint::{PaintErrorKind, PaintLayerKind, PaintLimits, PaintStats};
use blitz_traits::shell::{ColorScheme, Viewport};
use vello::kurbo::{Affine, Rect};

fn html_document(body: &str) -> HtmlDocument {
    HtmlDocument::from_html(
        &format!("<html><body style='margin:0'>{body}</body></html>"),
        DocumentConfig {
            viewport: Some(Viewport::new(448, 256, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
}

fn paint(
    doc: &mut BaseDocument,
    limits: PaintLimits,
) -> (Scene, Result<PaintStats, blitz_paint::PaintError>) {
    let mut scene = Scene::new();
    let result = blitz_paint::paint_scene(&mut scene, doc, 1.0, 448, 256, 0, 0, limits);
    assert_balanced(&scene);
    (scene, result)
}

fn assert_balanced(scene: &Scene) {
    let mut depth = 0;
    for command in &scene.commands {
        match command {
            RenderCommand::PushLayer(_) | RenderCommand::PushClipLayer(_) => depth += 1,
            RenderCommand::PopLayer => {
                assert!(depth > 0);
                depth -= 1;
            }
            _ => {}
        }
    }
    assert_eq!(depth, 0, "the host can discard a balanced failed scene");
}

#[test]
fn wide_opacity_siblings_use_total_budget_not_peak_depth() {
    let mut doc = html_document(
        "<div id='a' style='opacity:.5;width:10px;height:10px;background:red'></div>\
         <div id='b' style='opacity:.5;width:10px;height:10px;background:red'></div>\
         <div id='c' style='opacity:.5;width:10px;height:10px;background:red'></div>",
    )
    .into_inner();
    doc.resolve(0.0);
    let expected = PaintStats {
        total_layers: 3,
        peak_layer_depth: 1,
    };
    assert_eq!(
        paint(
            &mut doc,
            PaintLimits {
                max_total_layers: 3,
                max_layer_depth: 1
            }
        )
        .1
        .unwrap(),
        expected
    );
    let error = paint(
        &mut doc,
        PaintLimits {
            max_total_layers: 2,
            max_layer_depth: 1,
        },
    )
    .1
    .unwrap_err();
    assert_eq!(
        error.kind,
        PaintErrorKind::TotalLayerLimit {
            attempted: 3,
            layer: PaintLayerKind::Effect
        }
    );
    assert_eq!(error.location.document_id, doc.id());
    assert_eq!(error.location.node_id, doc.get_element_by_id("c"));
    assert_eq!(
        error.stats,
        PaintStats {
            total_layers: 2,
            peak_layer_depth: 1
        }
    );
    assert_eq!(
        paint(&mut doc, PaintLimits::default()).1.unwrap(),
        expected,
        "a failed paint must not poison the next frame"
    );
}

#[test]
fn nested_opacity_rejects_depth_without_exhausting_total_budget() {
    let mut doc = html_document(
        "<div style='opacity:.5;width:100px;height:100px'><div style='opacity:.5;width:80px;height:80px'>\
         <div id='deep' style='opacity:.5;width:40px;height:40px;background:red'></div></div></div>",
    ).into_inner();
    doc.resolve(0.0);
    let error = paint(
        &mut doc,
        PaintLimits {
            max_total_layers: 20,
            max_layer_depth: 2,
        },
    )
    .1
    .unwrap_err();
    assert_eq!(
        error.kind,
        PaintErrorKind::LayerDepthLimit {
            attempted: 3,
            layer: PaintLayerKind::Effect
        }
    );
    assert_eq!(error.location.node_id, doc.get_element_by_id("deep"));
    assert_eq!(
        error.stats,
        PaintStats {
            total_layers: 2,
            peak_layer_depth: 2
        }
    );
    assert_eq!(
        paint(
            &mut doc,
            PaintLimits {
                max_total_layers: 3,
                max_layer_depth: 3
            }
        )
        .1
        .unwrap(),
        PaintStats {
            total_layers: 3,
            peak_layer_depth: 3
        }
    );
}

#[test]
fn direct_css_mask_and_inset_shadow_layers_are_counted() {
    for style in [
        "mask-image:linear-gradient(black,black)",
        "box-shadow:inset 0 0 4px 2px black",
    ] {
        let mut doc = html_document(&format!(
            "<div id='subject' style='width:100px;height:100px;background:red;{style}'></div>"
        ))
        .into_inner();
        doc.resolve(0.0);
        let stats = paint(&mut doc, PaintLimits::default()).1.unwrap();
        assert!(stats.total_layers >= 2, "{style}: {stats:?}");
        let error = paint(
            &mut doc,
            PaintLimits {
                max_total_layers: stats.total_layers - 1,
                max_layer_depth: 1024,
            },
        )
        .1
        .unwrap_err();
        assert!(
            matches!(error.kind, PaintErrorKind::TotalLayerLimit { .. }),
            "{style}"
        );
        assert_eq!(error.location.node_id, doc.get_element_by_id("subject"));
    }
}

#[test]
fn nested_documents_share_one_budget_and_report_the_inner_document() {
    let mut doc = html_document("<div style='opacity:.5'><iframe id='frame' style='display:block;border:0;width:200px;height:150px'></iframe></div>").into_inner();
    let mut inner = html_document(
        "<div style='opacity:.5;width:20px;height:20px'></div><div id='last' style='opacity:.5;width:20px;height:20px'></div>",
    );
    inner.as_mut().resolve(0.0);
    let inner_id = inner.as_ref().id();
    let last = inner.as_ref().get_element_by_id("last");
    let iframe = doc.get_element_by_id("frame").unwrap();
    doc.mutate().set_sub_document(iframe, Box::new(inner));
    doc.resolve(0.0);
    let stats = paint(&mut doc, PaintLimits::default()).1.unwrap();
    assert!(stats.total_layers >= 3, "{stats:?}");
    let error = paint(
        &mut doc,
        PaintLimits {
            max_total_layers: stats.total_layers - 1,
            max_layer_depth: 1024,
        },
    )
    .1
    .unwrap_err();
    assert_eq!(error.location.document_id, inner_id);
    assert_eq!(error.location.node_id, last);
    assert_eq!(error.stats.total_layers, stats.total_layers - 1);
}

struct LayeredWidget;
impl Widget for LayeredWidget {
    fn paint(
        &mut self,
        _: &mut dyn anyrender::RenderContext,
        _: &ComputedStyles,
        _: u32,
        _: u32,
        _: f64,
    ) -> Scene {
        let mut scene = Scene::new();
        for _ in 0..3 {
            scene.push_clip_layer(Affine::IDENTITY, &Rect::new(0.0, 0.0, 20.0, 20.0));
        }
        for _ in 0..3 {
            scene.pop_layer();
        }
        scene
    }
}

#[test]
fn custom_widget_recorded_scene_cannot_bypass_layer_limits() {
    let mut doc = html_document(
        "<canvas id='widget' style='display:block;width:100px;height:100px'></canvas>",
    )
    .into_inner();
    let id = doc.get_element_by_id("widget").unwrap();
    doc.mutate().set_custom_widget(id, Box::new(LayeredWidget));
    doc.resolve(0.0);
    let error = paint(
        &mut doc,
        PaintLimits {
            max_total_layers: 20,
            max_layer_depth: 2,
        },
    )
    .1
    .unwrap_err();
    assert_eq!(
        error.kind,
        PaintErrorKind::LayerDepthLimit {
            attempted: 3,
            layer: PaintLayerKind::Clip
        }
    );
    assert_eq!(error.location.node_id, Some(id));
    assert_eq!(
        paint(&mut doc, PaintLimits::default())
            .1
            .unwrap()
            .peak_layer_depth,
        3
    );
}
