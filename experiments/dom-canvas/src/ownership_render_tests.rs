use std::cell::Cell;
use std::rc::Rc;

use anyrender::{Paint, PaintScene, Scene, recording::RenderCommand};
use blitz_dom::geometry::contains_nonzero;
use blitz_dom::paint_ownership::PaintOwnershipIssue;
use blitz_dom::{BaseDocument, DocumentConfig, Widget, node::ComputedStyles};
use blitz_html::HtmlDocument;
use blitz_paint::{OwnershipPaintError, OwnershipPaintIssue, PaintLimits};
use blitz_traits::shell::{ColorScheme, Viewport};
use vello::kurbo::{Affine, BezPath, Point, Rect, Shape};
use vello::peniko::{Color, Fill};

const RED: [u8; 4] = [224, 32, 48, 255];
const BLUE: [u8; 4] = [32, 96, 224, 255];
const GREEN: [u8; 4] = [32, 160, 96, 255];
const PURPLE: [u8; 4] = [144, 32, 224, 255];
const GOLD: [u8; 4] = [224, 160, 32, 255];

fn document(body: &str) -> BaseDocument {
    HtmlDocument::from_html(
        &format!(
            "<html id='root' style='margin:0;padding:0;background:white'>\
             <body id='body' style='margin:0;padding:0;width:448px;height:256px'>{body}</body></html>"
        ),
        DocumentConfig {
            viewport: Some(Viewport::new(448, 256, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
    .into_inner()
}

fn paint(doc: &mut BaseDocument, scale: f64, offset: (u32, u32)) -> Scene {
    let mut scene = Scene::new();
    blitz_paint::paint_scene_with_ownership(
        &mut scene,
        doc,
        scale,
        (448.0 * scale) as u32,
        (256.0 * scale) as u32,
        offset.0,
        offset.1,
        PaintLimits::default(),
    )
    .expect("the supported control must paint without a legacy fallback");
    assert_balanced(&scene);
    scene
}

fn assert_balanced(scene: &Scene) {
    let mut depth = 0;
    for command in &scene.commands {
        match command {
            RenderCommand::PushLayer(_) | RenderCommand::PushClipLayer(_) => depth += 1,
            RenderCommand::PopLayer => {
                assert!(depth > 0, "scene layer underflow");
                depth -= 1;
            }
            _ => {}
        }
    }
    assert_eq!(depth, 0, "scene layers must balance");
}

#[derive(Clone, Debug)]
struct Layer {
    command: usize,
    alpha: f32,
    transform: Affine,
    clip: BezPath,
}

#[derive(Debug)]
struct Marker {
    command: usize,
    color: [u8; 4],
    bounds: Rect,
    layers: Vec<Layer>,
}

impl Marker {
    fn opacity_layers(&self) -> Vec<usize> {
        self.layers
            .iter()
            .filter(|layer| layer.alpha < 1.0)
            .map(|layer| layer.command)
            .collect()
    }

    fn covers_point_after_clips(&self, point: Point) -> bool {
        self.bounds.contains(point)
            && self
                .layers
                .iter()
                .all(|layer| contains_nonzero(&layer.clip, layer.transform.inverse() * point))
    }
}

fn markers(scene: &Scene) -> Vec<Marker> {
    let mut layers = Vec::new();
    let mut result = Vec::new();
    for (index, command) in scene.commands.iter().enumerate() {
        match command {
            RenderCommand::PushLayer(layer) => layers.push(Layer {
                command: index,
                alpha: layer.alpha,
                transform: layer.transform,
                clip: layer.clip.clone(),
            }),
            RenderCommand::PushClipLayer(layer) => layers.push(Layer {
                command: index,
                alpha: 1.0,
                transform: layer.transform,
                clip: layer.clip.clone(),
            }),
            RenderCommand::PopLayer => {
                layers.pop().expect("balanced scene");
            }
            RenderCommand::Fill(fill) => {
                if let Paint::Solid(color) = &fill.brush {
                    result.push(Marker {
                        command: index,
                        color: color.to_rgba8().to_u8_array(),
                        bounds: fill
                            .transform
                            .transform_rect_bbox(fill.shape.bounding_box()),
                        layers: layers.clone(),
                    });
                }
            }
            _ => {}
        }
    }
    result
}

fn one(markers: &[Marker], color: [u8; 4]) -> &Marker {
    let matches: Vec<_> = markers
        .iter()
        .filter(|marker| marker.color == color)
        .collect();
    assert_eq!(
        matches.len(),
        1,
        "expected one {color:?} fill, got {matches:?}"
    );
    matches[0]
}

fn assert_rect(actual: Rect, expected: Rect) {
    for (actual, expected) in [
        (actual.x0, expected.x0),
        (actual.y0, expected.y0),
        (actual.x1, expected.x1),
        (actual.y1, expected.y1),
    ] {
        assert!((actual - expected).abs() < 0.001, "{actual} != {expected}");
    }
}

struct MarkerWidget(Rc<Cell<usize>>);

impl Widget for MarkerWidget {
    fn paint(
        &mut self,
        _: &mut dyn anyrender::RenderContext,
        _: &ComputedStyles,
        _: u32,
        _: u32,
        scale: f64,
    ) -> Scene {
        self.0.set(self.0.get() + 1);
        let mut scene = Scene::new();
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            Color::from_rgb8(32, 160, 96),
            None,
            &Rect::new(0.0, 0.0, 80.0 * scale, 64.0 * scale),
        );
        scene
    }
}

#[test]
fn negative_context_precedes_owners_widget_then_zero_and_positive_restore() {
    let mut doc = document(
        "<div id='owner' style='position:relative;left:32px;top:24px;z-index:0;width:160px;height:112px;background:#2060e0'>\
         <div id='negative' style='position:absolute;left:16px;top:16px;z-index:-1;width:128px;height:64px;background:#e02030'></div>\
         <div style='position:absolute;left:32px;top:32px;z-index:0;width:64px;height:48px;background:#9020e0'></div>\
         <div style='position:absolute;left:48px;top:48px;z-index:2;width:64px;height:48px;background:#e0a020'></div></div>",
    );
    let owner = doc.get_element_by_id("owner").unwrap();
    let negative = doc.get_element_by_id("negative").unwrap();
    let calls = Rc::new(Cell::new(0));
    doc.mutate()
        .set_custom_widget(owner, Box::new(MarkerWidget(calls.clone())));
    for (index, z) in ["-1", "3", "-1"].into_iter().enumerate() {
        doc.mutate().set_style_property(negative, "z-index", z);
        doc.resolve(0.0);
        let scene = paint(&mut doc, 1.0, (0, 0));
        let markers = markers(&scene);
        let sequence: Vec<_> = if z == "-1" {
            [BLUE, RED, GREEN, PURPLE, GOLD]
                .map(|color| one(&markers, color).command)
                .into()
        } else {
            [BLUE, GREEN, PURPLE, GOLD, RED]
                .map(|color| one(&markers, color).command)
                .into()
        };
        assert!(
            sequence.windows(2).all(|pair| pair[0] < pair[1]),
            "{sequence:?}"
        );
        assert_eq!(
            calls.get(),
            index + 1,
            "own widget must paint once per frame"
        );
        assert_rect(
            one(&markers, RED).bounds,
            Rect::new(48.0, 40.0, 176.0, 104.0),
        );
    }
}

fn overflow_document(position: &str) -> BaseDocument {
    document(&format!(
        "<div style='position:absolute;left:32px;top:24px;width:128px;height:80px;overflow:hidden'>\
         <div id='effect' style='opacity:.5;width:160px;height:112px;background:#2060e0'>\
         <div id='subject' style='{position};width:128px;height:64px;background:#e02030'></div></div></div>"
    ))
}

#[test]
fn one_opacity_group_keeps_per_contribution_clips_and_restores() {
    let mut doc = overflow_document("position:fixed;left:128px;top:72px");
    let subject = doc.get_element_by_id("subject").unwrap();
    for position in ["fixed", "relative", "fixed"] {
        doc.mutate()
            .set_style_property(subject, "position", position);
        doc.mutate().set_style_property(
            subject,
            "left",
            if position == "fixed" { "128px" } else { "96px" },
        );
        doc.mutate().set_style_property(
            subject,
            "top",
            if position == "fixed" { "72px" } else { "48px" },
        );
        doc.resolve(0.0);
        let scene = paint(&mut doc, 1.0, (0, 0));
        let markers = markers(&scene);
        let red = one(&markers, RED);
        let blue = one(&markers, BLUE);
        assert_eq!(red.opacity_layers().len(), 1);
        assert_eq!(
            red.opacity_layers(),
            blue.opacity_layers(),
            "one atomic group, not opacity per leaf"
        );
        assert!(
            red.layers
                .iter()
                .filter(|layer| layer.alpha < 1.0)
                .all(|layer| layer.alpha == 0.5)
        );
        assert_rect(red.bounds, Rect::new(128.0, 72.0, 256.0, 136.0));
        assert!(
            blue.covers_point_after_clips(Point::new(48.0, 40.0)),
            "position={position}, blue={blue:?}"
        );
        assert!(!blue.covers_point_after_clips(Point::new(176.0, 80.0)));
        assert!(red.covers_point_after_clips(Point::new(144.0, 88.0)));
        assert_eq!(
            red.covers_point_after_clips(Point::new(208.0, 88.0)),
            position == "fixed"
        );
    }
}

#[test]
fn hidden_ancestor_does_not_cull_explicitly_visible_descendant() {
    let mut doc = document(
        "<div id='owner' style='position:relative;width:160px;height:112px;background:#2060e0'>\
         <div style='position:absolute;left:16px;top:16px;width:128px;height:64px;background:#e02030;visibility:visible'></div></div>",
    );
    let owner = doc.get_element_by_id("owner").unwrap();
    for visibility in ["visible", "hidden", "visible"] {
        doc.mutate()
            .set_style_property(owner, "visibility", visibility);
        doc.resolve(0.0);
        let scene = paint(&mut doc, 1.0, (0, 0));
        let markers = markers(&scene);
        assert!(one(&markers, RED).covers_point_after_clips(Point::new(32.0, 32.0)));
        assert_eq!(
            markers.iter().filter(|marker| marker.color == BLUE).count(),
            usize::from(visibility == "visible")
        );
    }
}

#[test]
fn opacity_bounds_keep_fixed_content_when_owner_moves_offscreen_or_becomes_empty() {
    let mut doc = document(
        "<div id='effect' style='position:absolute;opacity:.5'>\
         <div style='position:fixed;left:128px;top:72px;width:128px;height:64px;background:#e02030'></div></div>",
    );
    let effect = doc.get_element_by_id("effect").unwrap();
    for (left, top, width, height) in [
        (32, 24, 160, 112),
        (632, 424, 160, 112),
        (32, 24, 0, 0),
        (32, 24, 160, 112),
    ] {
        for (property, value) in [
            ("left", left),
            ("top", top),
            ("width", width),
            ("height", height),
        ] {
            doc.mutate()
                .set_style_property(effect, property, &format!("{value}px"));
        }
        doc.resolve(0.0);
        let scene = paint(&mut doc, 1.0, (0, 0));
        let markers = markers(&scene);
        let red = one(&markers, RED);
        assert_eq!(red.opacity_layers().len(), 1);
        for point in [Point::new(129.0, 73.0), Point::new(255.0, 135.0)] {
            assert!(
                red.covers_point_after_clips(point),
                "owner {left},{top} {width}x{height} clips {point:?}"
            );
        }
    }
}

#[test]
fn nested_opacity_keeps_both_groups_around_escaping_fixed_content() {
    let mut doc = document(
        "<div style='position:absolute;left:32px;top:24px;width:128px;height:80px;overflow:hidden'>\
         <div style='opacity:.5;width:160px;height:112px;background:#2060e0'>\
         <div style='opacity:.5;width:160px;height:112px'>\
         <div style='position:fixed;left:128px;top:72px;width:128px;height:64px;background:#e02030'></div></div></div></div>",
    );
    doc.resolve(0.0);
    let scene = paint(&mut doc, 1.0, (0, 0));
    let markers = markers(&scene);
    let red = one(&markers, RED);
    let blue = one(&markers, BLUE);
    assert_eq!(blue.opacity_layers().len(), 1);
    assert_eq!(red.opacity_layers().len(), 2);
    assert_eq!(red.opacity_layers()[0], blue.opacity_layers()[0]);
    assert!(
        red.layers
            .iter()
            .filter(|layer| layer.alpha < 1.0)
            .all(|layer| layer.alpha == 0.5)
    );
    assert!(red.covers_point_after_clips(Point::new(208.0, 120.0)));
}

#[test]
fn root_compensation_device_scale_and_scene_offset_apply_once() {
    let mut doc = document(
        "<div style='position:relative;left:24px;top:20px'>\
         <div style='position:fixed;left:64px;top:40px;width:128px;height:64px;background:#e02030'></div></div>",
    );
    let root = doc.get_element_by_id("root").unwrap();
    for (property, value) in [
        ("position", "relative"),
        ("left", "8px"),
        ("top", "6px"),
        ("margin", "12px"),
        ("border", "6px solid #333333"),
        ("padding", "10px"),
        ("width", "300px"),
        ("height", "144px"),
    ] {
        doc.mutate().set_style_property(root, property, value);
    }
    for scale in [1.0_f64, 2.0, 1.0] {
        doc.set_viewport(Viewport::new(
            (448.0 * scale) as u32,
            (256.0 * scale) as u32,
            scale as f32,
            ColorScheme::Light,
        ));
        doc.resolve(0.0);
        let scene = paint(&mut doc, scale, (7, 9));
        let markers = markers(&scene);
        let red = one(&markers, RED);
        assert_rect(
            red.bounds,
            Rect::new(
                7.0 + 64.0 * scale,
                9.0 + 40.0 * scale,
                7.0 + 192.0 * scale,
                9.0 + 104.0 * scale,
            ),
        );
        assert!(red.covers_point_after_clips(Point::new(7.0 + 128.0 * scale, 9.0 + 72.0 * scale)));
    }
}

#[test]
fn planar_transform_captures_fixed_geometry_and_restores_without_double_prefix() {
    let mut doc = document(
        "<div id='owner' style='position:absolute;left:32px;top:24px;width:160px;height:112px;transform-origin:0 0'>\
         <div style='position:fixed;left:16px;top:16px;width:128px;height:64px;background:#e02030'></div></div>",
    );
    let owner = doc.get_element_by_id("owner").unwrap();
    for (transform, expected) in [
        ("none", Rect::new(16.0, 16.0, 144.0, 80.0)),
        (
            "translate(20px,12px) scale(1.5)",
            Rect::new(76.0, 60.0, 268.0, 156.0),
        ),
        ("none", Rect::new(16.0, 16.0, 144.0, 80.0)),
    ] {
        doc.mutate()
            .set_style_property(owner, "transform", transform);
        doc.resolve(0.0);
        let scene = paint(&mut doc, 1.0, (0, 0));
        assert_rect(one(&markers(&scene), RED).bounds, expected);
    }
}

#[test]
fn root_rgba_and_propagated_body_background_each_emit_once_and_restore() {
    let mut doc = document("");
    let root = doc.get_element_by_id("root").unwrap();
    let body = doc.get_element_by_id("body").unwrap();
    for (property, value) in [
        ("width", "80px"),
        ("height", "48px"),
        ("margin", "20px"),
        ("background", "#2060e0"),
    ] {
        doc.mutate().set_style_property(body, property, value);
    }
    for root_color in ["rgba(224,32,48,0.5)", "transparent", "rgba(224,32,48,0.5)"] {
        doc.mutate()
            .set_style_property(root, "background", root_color);
        doc.resolve(0.0);
        let scene = paint(&mut doc, 1.0, (0, 0));
        let markers = markers(&scene);
        if root_color == "transparent" {
            assert_rect(
                one(&markers, BLUE).bounds,
                Rect::new(0.0, 0.0, 448.0, 256.0),
            );
            assert!(
                !markers
                    .iter()
                    .any(|marker| marker.color == [224, 32, 48, 128])
            );
        } else {
            let root_background = one(&markers, [224, 32, 48, 128]);
            assert_rect(root_background.bounds, Rect::new(0.0, 0.0, 448.0, 256.0));
            let body_background = one(&markers, BLUE);
            assert_rect(body_background.bounds, Rect::new(20.0, 20.0, 100.0, 68.0));
            assert!(root_background.command < body_background.command);
        }
    }
}

#[test]
fn canvas_body_propagation_distinguishes_visibility_from_missing_box() {
    let mut doc = document("");
    let root = doc.get_element_by_id("root").unwrap();
    let body = doc.get_element_by_id("body").unwrap();
    doc.mutate()
        .set_style_property(root, "background", "transparent");
    doc.mutate()
        .set_style_property(body, "background", "#2060e0");
    for (display, visibility, paints_canvas) in [
        ("block", "visible", true),
        ("block", "hidden", true),
        ("none", "visible", false),
        ("block", "visible", true),
    ] {
        doc.mutate().set_style_property(body, "display", display);
        doc.mutate()
            .set_style_property(body, "visibility", visibility);
        doc.resolve(0.0);
        let scene = paint(&mut doc, 1.0, (0, 0));
        let markers = markers(&scene);
        if paints_canvas {
            assert_rect(
                one(&markers, BLUE).bounds,
                Rect::new(0.0, 0.0, 448.0, 256.0),
            );
        } else {
            assert!(!markers.iter().any(|marker| marker.color == BLUE));
        }
    }
}

fn rejected(doc: &mut BaseDocument) -> OwnershipPaintError {
    let mut scene = Scene::new();
    let error = blitz_paint::paint_scene_with_ownership(
        &mut scene,
        doc,
        1.0,
        448,
        256,
        0,
        0,
        PaintLimits::default(),
    )
    .unwrap_err();
    assert!(
        scene.commands.is_empty(),
        "eligibility failure must precede scene commands"
    );
    error
}

#[test]
fn unsupported_root_effect_and_canvas_images_fail_before_any_background() {
    let mut doc = document("");
    let root = doc.get_element_by_id("root").unwrap();
    let body = doc.get_element_by_id("body").unwrap();
    doc.mutate()
        .set_style_property(root, "background", "rgba(224,32,48,0.5)");
    doc.mutate().set_style_property(root, "opacity", "0.5");
    doc.resolve(0.0);
    let error = rejected(&mut doc);
    assert!(
        matches!(error, OwnershipPaintError::Unsupported { node, issue: OwnershipPaintIssue::UnsupportedRootEffect } if node == root),
        "{error:?}"
    );

    doc.mutate().set_style_property(root, "opacity", "1");
    doc.mutate()
        .set_style_property(root, "background-image", "linear-gradient(red,blue)");
    doc.resolve(0.0);
    let error = rejected(&mut doc);
    assert!(
        matches!(error, OwnershipPaintError::Unsupported { node, issue: OwnershipPaintIssue::UnsupportedCanvasBackground } if node == root),
        "{error:?}"
    );

    doc.mutate()
        .set_style_property(root, "background", "transparent");
    doc.mutate()
        .set_style_property(body, "background-image", "linear-gradient(red,blue)");
    doc.resolve(0.0);
    let error = rejected(&mut doc);
    assert!(
        matches!(error, OwnershipPaintError::Unsupported { node, issue: OwnershipPaintIssue::UnsupportedCanvasBackground } if node == body),
        "{error:?}"
    );

    doc.mutate()
        .set_style_property(body, "background", "#2060e0");
    doc.resolve(0.0);
    let scene = paint(&mut doc, 1.0, (0, 0));
    assert_rect(
        one(&markers(&scene), BLUE).bounds,
        Rect::new(0.0, 0.0, 448.0, 256.0),
    );
}

#[test]
fn unsupported_text_filter_3d_and_scroll_fail_explicitly_before_drawing() {
    for (html, expected) in [
        (
            "<div id='unsupported'>unshaped</div>",
            OwnershipPaintIssue::UnsupportedInline,
        ),
        (
            "<div id='unsupported' style='width:40px;height:40px;background:#e02030;filter:blur(1px)'></div>",
            OwnershipPaintIssue::UnsupportedEffect,
        ),
    ] {
        let mut doc = document(html);
        doc.resolve(0.0);
        let error = rejected(&mut doc);
        assert!(
            matches!(error, OwnershipPaintError::Unsupported { issue, .. } if issue == expected),
            "{error:?}"
        );
    }
    let mut doc = document(
        "<div style='transform:rotateY(30deg);width:80px;height:40px;background:#e02030'></div>",
    );
    doc.resolve(0.0);
    let error = rejected(&mut doc);
    assert!(
        matches!(error, OwnershipPaintError::Plan(ref error) if error.issue == PaintOwnershipIssue::UnsupportedTransform),
        "{error:?}"
    );

    let mut doc = document(
        "<div id='scroller' style='width:80px;height:40px;overflow:auto'><div style='height:200px;background:#e02030'></div></div>",
    );
    doc.resolve(0.0);
    let scroller = doc.get_element_by_id("scroller").unwrap();
    doc.get_node_mut(scroller).unwrap().scroll_offset_mut().y = 1.0;
    let error = rejected(&mut doc);
    assert!(
        matches!(error, OwnershipPaintError::Plan(ref error) if error.issue == PaintOwnershipIssue::UnsupportedScroll),
        "{error:?}"
    );
}

#[test]
fn ownership_budget_failure_balances_and_does_not_poison_next_scene() {
    let mut doc = overflow_document("position:fixed;left:128px;top:72px");
    doc.resolve(0.0);
    let mut failed = Scene::new();
    let error = blitz_paint::paint_scene_with_ownership(
        &mut failed,
        &mut doc,
        1.0,
        448,
        256,
        0,
        0,
        PaintLimits {
            max_total_layers: 0,
            max_layer_depth: 0,
        },
    )
    .unwrap_err();
    assert!(matches!(error, OwnershipPaintError::Budget(_)), "{error:?}");
    assert_balanced(&failed);
    let scene = paint(&mut doc, 1.0, (0, 0));
    assert!(one(&markers(&scene), RED).covers_point_after_clips(Point::new(208.0, 88.0)));
}

#[path = "ownership_render/clip_contract_tests.rs"]
mod clip_contract_tests;

#[path = "ownership_render/replaced_content_tests.rs"]
mod replaced_content_tests;

#[path = "ownership_render/output_clip_tests.rs"]
mod output_clip_tests;

#[path = "ownership_render/css_rect_effect_tests.rs"]
mod css_rect_effect_tests;

#[test]
fn propagated_canvas_background_stays_outside_root_clip() {
    let mut doc = document("<div style='width:160px;height:112px;background:#e02030'></div>");
    let root = doc.get_element_by_id("root").unwrap();
    let body = doc.get_element_by_id("body").unwrap();
    doc.mutate().set_style_property(body, "height", "112px");
    doc.mutate()
        .set_style_property(root, "clip-path", "inset(0)");
    doc.resolve(0.0);
    let scene = paint(&mut doc, 1.0, (0, 0));
    let markers = markers(&scene);
    let canvas = one(&markers, [255, 255, 255, 255]);
    assert!(canvas.layers.is_empty());
    assert!(canvas.covers_point_after_clips(Point::new(224.0, 200.0)));
    assert!(!one(&markers, RED).layers.is_empty());
}

#[test]
fn boxless_body_canvas_propagation_is_explicitly_unsupported_and_recovers() {
    let mut doc = document("<div style='width:64px;height:64px;background:#e02030'></div>");
    let root = doc.get_element_by_id("root").unwrap();
    let body = doc.get_element_by_id("body").unwrap();
    doc.mutate()
        .set_style_property(root, "background", "transparent");
    doc.mutate()
        .set_style_property(body, "background", "#2060e0");
    doc.resolve(0.0);
    let baseline = paint(&mut doc, 1.0, (0, 0));
    doc.mutate().set_style_property(body, "display", "contents");
    doc.resolve(0.0);
    assert!(
        matches!(rejected(&mut doc), OwnershipPaintError::Unsupported {
        node, issue: OwnershipPaintIssue::UnsupportedCanvasBackground
    } if node == body)
    );
    doc.mutate().set_style_property(body, "display", "block");
    doc.resolve(0.0);
    assert_eq!(paint(&mut doc, 1.0, (0, 0)), baseline);
}

#[test]
fn unavailable_replaced_content_rejects_independently_of_build_features() {
    for element in [
        "<svg id='unsupported' style='position:absolute;width:64px;height:64px'><rect width='64' height='64' fill='red'/></svg>",
        "<video id='unsupported' style='position:absolute;width:64px;height:64px'></video>",
        "<iframe id='unsupported' style='position:absolute;width:64px;height:64px'></iframe>",
    ] {
        let mut doc = document(element);
        let id = doc.get_element_by_id("unsupported").unwrap();
        doc.resolve(0.0);
        let error = rejected(&mut doc);
        assert!(
            matches!(error, OwnershipPaintError::Unsupported {
            node, issue: OwnershipPaintIssue::UnsupportedContent
        } if node == id),
            "{error:?}"
        );
    }
    let mut doc = document("<canvas style='position:absolute;width:64px;height:64px'></canvas>");
    doc.resolve(0.0);
    paint(&mut doc, 1.0, (0, 0));
}
