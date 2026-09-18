use super::*;
use blitz_paint::ClipRouteIssue;

fn clipped_fixed_document() -> BaseDocument {
    document(
        "<div style='position:absolute;left:32px;top:24px;width:128px;height:80px;overflow:hidden'>\
         <div id='effect' style='width:160px;height:112px;background:#2060e0'>\
         <div id='subject' style='position:fixed;left:128px;top:72px;width:128px;height:64px;background:#e02030'></div></div></div>\
         <div style='position:absolute;left:304px;top:32px;width:32px;height:32px;background:#20a060'></div>",
    )
}

#[test]
fn valid_empty_parent_path_suppresses_own_and_captured_fixed_pixels_then_restores() {
    let mut doc = clipped_fixed_document();
    let effect = doc.get_element_by_id("effect").unwrap();
    let mut initial = None;
    for clip in [
        "none",
        "inset(-2000px)",
        "inset(100%)",
        "inset(-2000px)",
        "none",
    ] {
        doc.mutate().set_style_property(effect, "clip-path", clip);
        doc.resolve(0.0);
        let scene = paint(&mut doc, 1.0, (0, 0));
        let markers = markers(&scene);
        assert!(one(&markers, GREEN).covers_point_after_clips(Point::new(320.0, 48.0)));
        if clip == "inset(100%)" {
            assert!(
                !markers
                    .iter()
                    .any(|marker| matches!(marker.color, RED | BLUE))
            );
        } else {
            let red = one(&markers, RED);
            let blue = one(&markers, BLUE);
            assert!(blue.covers_point_after_clips(Point::new(48.0, 40.0)));
            assert!(red.covers_point_after_clips(Point::new(144.0, 88.0)));
            assert_eq!(
                red.covers_point_after_clips(Point::new(208.0, 88.0)),
                clip == "none"
            );
        }
        if clip == "none" {
            if let Some(initial) = &initial {
                assert_eq!(
                    &scene, initial,
                    "empty clip state must not survive restoration"
                );
            } else {
                initial = Some(scene);
            }
        }
    }
}

#[test]
fn valid_empty_subject_path_does_not_suppress_ancestor_or_unrelated_sibling() {
    let mut doc = clipped_fixed_document();
    let subject = doc.get_element_by_id("subject").unwrap();
    let mut initial = None;
    for clip in ["none", "inset(100%)", "none"] {
        doc.mutate().set_style_property(subject, "clip-path", clip);
        doc.resolve(0.0);
        let scene = paint(&mut doc, 1.0, (0, 0));
        let markers = markers(&scene);
        assert!(one(&markers, BLUE).covers_point_after_clips(Point::new(48.0, 40.0)));
        assert!(one(&markers, GREEN).covers_point_after_clips(Point::new(320.0, 48.0)));
        if clip == "inset(100%)" {
            assert!(!markers.iter().any(|marker| marker.color == RED));
        } else {
            assert!(one(&markers, RED).covers_point_after_clips(Point::new(208.0, 88.0)));
            if let Some(initial) = &initial {
                assert_eq!(&scene, initial);
            } else {
                initial = Some(scene);
            }
        }
    }
}

#[test]
fn unsupported_clip_declarations_fail_typed_before_commands_and_each_restore() {
    let mut doc = clipped_fixed_document();
    let effect = doc.get_element_by_id("effect").unwrap();
    doc.resolve(0.0);
    let baseline = paint(&mut doc, 1.0, (0, 0));
    for (property, value, expected, restored) in [
        (
            "clip-path",
            "url(#unresolved-local-clip)",
            ClipRouteIssue::UnsupportedClipPathUrl,
            "none",
        ),
        (
            "clip-path",
            "circle(40%)",
            ClipRouteIssue::UnsupportedClipPathShape,
            "none",
        ),
        (
            "clip-path",
            "inset(4px round 8px)",
            ClipRouteIssue::UnsupportedInsetRadius,
            "none",
        ),
        (
            "clip-path",
            "polygon(evenodd,0 0,100% 0,100% 100%,0 100%)",
            ClipRouteIssue::UnsupportedEvenOdd,
            "none",
        ),
        (
            "clip-path",
            "inset(0) margin-box",
            ClipRouteIssue::UnsupportedClipPathBox,
            "none",
        ),
        (
            "overflow",
            "clip",
            ClipRouteIssue::UnsupportedOverflowClip,
            "visible",
        ),
    ] {
        doc.mutate().set_style_property(effect, property, value);
        doc.resolve(0.0);
        let error = rejected(&mut doc);
        assert!(
            matches!(&error, OwnershipPaintError::Clip(error) if error.node == effect && error.issue == expected),
            "{property}: {value}: {error:?}"
        );
        doc.mutate().set_style_property(effect, property, restored);
        doc.resolve(0.0);
        let scene = paint(&mut doc, 1.0, (0, 0));
        assert_eq!(
            scene, baseline,
            "restoring {property}: {value} must restore the supported scene"
        );
    }
}
