use super::*;

fn shared_clip_document() -> BaseDocument {
    document(
        "<div style='position:absolute;left:32px;top:24px;width:160px;height:112px;overflow:hidden;border-radius:24px'>\
         <div id='effect' style='position:relative;width:160px;height:112px;opacity:.5;background:#2060e0'>\
         <div style='position:absolute;z-index:-1;left:8px;top:8px;width:96px;height:64px;background:#e02030'></div>\
         <div style='display:flex'><div style='width:80px;height:48px;background:#20a060'></div></div>\
         <div style='position:absolute;z-index:2;left:16px;top:16px;width:80px;height:48px;background:#9020e0'></div>\
         </div></div>\
         <div style='position:absolute;left:320px;top:32px;width:32px;height:32px;background:#e0a020'></div>",
    )
}

#[test]
fn one_output_clip_surrounds_opacity_and_all_paint_phases_at_each_dpr() {
    let mut doc = shared_clip_document();
    let mut initial = None;
    for (index, scale) in [1.0_f64, 2.0, 1.0].into_iter().enumerate() {
        doc.set_viewport(Viewport::new(
            (448.0 * scale) as u32,
            (256.0 * scale) as u32,
            scale as f32,
            ColorScheme::Light,
        ));
        doc.resolve(0.0);
        let scene = paint(&mut doc, scale, (7, 9));
        let values = markers(&scene);
        let owner = one(&values, BLUE);
        assert_eq!(owner.layers.len(), 2);
        assert_eq!(owner.layers[0].alpha, 1.0);
        assert_eq!(owner.layers[1].alpha, 0.5);
        assert!(
            matches!(&scene.commands[owner.layers[0].command], RenderCommand::PushLayer(layer) if layer.alpha == 1.0)
        );
        let commands: Vec<_> = owner.layers.iter().map(|layer| layer.command).collect();
        for color in [RED, GREEN, PURPLE] {
            let item = one(&values, color);
            assert_eq!(
                item.layers
                    .iter()
                    .map(|layer| layer.command)
                    .collect::<Vec<_>>(),
                commands,
                "all phases must share the output clip and one opacity effect"
            );
        }
        assert!(owner.command < one(&values, RED).command);
        assert!(one(&values, RED).command < one(&values, GREEN).command);
        assert!(one(&values, GREEN).command < one(&values, PURPLE).command);
        let clip = &owner.layers[0];
        assert_rect(
            clip.transform.transform_rect_bbox(clip.clip.bounding_box()),
            Rect::new(
                7.0 + 32.0 * scale,
                9.0 + 24.0 * scale,
                7.0 + 192.0 * scale,
                9.0 + 136.0 * scale,
            ),
        );
        assert!(
            one(&values, GOLD).layers.is_empty(),
            "output scope must close before a later sibling"
        );
        if index == 0 {
            initial = Some(scene);
        } else if index == 2 {
            assert_eq!(Some(scene), initial);
        }
    }
}

#[test]
fn nested_effects_factor_only_the_prefix_retained_by_escaping_fixed_content() {
    let mut doc = document(
        "<div style='position:relative;left:32px;top:24px;width:256px;height:176px;clip-path:inset(0)'>\
         <div style='position:relative;width:128px;height:80px;overflow:hidden;border-radius:16px'>\
         <div style='opacity:.5;width:160px;height:112px'>\
         <div style='opacity:.5;width:160px;height:112px'>\
         <div style='width:128px;height:80px;background:#2060e0'></div>\
         <div style='position:fixed;left:128px;top:72px;z-index:-1;width:128px;height:64px;background:#e02030'></div>\
         <div style='position:fixed;left:160px;top:88px;z-index:2;width:64px;height:32px;background:#9020e0'></div>\
         </div></div></div></div>",
    );
    doc.resolve(0.0);
    let scene = paint(&mut doc, 1.0, (0, 0));
    let values = markers(&scene);
    let red = one(&values, RED);
    let blue = one(&values, BLUE);
    let purple = one(&values, PURPLE);
    assert_eq!(
        red.layers.len(),
        3,
        "one shared path plus two distinct opacity operations"
    );
    assert_eq!(
        blue.layers.len(),
        4,
        "ordinary content retains the divergent overflow suffix"
    );
    assert_eq!(
        red.layers
            .iter()
            .map(|layer| layer.alpha)
            .collect::<Vec<_>>(),
        [1.0, 0.5, 0.5]
    );
    assert_eq!(red.opacity_layers(), blue.opacity_layers());
    assert_eq!(red.opacity_layers(), purple.opacity_layers());
    assert_eq!(red.layers[0].command, blue.layers[0].command);
    assert_eq!(red.layers[0].command, purple.layers[0].command);
    assert!(blue.layers[3].command > blue.layers[2].command);
    assert!(red.covers_point_after_clips(Point::new(220.0, 96.0)));
    assert!(!blue.covers_point_after_clips(Point::new(176.0, 80.0)));
}

