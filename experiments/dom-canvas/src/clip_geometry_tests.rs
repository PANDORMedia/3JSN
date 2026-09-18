use blitz_dom::geometry::{CssBox, NonUniformRoundedRectRadii, contains_nonzero};
use blitz_dom::{DocumentConfig, qual_name};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use vello::kurbo::{BezPath, Insets, Point, Rect, Shape as _, Vec2};

fn box_with_radius(rect: Rect, border: f64, padding: f64, x: f64, y: f64) -> CssBox {
    let radius = Vec2::new(x, y);
    CssBox::new(
        rect,
        Insets::uniform(border),
        Insets::uniform(padding),
        0.0,
        NonUniformRoundedRectRadii {
            top_left: radius,
            top_right: radius,
            bottom_right: radius,
            bottom_left: radius,
        },
    )
}

fn assert_rect_close(actual: Rect, expected: Rect) {
    for (actual, expected) in [actual.x0, actual.y0, actual.x1, actual.y1]
        .into_iter()
        .zip([expected.x0, expected.y0, expected.x1, expected.y1])
    {
        assert!((actual - expected).abs() < 1e-8, "{actual} != {expected}");
    }
}

#[test]
fn rounded_padding_and_content_clips_use_the_painted_inner_edges() {
    let frame = box_with_radius(Rect::new(0.0, 0.0, 160.0, 128.0), 8.0, 12.0, 28.0, 28.0);
    assert_eq!(frame.padding_box, Rect::new(8.0, 8.0, 152.0, 120.0));
    assert_eq!(frame.content_box, Rect::new(20.0, 20.0, 140.0, 108.0));
    assert_rect_close(frame.padding_box_path().bounding_box(), frame.padding_box);
    assert_rect_close(frame.content_box_path().bounding_box(), frame.content_box);
    assert!(frame.padding_box_contains(Point::new(80.0, 9.0)));
    assert!(!frame.padding_box_contains(Point::new(9.0, 9.0)));
    assert!(frame.padding_box_contains(Point::new(20.0, 20.0)));
    assert!(!frame.content_box_contains(Point::new(21.0, 21.0)));
    assert!(frame.content_box_contains(Point::new(28.0, 21.0)));
    assert!(!frame.padding_box_contains(Point::new(80.0, 4.0)));
    assert!(!frame.content_box_contains(Point::new(80.0, 19.0)));
}

#[test]
fn elliptical_corners_and_radius_overlap_keep_css_axis_orientation() {
    let frame = box_with_radius(Rect::new(0.0, 0.0, 120.0, 100.0), 0.0, 0.0, 20.0, 40.0);
    assert!(!frame.padding_box_contains(Point::new(2.0, 10.0)));
    assert!(frame.padding_box_contains(Point::new(12.0, 10.0)));
    assert!(frame.padding_box_contains(Point::new(2.0, 30.0)));

    let overlapping = box_with_radius(Rect::new(0.0, 0.0, 100.0, 80.0), 0.0, 0.0, 80.0, 80.0);
    assert_eq!(overlapping.border_radii.top_left, Vec2::new(40.0, 40.0));
    assert!(!overlapping.padding_box_contains(Point::new(5.0, 5.0)));
    assert!(overlapping.padding_box_contains(Point::new(50.0, 5.0)));
}

