use super::*;

#[test]
fn own_css_rect_stays_inside_opacity_for_every_paint_phase() {
    for path in ["none", "inset(0)"] {
        for scale in [1.0, 2.0] {
            let mut doc = document(&format!(
                "<div style='position:absolute;left:32px;top:24px;width:160px;height:112px;transform:translate(.375px,.25px);clip-path:{path};clip:rect(8px,144px,96px,16px);opacity:.5;background:#2060e0'>\
             <div style='position:absolute;z-index:-1;left:16px;top:8px;width:96px;height:64px;background:#e02030'></div>\
             <div style='display:flex'><div style='width:80px;height:48px;background:#20a060'></div></div>\
             <div style='position:absolute;z-index:2;left:24px;top:16px;width:64px;height:48px;background:#9020e0'></div></div>\
             <div style='position:absolute;left:320px;top:32px;width:32px;height:32px;background:#e0a020'></div>"
            ));
            let path_layers = usize::from(path != "none");
            doc.set_viewport(Viewport::new(
                (448.0 * scale) as u32,
                (256.0 * scale) as u32,
                scale as f32,
                ColorScheme::Light,
            ));
            doc.resolve(0.0);
            let scene = paint(&mut doc, scale, (7, 9));
            let values = markers(&scene);
            let blue = one(&values, BLUE);
            let mut rect_commands = Vec::new();
            for color in [BLUE, RED, GREEN, PURPLE] {
                let marker = one(&values, color);
                assert_eq!(marker.layers.len(), path_layers + 2);
                assert_eq!(marker.layers[path_layers].alpha, 0.5);
                assert_eq!(marker.opacity_layers(), blue.opacity_layers());
                if path_layers == 1 {
                    assert_eq!(marker.layers[0].command, blue.layers[0].command);
                }
                let rect = &marker.layers[path_layers + 1];
                assert!(matches!(
                    scene.commands[rect.command],
                    RenderCommand::PushClipLayer(_)
                ));
                assert_rect(
                    rect.transform.transform_rect_bbox(rect.clip.bounding_box()),
                    Rect::new(
                        7.0 + 48.375 * scale,
                        9.0 + 32.25 * scale,
                        7.0 + 176.375 * scale,
                        9.0 + 120.25 * scale,
                    ),
                );
                rect_commands.push(rect.command);
            }
            rect_commands.sort_unstable();
            rect_commands.dedup();
            assert_eq!(
                rect_commands.len(),
                4,
                "CSS rect stays on each contribution"
            );
            assert!(one(&values, GOLD).layers.is_empty());
            assert!(blue.command < one(&values, RED).command);
            assert!(one(&values, RED).command < one(&values, GREEN).command);
            assert!(one(&values, GREEN).command < one(&values, PURPLE).command);
        }
    }
}

#[test]
fn incoming_css_rect_can_clip_a_nested_effect_without_promoting_its_own_rect() {
    let mut doc = document(
        "<div style='position:absolute;left:32px;top:24px;width:192px;height:144px;clip:rect(8px,176px,128px,16px);opacity:.5;background:#2060e0'>\
         <div style='position:absolute;left:0;top:0;width:192px;height:144px;clip:rect(24px,160px,112px,32px);opacity:.5;background:#20a060'>\
         <div style='width:192px;height:144px;background:#e02030'></div></div></div>",
    );
    doc.resolve(0.0);
    let scene = paint(&mut doc, 1.0, (0, 0));
    let values = markers(&scene);
    let blue = one(&values, BLUE);
    let green = one(&values, GREEN);
    let red = one(&values, RED);
    assert_eq!(
        blue.layers
            .iter()
            .map(|layer| layer.alpha)
            .collect::<Vec<_>>(),
        [0.5, 1.0]
    );
    assert_eq!(
        red.layers
            .iter()
            .map(|layer| layer.alpha)
            .collect::<Vec<_>>(),
        [0.5, 1.0, 0.5, 1.0]
    );
    assert_eq!(red.layers[0].command, blue.layers[0].command);
    assert_eq!(red.layers[1].command, green.layers[1].command);
    assert!(matches!(
        scene.commands[red.layers[1].command],
        RenderCommand::PushLayer(_)
    ));
    assert_ne!(red.layers[3].command, green.layers[3].command);
    assert_rect(
        red.layers[1]
            .transform
            .transform_rect_bbox(red.layers[1].clip.bounding_box()),
        Rect::new(48.0, 32.0, 208.0, 152.0),
    );
    assert_rect(
        red.layers[3]
            .transform
            .transform_rect_bbox(red.layers[3].clip.bounding_box()),
        Rect::new(64.0, 48.0, 192.0, 136.0),
    );
}

#[test]
fn own_css_rect_preserves_fixed_overflow_escape_empty_restore_and_budget_cleanup() {
    let mut doc = document(
        "<div id='effect' style='position:absolute;left:32px;top:24px;width:128px;height:80px;clip:rect(0px,256px,176px,0px);opacity:.5;overflow:hidden;background:#2060e0'>\
         <div style='width:192px;height:112px;background:#e02030'></div>\
         <div style='position:fixed;left:208px;top:72px;width:64px;height:48px;background:#9020e0'></div></div>\
         <div style='position:absolute;left:352px;top:32px;width:32px;height:32px;background:#e0a020'></div>",
    );
    let effect = doc.get_element_by_id("effect").unwrap();
    let mut initial = None;
    for (index, clip) in [
        "rect(0px,256px,176px,0px)",
        "rect(0px,0px,0px,0px)",
        "rect(0px,256px,176px,0px)",
    ]
    .into_iter()
    .enumerate()
    {
        doc.mutate().set_style_property(effect, "clip", clip);
        doc.resolve(0.0);
        let scene = paint(&mut doc, 1.0, (0, 0));
        let values = markers(&scene);
        assert!(one(&values, GOLD).layers.is_empty());
        if index == 1 {
            assert!(
                !values
                    .iter()
                    .any(|marker| [BLUE, RED, PURPLE].contains(&marker.color))
            );
        } else {
            let purple = one(&values, PURPLE);
            assert_eq!(
                purple
                    .layers
                    .iter()
                    .map(|layer| layer.alpha)
                    .collect::<Vec<_>>(),
                [0.5, 1.0]
            );
            assert!(purple.covers_point_after_clips(Point::new(240.0, 96.0)));
            assert!(!one(&values, RED).covers_point_after_clips(Point::new(176.0, 64.0)));
            if index == 0 {
                initial = Some(scene);
            } else {
                assert_eq!(Some(scene), initial);
            }
        }
    }
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
            max_total_layers: 1,
            max_layer_depth: 1,
        },
    )
    .unwrap_err();
    let OwnershipPaintError::Budget(error) = error else {
        panic!("{error:?}");
    };
    assert_eq!(error.location.node_id, Some(effect));
    assert_eq!(
        error.kind,
        blitz_paint::PaintErrorKind::TotalLayerLimit {
            attempted: 2,
            layer: blitz_paint::PaintLayerKind::Clip,
        }
    );
    assert_balanced(&failed);
    assert_eq!(Some(paint(&mut doc, 1.0, (0, 0))), initial);
}