#[test]
fn geometry_equal_authored_clips_remain_distinct_across_nested_effects() {
    let mut doc = document(
        "<div style='position:absolute;left:32px;top:24px;width:160px;height:112px;clip-path:inset(0);opacity:.5'>\
         <div style='width:160px;height:112px;clip-path:inset(0);opacity:.5'>\
         <div style='width:160px;height:112px;background:#e02030'></div></div></div>",
    );
    doc.resolve(0.0);
    let scene = paint(&mut doc, 1.0, (0, 0));
    let values = markers(&scene);
    let red = one(&values, RED);
    assert_eq!(
        red.layers
            .iter()
            .map(|layer| layer.alpha)
            .collect::<Vec<_>>(),
        [1.0, 0.5, 1.0, 0.5]
    );
    assert_eq!(red.layers[0].clip, red.layers[2].clip);
    assert_eq!(red.layers[0].transform, red.layers[2].transform);
    assert_ne!(red.layers[0].command, red.layers[2].command);
}

#[test]
fn own_overflow_does_not_clip_the_effects_decoration_or_escaping_child() {
    let mut doc = document(
        "<div style='position:absolute;left:32px;top:24px;width:128px;height:80px;opacity:.5;overflow:hidden;border-radius:16px;background:#2060e0'>\
         <div style='width:160px;height:112px;background:#e02030'></div>\
         <div style='position:fixed;left:208px;top:72px;width:64px;height:48px;background:#9020e0'></div></div>",
    );
    doc.resolve(0.0);
    let scene = paint(&mut doc, 1.0, (0, 0));
    let values = markers(&scene);
    let blue = one(&values, BLUE);
    let red = one(&values, RED);
    let purple = one(&values, PURPLE);
    assert_eq!(blue.layers.len(), 1);
    assert_eq!(purple.layers.len(), 1);
    assert_eq!(red.layers.len(), 2);
    assert_eq!(red.layers[0].alpha, 0.5);
    assert_eq!(red.layers[1].alpha, 1.0);
    assert_eq!(blue.opacity_layers(), red.opacity_layers());
    assert_eq!(blue.opacity_layers(), purple.opacity_layers());
    assert!(purple.covers_point_after_clips(Point::new(240.0, 96.0)));
}

#[test]
fn own_widget_content_clip_stays_inside_opacity_after_shared_output_clip() {
    let mut doc = document(
        "<div style='position:absolute;left:32px;top:24px;width:256px;height:176px;overflow:hidden;border-radius:24px'>\
         <div id='effect' style='position:relative;width:120px;height:100px;box-sizing:border-box;border:8px solid #333333;padding:12px;border-radius:36px;opacity:.5;background:#2060e0'>\
         <div style='position:absolute;left:140px;top:0;width:32px;height:32px;background:#e02030'></div></div></div>",
    );
    let owner = doc.get_element_by_id("effect").unwrap();
    let calls = Rc::new(Cell::new(0));
    doc.mutate()
        .set_custom_widget(owner, Box::new(MarkerWidget(calls.clone())));
    doc.resolve(0.0);
    let scene = paint(&mut doc, 1.0, (0, 0));
    let values = markers(&scene);
    let green = one(&values, GREEN);
    let red = one(&values, RED);
    assert_eq!(
        green
            .layers
            .iter()
            .map(|layer| layer.alpha)
            .collect::<Vec<_>>(),
        [1.0, 0.5, 1.0]
    );
    assert_eq!(red.layers.len(), 2);
    assert_eq!(green.layers[0].command, red.layers[0].command);
    assert_eq!(green.opacity_layers(), red.opacity_layers());
    assert!(red.covers_point_after_clips(red.bounds.center()));
    assert_eq!(calls.get(), 1);
}