#[test]
fn style_layout_conversion_resolves_percentage_radii_after_resize_at_each_scale() {
    let mut doc = HtmlDocument::from_html(
        r#"<html><body style="margin:0"><div id="box" style="box-sizing:border-box;width:200px;height:100px;border:8px solid black;padding:12px;border-radius:50%"></div></body></html>"#,
        DocumentConfig {
            viewport: Some(Viewport::new(448, 256, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
    .into_inner();
    let id = doc.get_element_by_id("box").unwrap();
    for (width, height) in [(200.0, 100.0), (120.0, 160.0), (200.0, 100.0)] {
        doc.mutate().set_attribute(
            id,
            qual_name!("style"),
            &format!(
                "box-sizing:border-box;width:{width}px;height:{height}px;border:8px solid black;padding:12px;border-radius:50%"
            ),
        );
        doc.resolve(0.0);
        let node = doc.get_node(id).unwrap();
        let style = node.primary_styles().unwrap();
        for scale in [1.0, 2.0] {
            let frame = CssBox::from_layout(&style, node.final_layout(), scale);
            assert_eq!(
                frame.border_box,
                Rect::new(0.0, 0.0, width * scale, height * scale)
            );
            assert_eq!(
                frame.border_radii.top_left,
                Vec2::new(width * scale / 2.0, height * scale / 2.0)
            );
            assert_eq!(
                frame.padding_box,
                Rect::new(
                    8.0 * scale,
                    8.0 * scale,
                    (width - 8.0) * scale,
                    (height - 8.0) * scale
                )
            );
            assert!(frame.padding_box_contains(Point::new(width * scale / 2.0, 9.0 * scale)));
            assert!(!frame.padding_box_contains(Point::new(9.0 * scale, 9.0 * scale)));
        }
    }
}

fn open_rectangle(path: &mut BezPath, rect: Rect) {
    path.move_to((rect.x0, rect.y0));
    path.line_to((rect.x1, rect.y0));
    path.line_to((rect.x1, rect.y1));
    path.line_to((rect.x0, rect.y1));
}

#[test]
fn fill_predicate_closes_each_open_subpath_and_keeps_nonzero_holes() {
    let mut path = BezPath::new();
    open_rectangle(&mut path, Rect::new(0.0, 0.0, 20.0, 20.0));
    open_rectangle(&mut path, Rect::new(40.0, 0.0, 60.0, 20.0));
    for point in [Point::new(10.0, 10.0), Point::new(50.0, 10.0)] {
        assert!(contains_nonzero(&path, point));
    }
    for point in [
        Point::new(-2.0, 10.0),
        Point::new(30.0, 10.0),
        Point::new(70.0, 10.0),
    ] {
        assert!(!contains_nonzero(&path, point));
    }
    // The inner subpath has the opposite orientation; implicit closure must
    // preserve its winding cancellation instead of treating it as another fill.
    path.move_to((5.0, 5.0));
    path.line_to((5.0, 15.0));
    path.line_to((15.0, 15.0));
    path.line_to((15.0, 5.0));
    assert!(!contains_nonzero(&path, Point::new(10.0, 10.0)));
    assert!(contains_nonzero(&path, Point::new(2.0, 10.0)));
    assert!(contains_nonzero(&path, Point::new(50.0, 10.0)));
}

#[test]
fn empty_degenerate_and_nonfinite_clip_geometry_cannot_hit() {
    assert!(!contains_nonzero(&BezPath::new(), Point::ZERO));
    let mut line = BezPath::new();
    line.move_to((0.0, 0.0));
    line.line_to((10.0, 0.0));
    assert!(!contains_nonzero(&line, Point::new(5.0, 0.0)));
    let frame = box_with_radius(Rect::new(0.0, 0.0, 100.0, 80.0), 8.0, 12.0, 28.0, 28.0);
    for point in [Point::new(f64::NAN, 20.0), Point::new(20.0, f64::INFINITY)] {
        assert!(!frame.padding_box_contains(point));
        assert!(!frame.content_box_contains(point));
    }
    let empty = box_with_radius(Rect::new(0.0, 0.0, 16.0, 16.0), 8.0, 0.0, 0.0, 0.0);
    assert!(!empty.padding_box_contains(Point::new(8.0, 8.0)));
    let mut invalid = frame;
    invalid.border_radii.top_left.x = f64::NAN;
    assert!(!invalid.padding_box_contains(Point::new(50.0, 40.0)));
    let mut invalid_path = BezPath::new();
    invalid_path.move_to((0.0, 0.0));
    invalid_path.line_to((f64::INFINITY, 20.0));
    assert!(!contains_nonzero(&invalid_path, Point::new(1.0, 1.0)));
}
