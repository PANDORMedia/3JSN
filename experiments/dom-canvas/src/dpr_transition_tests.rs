use anyrender::{Paint, Scene, recording::RenderCommand};
use blitz_dom::{BaseDocument, DocumentConfig, Node};
use blitz_html::HtmlDocument;
use blitz_paint::PaintLimits;
use blitz_traits::shell::{ColorScheme, Viewport};
use vello::kurbo::{Rect, Shape};

const RED: [u8; 4] = [224, 32, 48, 255];
const BLUE: [u8; 4] = [32, 96, 224, 255];
const GREEN: [u8; 4] = [32, 160, 96, 255];
const DPR_SEQUENCE: [f64; 4] = [1.0, 2.0, 2.0, 1.0];
const OFFSET: (u32, u32) = (7, 9);

fn viewport(scale: f64) -> Viewport {
    Viewport::new(
        (448.0 * scale) as u32,
        (256.0 * scale) as u32,
        scale as f32,
        ColorScheme::Light,
    )
}

fn document(children: &str) -> BaseDocument {
    HtmlDocument::from_html(
        &format!(
            "<html style='margin:0;padding:0;background:white'>\
             <body style='margin:0;padding:0;width:448px;height:256px'>\
             <div id='ancestor' style='position:absolute;left:32px;top:24px;width:64px;height:32px;background:#2060e0'>{children}</div>\
             </body></html>"
        ),
        DocumentConfig {
            viewport: Some(viewport(1.0)),
            ..Default::default()
        },
    )
    .into_inner()
}

fn node<'a>(doc: &'a BaseDocument, name: &str) -> &'a Node {
    doc.get_node(doc.get_element_by_id(name).expect("fixture element"))
        .expect("live fixture node")
}

fn assert_close(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 0.0001, "{actual} != {expected}");
}

fn assert_rect(actual: Rect, expected: Rect) {
    for (actual, expected) in [
        (actual.x0, expected.x0),
        (actual.y0, expected.y0),
        (actual.x1, expected.x1),
        (actual.y1, expected.y1),
    ] {
        assert_close(actual, expected);
    }
}

fn assert_transform(doc: &BaseDocument, name: &str, expected: [f64; 6]) {
    let actual = node(doc, name)
        .transform()
        .as_deref()
        .expect("authored transform must resolve")
        .as_coeffs();
    for (actual, expected) in actual.into_iter().zip(expected) {
        assert_close(actual, expected);
    }
}

fn paint(doc: &mut BaseDocument, scale: f64) -> Scene {
    let mut scene = Scene::new();
    blitz_paint::paint_scene_with_ownership(
        &mut scene,
        doc,
        scale,
        (448.0 * scale) as u32,
        (256.0 * scale) as u32,
        OFFSET.0,
        OFFSET.1,
        PaintLimits::default(),
    )
    .expect("supported box-only document must paint");
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
    assert_eq!(depth, 0, "unbalanced scene");
    scene
}

fn fill_bounds(scene: &Scene, wanted: [u8; 4]) -> Rect {
    let matches: Vec<_> = scene
        .commands
        .iter()
        .filter_map(|command| {
            let RenderCommand::Fill(fill) = command else {
                return None;
            };
            let Paint::Solid(color) = &fill.brush else {
                return None;
            };
            (color.to_rgba8().to_u8_array() == wanted).then(|| {
                fill.transform
                    .transform_rect_bbox(fill.shape.bounding_box())
            })
        })
        .collect();
    assert_eq!(matches.len(), 1, "expected exactly one {wanted:?} fill");
    matches[0]
}

fn device_bounds(css: Rect, scale: f64) -> Rect {
    Rect::new(
        f64::from(OFFSET.0) + css.x0 * scale,
        f64::from(OFFSET.1) + css.y0 * scale,
        f64::from(OFFSET.0) + css.x1 * scale,
        f64::from(OFFSET.1) + css.y1 * scale,
    )
}

fn assert_same_scale_restoration(scenes: &[Scene]) {
    assert_eq!(scenes[1], scenes[2], "unchanged DPR2 resolve changed paint");
    assert_eq!(scenes[0], scenes[3], "restored DPR1 changed paint");
}