#[test]
fn visibility_empty_clip_and_opacity_mutations_restore_output_scope() {
    let mut doc = shared_clip_document();
    let effect = doc.get_element_by_id("effect").unwrap();
    let mut initial = None;
    for (index, (opacity, clip, visibility)) in [
        (".5", "none", "visible"),
        ("1", "none", "visible"),
        ("0", "none", "visible"),
        (".5", "inset(100%)", "visible"),
        (".5", "none", "hidden"),
        (".5", "none", "visible"),
    ]
    .into_iter()
    .enumerate()
    {
        doc.mutate().set_style_property(effect, "opacity", opacity);
        doc.mutate().set_style_property(effect, "clip-path", clip);
        doc.mutate()
            .set_style_property(effect, "visibility", visibility);
        doc.resolve(0.0);
        let scene = paint(&mut doc, 1.0, (0, 0));
        let values = markers(&scene);
        assert!(one(&values, GOLD).layers.is_empty());
        let red: Vec<_> = values.iter().filter(|item| item.color == RED).collect();
        if opacity == "0" || clip != "none" || visibility == "hidden" {
            assert!(red.is_empty());
        } else {
            assert_eq!(red.len(), 1);
            assert_eq!(red[0].opacity_layers().len(), usize::from(opacity == ".5"));
        }
        if index == 0 {
            initial = Some(scene);
        } else if index == 5 {
            assert_eq!(Some(scene), initial);
        }
    }
}

#[test]
fn hidden_effect_keeps_explicitly_visible_atomic_content_and_canvas_background() {
    let mut doc = document(
        "<div style='display:flex;width:160px;height:112px;clip-path:inset(8px);opacity:.5;visibility:hidden'>\
         <div style='width:160px;height:112px;background:#e02030;visibility:visible'></div></div>",
    );
    let root = doc.get_element_by_id("root").unwrap();
    let body = doc.get_element_by_id("body").unwrap();
    doc.mutate()
        .set_style_property(root, "background", "transparent");
    doc.mutate()
        .set_style_property(body, "background", "#2060e0");
    doc.resolve(0.0);
    let scene = paint(&mut doc, 1.0, (0, 0));
    let values = markers(&scene);
    let red = one(&values, RED);
    assert_eq!(
        red.layers
            .iter()
            .map(|layer| layer.alpha)
            .collect::<Vec<_>>(),
        [1.0, 0.5]
    );
    assert!(red.covers_point_after_clips(Point::new(80.0, 56.0)));
    assert!(!red.covers_point_after_clips(Point::new(2.0, 56.0)));
    let canvas = one(&values, BLUE);
    assert!(canvas.layers.is_empty());
    assert_rect(canvas.bounds, Rect::new(0.0, 0.0, 448.0, 256.0));
}

#[test]
fn output_clip_layers_count_toward_budget_and_recovery_stays_balanced() {
    let mut doc = shared_clip_document();
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
            max_total_layers: 1,
            max_layer_depth: 1,
        },
    )
    .unwrap_err();
    let OwnershipPaintError::Budget(error) = error else {
        panic!("{error:?}");
    };
    assert_eq!(error.stats.total_layers, 1);
    assert_eq!(error.stats.peak_layer_depth, 1);
    assert_eq!(
        error.kind,
        blitz_paint::PaintErrorKind::TotalLayerLimit {
            attempted: 2,
            layer: blitz_paint::PaintLayerKind::Effect,
        }
    );
    assert_eq!(error.location.node_id, doc.get_element_by_id("effect"));
    assert_balanced(&failed);
    let scene = paint(&mut doc, 1.0, (0, 0));
    assert_eq!(one(&markers(&scene), RED).layers.len(), 2);
}

#[test]
fn an_empty_descendant_suffix_does_not_empty_the_shared_output_prefix() {
    let mut doc = document(
        "<div style='position:absolute;left:32px;top:24px;width:160px;height:112px;clip-path:inset(0);opacity:.5'>\
         <div id='child' style='width:80px;height:48px;background:#e02030'></div>\
         <div style='width:80px;height:48px;background:#2060e0'></div></div>",
    );
    let child = doc.get_element_by_id("child").unwrap();
    let mut initial = None;
    for (index, clip) in ["none", "inset(100%)", "none"].into_iter().enumerate() {
        doc.mutate().set_style_property(child, "clip-path", clip);
        doc.resolve(0.0);
        let scene = paint(&mut doc, 1.0, (0, 0));
        let values = markers(&scene);
        let blue = one(&values, BLUE);
        assert_eq!(
            blue.layers
                .iter()
                .map(|layer| layer.alpha)
                .collect::<Vec<_>>(),
            [1.0, 0.5]
        );
        assert!(blue.covers_point_after_clips(Point::new(64.0, 96.0)));
        if clip != "none" {
            assert!(!values.iter().any(|value| value.color == RED));
        } else {
            assert_eq!(one(&values, RED).layers[0].command, blue.layers[0].command);
        }
        if index == 0 {
            initial = Some(scene);
        } else if index == 2 {
            assert_eq!(Some(scene), initial);
        }
    }
}
