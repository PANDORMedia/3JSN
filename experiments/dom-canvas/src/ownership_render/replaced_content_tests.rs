use super::*;

#[test]
fn rounded_widget_clips_only_own_content_with_padding_dpr_and_restore() {
    let mut doc = document(
        "<div id='owner' style='position:absolute;left:32px;top:24px;width:120px;height:100px;box-sizing:border-box;border:8px solid #333333;padding:12px;border-radius:36px;overflow:visible;background:#2060e0'>\
         <div style='position:absolute;left:140px;top:0;width:32px;height:32px;background:#e02030'></div>\
         <div style='position:fixed;left:260px;top:48px;width:32px;height:32px;background:#9020e0'></div></div>",
    );
    let owner = doc.get_element_by_id("owner").unwrap();
    let calls = Rc::new(Cell::new(0));
    doc.mutate()
        .set_custom_widget(owner, Box::new(MarkerWidget(calls.clone())));
    let mut initial = None;
    for (index, (scale, radius)) in [(1.0_f64, 36), (2.0, 36), (1.0, 0), (1.0, 36)]
        .into_iter()
        .enumerate()
    {
        doc.set_viewport(Viewport::new(
            (448.0 * scale) as u32,
            (256.0 * scale) as u32,
            scale as f32,
            ColorScheme::Light,
        ));
        doc.mutate()
            .set_style_property(owner, "border-radius", &format!("{radius}px"));
        doc.resolve(0.0);
        let scene = paint(&mut doc, scale, (7, 9));
        let markers = markers(&scene);
        let point = |x, y| Point::new(7.0 + x * scale, 9.0 + y * scale);
        let green = one(&markers, GREEN);
        // The existing widget deliberately draws 80x64 into an 80x60 content
        // box, so the lower witness detects rectangular as well as corner clips.
        assert_rect(
            green.bounds,
            Rect::new(
                7.0 + 52.0 * scale,
                9.0 + 44.0 * scale,
                7.0 + 132.0 * scale,
                9.0 + 108.0 * scale,
            ),
        );
        assert!(green.covers_point_after_clips(point(92.0, 74.0)));
        assert!(!green.covers_point_after_clips(point(92.0, 106.0)));
        assert_eq!(
            green.covers_point_after_clips(point(53.0, 45.0)),
            radius == 0,
            "rounded content edge must use the inset radius at DPR {scale}"
        );
        assert!(green.covers_point_after_clips(point(68.0, 45.0)));
        assert_eq!(green.layers.len(), 1, "one own-content clip");
        let blue = one(&markers, BLUE);
        assert!(blue.layers.is_empty(), "background is not content-clipped");
        for color in [RED, PURPLE] {
            let descendant = one(&markers, color);
            assert!(
                descendant.covers_point_after_clips(descendant.bounds.center()),
                "own widget clip must not enter the descendant route: {descendant:?}"
            );
            assert!(descendant.layers.is_empty());
        }
        assert_eq!(calls.get(), index + 1);
        if index == 0 {
            initial = Some(scene);
        } else if index == 3 {
            assert_eq!(Some(scene), initial, "DPR/radius restoration must be exact");
        }
    }
}

fn image_markers(scene: &Scene) -> Vec<Marker> {
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
                layers.pop().expect("balanced image scene");
            }
            RenderCommand::Fill(fill) if matches!(&fill.brush, Paint::Image(_)) => {
                result.push(Marker {
                    command: index,
                    color: [0; 4],
                    bounds: fill
                        .transform
                        .transform_rect_bbox(fill.shape.bounding_box()),
                    layers: layers.clone(),
                });
            }
            _ => {}
        }
    }
    result
}

#[test]
fn raster_cover_and_position_clip_to_rounded_content_edge_at_both_scales() {
    use std::sync::Arc;

    use blitz_dom::net::{Resource, ResourceLoadResponse};
    use blitz_dom::util::ImageType;

    const URL: &str = "https://example.invalid/ownership-wide-raster.png";
    let mut doc = document(&format!(
        "<img id='image' src='{URL}' style='position:absolute;left:32px;top:24px;width:120px;height:100px;box-sizing:border-box;border:8px solid #333333;padding:12px;border-radius:36px;object-fit:cover;object-position:100% 50%;overflow:visible'>"
    ));
    let image = doc.get_element_by_id("image").unwrap();
    doc.resolve(0.0);
    // Inject a public Resource response; the fixture neither fetches nor decodes
    // an external asset. The dimensions intentionally disagree with the box ratio.
    doc.load_resource(ResourceLoadResponse {
        request_id: usize::MAX,
        node_id: Some(image),
        resolved_url: Some(URL.into()),
        result: Ok(Resource::Image(
            ImageType::Image,
            160,
            80,
            Arc::new([224, 32, 48, 255].repeat(160 * 80)),
        )),
    });
    assert_eq!(
        doc.get_node(image)
            .unwrap()
            .element_data()
            .unwrap()
            .raster_image_data()
            .map(|image| (image.width, image.height)),
        Some((160, 80)),
        "public resource injection must actually install the image"
    );
    for (scale, position, expected_left, expected_right, outside_x) in [
        (1.0_f64, "100% 50%", 12.0, 132.0, 32.0),
        (2.0, "100% 50%", 12.0, 132.0, 32.0),
        (1.0, "0% 50%", 52.0, 172.0, 152.0),
        (1.0_f64, "100% 50%", 12.0, 132.0, 32.0),
    ] {
        doc.set_viewport(Viewport::new(
            (448.0 * scale) as u32,
            (256.0 * scale) as u32,
            scale as f32,
            ColorScheme::Light,
        ));
        doc.mutate()
            .set_style_property(image, "object-position", position);
        doc.resolve(0.0);
        let scene = paint(&mut doc, scale, (0, 0));
        let images = image_markers(&scene);
        assert_eq!(images.len(), 1, "raster must be emitted exactly once");
        let image = &images[0];
        assert_rect(
            image.bounds,
            Rect::new(
                expected_left * scale,
                44.0 * scale,
                expected_right * scale,
                104.0 * scale,
            ),
        );
        assert!(image.covers_point_after_clips(Point::new(92.0 * scale, 74.0 * scale)));
        assert!(!image.covers_point_after_clips(Point::new(outside_x * scale, 74.0 * scale)));
        assert!(!image.covers_point_after_clips(Point::new(53.0 * scale, 45.0 * scale)));
        assert!(image.covers_point_after_clips(Point::new(68.0 * scale, 45.0 * scale)));
        assert_eq!(
            image.layers.len(),
            1,
            "content clip despite visible overflow"
        );
    }
}