fn exercise_translation_sequence(flush_device_early: bool) {
    let mut doc = document(
        "<div id='px' style='position:absolute;left:16px;top:8px;width:80px;height:40px;transform:translate(.375px,.25px);background:#e02030'></div>\
         <div id='percent' style='position:absolute;left:112px;top:8px;width:80px;height:40px;transform:translate(25%,50%);background:#20a060'></div>",
    );
    let mut scenes = Vec::new();
    for scale in DPR_SEQUENCE {
        let next = viewport(scale);
        assert_eq!(next.logical_size(), (448.0, 256.0));
        doc.set_viewport(next);
        if flush_device_early {
            let size = doc.stylist_device().au_viewport_size();
            assert_eq!(size.width.to_f32_px(), 448.0);
            assert_eq!(size.height.to_f32_px(), 256.0);
        }
        doc.resolve(0.0);
        assert_transform(
            &doc,
            "px",
            [1.0, 0.0, 0.0, 1.0, 0.375 * scale, 0.25 * scale],
        );
        assert_transform(
            &doc,
            "percent",
            [1.0, 0.0, 0.0, 1.0, 20.0 * scale, 20.0 * scale],
        );
        // This untransformed ancestor must also refresh its device-space union.
        assert_rect(
            *node(&doc, "ancestor").scrollable_overflow(),
            Rect::new(0.0, 0.0, 212.0 * scale, 68.0 * scale),
        );
        let scene = paint(&mut doc, scale);
        assert_rect(
            fill_bounds(&scene, BLUE),
            device_bounds(Rect::new(32.0, 24.0, 96.0, 56.0), scale),
        );
        assert_rect(
            fill_bounds(&scene, RED),
            device_bounds(Rect::new(48.375, 32.25, 128.375, 72.25), scale),
        );
        assert_rect(
            fill_bounds(&scene, GREEN),
            device_bounds(Rect::new(164.0, 52.0, 244.0, 92.0), scale),
        );
        scenes.push(scene);
    }
    assert_same_scale_restoration(&scenes);
}

#[test]
fn unchanged_box_document_refreshes_px_percent_transforms_and_overflow_across_dpr() {
    exercise_translation_sequence(false);
}

#[test]
fn early_device_flush_preserves_transform_and_overflow_invalidation_until_resolve() {
    exercise_translation_sequence(true);
}

#[test]
fn dpr_changes_scale_transform_origin_translation_without_scaling_linear_terms() {
    for (transform, matrix, overflow, bounds) in [
        (
            "rotate(90deg)",
            [0.0, 1.0, -1.0, 0.0, 60.0, -20.0],
            Rect::new(0.0, -12.0, 76.0, 68.0),
            Rect::new(68.0, 12.0, 108.0, 92.0),
        ),
        (
            "scale(.5)",
            [0.5, 0.0, 0.0, 0.5, 20.0, 10.0],
            Rect::new(0.0, 0.0, 76.0, 38.0),
            Rect::new(68.0, 42.0, 108.0, 62.0),
        ),
    ] {
        let mut doc = document(&format!(
            "<div id='subject' style='position:absolute;left:16px;top:8px;width:80px;height:40px;transform:{transform};background:#e02030'></div>"
        ));
        let mut scenes = Vec::new();
        for scale in DPR_SEQUENCE {
            doc.set_viewport(viewport(scale));
            doc.resolve(0.0);
            let [a, b, c, d, x, y] = matrix;
            assert_transform(&doc, "subject", [a, b, c, d, x * scale, y * scale]);
            assert_rect(
                *node(&doc, "ancestor").scrollable_overflow(),
                Rect::new(
                    overflow.x0 * scale,
                    overflow.y0 * scale,
                    overflow.x1 * scale,
                    overflow.y1 * scale,
                ),
            );
            let scene = paint(&mut doc, scale);
            assert_rect(fill_bounds(&scene, RED), device_bounds(bounds, scale));
            scenes.push(scene);
        }
        assert_same_scale_restoration(&scenes);
    }
}
