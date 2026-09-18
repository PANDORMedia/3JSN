use fontique::{
    Attributes, Blob, Collection, CollectionOptions, FontInfoOverride, FontStyle, FontWeight,
    FontWidth, QueryFont, QueryStatus, SourceCache, WebFontError, WebFontFace, WebFontStyle,
};
use parley::{FontContext, Layout, LayoutContext, StyleProperty};
use std::sync::Arc;

const NARROW: &[u8] = include_bytes!("../fixtures/narrow.ttf");
const WIDE: &[u8] = include_bytes!("../fixtures/wide.ttf");
const VARIABLE: &[u8] = include_bytes!("../fixtures/variable.ttf");
const ALL: &[(u32, u32)] = &[(0, 0x10FFFF)];

fn context() -> FontContext {
    FontContext {
        collection: Collection::new(CollectionOptions {
            shared: false,
            system_fonts: false,
        }),
        source_cache: SourceCache::default(),
    }
}
fn face(order: u64, ranges: &[(u32, u32)]) -> WebFontFace {
    WebFontFace::new(
        order,
        ranges,
        (400.0, 400.0),
        (100.0, 100.0),
        WebFontStyle::Normal,
    )
    .unwrap()
}
fn add(context: &mut FontContext, bytes: &[u8], family: &str, face: Option<&WebFontFace>) -> u64 {
    let blob = Blob::new(Arc::new(bytes.to_vec()));
    let id = blob.id();
    let registered = context.collection.register_fonts(
        blob,
        Some(FontInfoOverride {
            family_name: Some(family),
            web_font: face,
            ..Default::default()
        }),
    );
    assert_eq!(registered.len(), 1, "fixture must register one family");
    assert_eq!(registered[0].1.len(), 1, "fixture must register one face");
    id
}
fn query(context: &mut FontContext, families: &[&str], attributes: Attributes) -> Vec<QueryFont> {
    let mut query = context.collection.query(&mut context.source_cache);
    query.set_families(families.iter().copied());
    query.set_attributes(attributes);
    let mut fonts = Vec::new();
    query.matches_with(|font| {
        fonts.push(font.clone());
        QueryStatus::Continue
    });
    fonts
}
fn layout(
    context: &mut FontContext,
    text: &str,
    families: &str,
    weight: f32,
    variations: Option<&str>,
) -> Layout<[u8; 4]> {
    let mut layout_context = LayoutContext::new();
    let mut builder = layout_context.ranged_builder(context, text, 1.0, false);
    builder.push_default(StyleProperty::FontFamily(families.into()));
    builder.push_default(StyleProperty::FontSize(1000.0));
    builder.push_default(StyleProperty::FontWeight(FontWeight::new(weight)));
    if let Some(variations) = variations {
        builder.push_default(StyleProperty::FontVariations(variations.into()));
    }
    let mut layout = builder.build(text);
    layout.break_all_lines(None);
    layout
}
fn glyphs(layout: &Layout<[u8; 4]>) -> Vec<u32> {
    layout
        .lines()
        .flat_map(|line| line.runs())
        .flat_map(|run| {
            run.clusters()
                .flat_map(|cluster| cluster.glyphs().map(|glyph| glyph.id))
                .collect::<Vec<_>>()
        })
        .collect()
}
fn sources(layout: &Layout<[u8; 4]>) -> Vec<u64> {
    layout
        .lines()
        .flat_map(|line| line.runs())
        .map(|run| run.font().data.id())
        .collect()
}
fn axis(font: &QueryFont, tag: &[u8; 4]) -> f32 {
    font.synthesis
        .variation_settings()
        .iter()
        .find(|(axis, _)| axis.to_be_bytes() == *tag)
        .unwrap()
        .1
}

#[test]
fn descriptors_validate_and_normalize_unicode_intervals() {
    let descriptor = face(9, &[(0x41, 0x42), (0x40, 0x41), (0x44, 0x44), (0x43, 0x43)]);
    assert_eq!(descriptor.unicode_ranges(), &[(0x40, 0x44)]);
    assert!(descriptor.contains(0x40));
    assert!(descriptor.contains(0x44));
    assert!(!descriptor.contains(0x45));
    assert!(!face(0, &[]).contains(0x41));
    for ranges in [&[(9, 1)][..], &[(0, 0x110000)][..]] {
        assert_eq!(
            WebFontFace::new(
                0,
                ranges,
                (400.0, 400.0),
                (100.0, 100.0),
                WebFontStyle::Normal
            )
            .unwrap_err(),
            WebFontError::UnicodeRange
        );
    }
    assert!(
        WebFontFace::new(0, ALL, (900.0, 100.0), (100.0, 100.0), WebFontStyle::Normal).is_err()
    );
    assert!(
        WebFontFace::new(
            0,
            ALL,
            (400.0, 400.0),
            (f32::NAN, 100.0),
            WebFontStyle::Normal
        )
        .is_err()
    );
    assert!(
        WebFontFace::new(
            0,
            ALL,
            (400.0, 400.0),
            (100.0, 100.0),
            WebFontStyle::Oblique {
                min: -91.0,
                max: 0.0
            }
        )
        .is_err()
    );
}

#[test]
fn every_same_attribute_subset_is_reachable_and_bytes_remain_original() {
    let mut cx = context();
    let a = add(
        &mut cx,
        NARROW,
        "Composite",
        Some(&face(0, &[(0x41, 0x41)])),
    );
    let b = add(
        &mut cx,
        WIDE,
        "Composite",
        Some(&face(1, &[(0x391, 0x391)])),
    );
    let c = add(
        &mut cx,
        VARIABLE,
        "Composite",
        Some(&face(2, &[(0x3A9, 0x3A9)])),
    );
    let fonts = query(&mut cx, &["Composite"], Attributes::default());
    assert_eq!(
        fonts.iter().map(|font| font.blob.id()).collect::<Vec<_>>(),
        [c, b, a]
    );
    assert_eq!(fonts[0].blob.as_ref(), VARIABLE);
    assert!(fonts[0].charmap().unwrap().map('A').is_none());
    assert!(fonts[2].charmap().unwrap().map('A').is_some());
    let shaped = layout(&mut cx, "AΑΩ", "Composite", 400.0, None);
    assert_eq!(sources(&shaped), [a, b, c]);
    assert_eq!(glyphs(&shaped), [2, 9, 10]);
}

#[test]
fn overlapping_rules_use_css_order_not_completion_order() {
    for reverse in [false, true] {
        let mut cx = context();
        let mut wanted = 0;
        for order in if reverse { [9, 1] } else { [1, 9] } {
            let id = add(
                &mut cx,
                if order == 9 { WIDE } else { NARROW },
                "Overlap",
                Some(&face(order, ALL)),
            );
            if order == 9 {
                wanted = id;
            }
        }
        let shaped = layout(&mut cx, "AB", "Overlap", 400.0, None);
        assert_eq!(sources(&shaped), [wanted]);
        assert_eq!(shaped.width(), 1600.0);
    }
}

#[test]
fn restriction_selects_next_family_despite_raw_cmap_coverage() {
    let mut cx = context();
    add(&mut cx, NARROW, "First", Some(&face(0, &[(0x41, 0x41)])));
    let second = add(&mut cx, WIDE, "Second", Some(&face(1, ALL)));
    let shaped = layout(&mut cx, "B", "First,Second", 400.0, None);
    assert_eq!(sources(&shaped), [second]);
    assert_eq!(glyphs(&shaped), [3]);
    assert_eq!(shaped.width(), 800.0);
}

#[test]
fn final_partial_candidate_cannot_resurrect_excluded_glyph_during_shaping() {
    let mut cx = context();
    add(
        &mut cx,
        NARROW,
        "Restricted",
        Some(&face(0, &[(0x41, 0x41)])),
    );
    let shaped = layout(&mut cx, "B", "Restricted", 400.0, None);
    assert_eq!(
        glyphs(&shaped),
        [0],
        "raw cmap contains B; the shaping callback must still reject it"
    );
}

#[test]
fn restrictions_preserve_original_ligatures() {
    let mut cx = context();
    let id = add(
        &mut cx,
        NARROW,
        "Ligatures",
        Some(&face(0, &[(0x66, 0x66), (0x69, 0x69)])),
    );
    let shaped = layout(&mut cx, "fi", "Ligatures", 400.0, None);
    assert_eq!(sources(&shaped), [id]);
    assert_eq!(glyphs(&shaped), [11]);
    assert_eq!(shaped.width(), 900.0);
}

#[test]
fn combining_cluster_falls_back_without_splitting_source_text() {
    let mut cx = context();
    add(
        &mut cx,
        NARROW,
        "Restricted",
        Some(&face(0, &[(0x65, 0x65)])),
    );
    let id = add(&mut cx, WIDE, "Fallback", Some(&face(1, ALL)));
    let shaped = layout(&mut cx, "e\u{301}", "Restricted,Fallback", 400.0, None);
    assert_eq!(sources(&shaped), [id]);
    assert!(!glyphs(&shaped).contains(&0));
}

#[test]
fn web_faces_shadow_installed_face_and_do_not_use_wrong_style_default() {
    let mut cx = context();
    add(&mut cx, NARROW, "Shadow", None);
    let web = add(&mut cx, WIDE, "Shadow", Some(&face(0, &[(0x41, 0x41)])));
    let bold = WebFontFace::new(
        1,
        &[(0x42, 0x42)],
        (700.0, 700.0),
        (100.0, 100.0),
        WebFontStyle::Normal,
    )
    .unwrap();
    add(&mut cx, NARROW, "Shadow", Some(&bold));
    let fonts = query(&mut cx, &["Shadow"], Attributes::default());
    assert_eq!(fonts.len(), 1);
    assert_eq!(fonts[0].blob.id(), web);
    let fallback = add(&mut cx, VARIABLE, "Next", Some(&face(0, ALL)));
    assert_eq!(
        sources(&layout(&mut cx, "B", "Shadow,Next", 400.0, None)),
        [fallback]
    );
}

#[test]
fn variable_weight_ranges_choose_face_and_clamp_high_level_coordinates() {
    let mut cx = context();
    let low =
        WebFontFace::new(0, ALL, (300.0, 500.0), (100.0, 100.0), WebFontStyle::Normal).unwrap();
    let high =
        WebFontFace::new(1, ALL, (600.0, 800.0), (100.0, 100.0), WebFontStyle::Normal).unwrap();
    let low_id = add(&mut cx, VARIABLE, "Variable", Some(&low));
    let high_id = add(&mut cx, VARIABLE, "Variable", Some(&high));
    for (request, id, used) in [
        (200.0, low_id, 300.0),
        (450.5, low_id, 450.5),
        (550.0, high_id, 600.0),
        (700.0, high_id, 700.0),
        (900.0, high_id, 800.0),
    ] {
        let fonts = query(
            &mut cx,
            &["Variable"],
            Attributes {
                weight: FontWeight::new(request),
                ..Default::default()
            },
        );
        assert_eq!(fonts.len(), 1);
        assert_eq!(fonts[0].blob.id(), id);
        assert_eq!(axis(&fonts[0], b"wght"), used);
    }
}

#[test]
fn exact_descriptor_override_is_not_the_font_axis_default() {
    let mut cx = context();
    let desc =
        WebFontFace::new(0, ALL, (700.0, 700.0), (125.0, 125.0), WebFontStyle::Normal).unwrap();
    add(&mut cx, VARIABLE, "Override", Some(&desc));
    let shaped = layout(&mut cx, "A", "Override", 700.0, None);
    let run = shaped.lines().next().unwrap().runs().next().unwrap();
    assert!((i32::from(run.normalized_coords()[0]) - 9830).abs() <= 1); // (700-400)/(900-400), F2Dot14.
    assert_eq!(run.normalized_coords()[1], 4096); // (125-100)/(200-100).
}

#[test]
fn explicit_variations_keep_precedence_over_descriptor_limits() {
    let mut cx = context();
    let desc =
        WebFontFace::new(0, ALL, (300.0, 500.0), (100.0, 100.0), WebFontStyle::Normal).unwrap();
    add(&mut cx, VARIABLE, "Variable", Some(&desc));
    let shaped = layout(&mut cx, "A", "Variable", 900.0, Some("'wght' 800"));
    let run = shaped.lines().next().unwrap().runs().next().unwrap();
    assert_eq!(run.normalized_coords()[0], 13107);
}

#[test]
fn width_and_oblique_ranges_retain_fractional_coordinates() {
    let mut cx = context();
    let desc = WebFontFace::new(
        0,
        ALL,
        (400.0, 400.0),
        (87.25, 112.75),
        WebFontStyle::Oblique {
            min: 5.0,
            max: 20.0,
        },
    )
    .unwrap();
    add(&mut cx, VARIABLE, "Axes", Some(&desc));
    let fonts = query(
        &mut cx,
        &["Axes"],
        Attributes {
            width: FontWidth::from_percentage(101.25),
            style: FontStyle::Oblique(Some(12.5)),
            ..Default::default()
        },
    );
    assert!((axis(&fonts[0], b"wdth") - 101.25).abs() < 0.0001);
    assert_eq!(axis(&fonts[0], b"slnt"), -12.5);
    let fonts = query(
        &mut cx,
        &["Axes"],
        Attributes {
            width: FontWidth::from_percentage(120.0),
            style: FontStyle::Oblique(Some(30.0)),
            ..Default::default()
        },
    );
    assert!((axis(&fonts[0], b"wdth") - 112.75).abs() < 0.0001);
    assert_eq!(axis(&fonts[0], b"slnt"), -20.0);
}

#[test]
fn variation_selector_cannot_bypass_the_base_character_range() {
    let mut cx = context();
    add(&mut cx, NARROW, "Allowed", Some(&face(0, &[(0x41, 0x41)])));
    add(&mut cx, NARROW, "Denied", Some(&face(1, &[(0x42, 0x42)])));
    assert_eq!(
        glyphs(&layout(&mut cx, "A\u{FE0F}", "Allowed", 400.0, None)),
        [12]
    );
    assert!(!glyphs(&layout(&mut cx, "A\u{FE0F}", "Denied", 400.0, None)).contains(&12));
}

#[test]
fn projected_ranges_use_css_width_and_style_priority_before_weight() {
    let mut cx = context();
    let narrow =
        WebFontFace::new(0, ALL, (100.0, 900.0), (75.0, 90.0), WebFontStyle::Normal).unwrap();
    let wide =
        WebFontFace::new(1, ALL, (100.0, 900.0), (110.0, 125.0), WebFontStyle::Normal).unwrap();
    let narrow_id = add(&mut cx, VARIABLE, "Ranges", Some(&narrow));
    let wide_id = add(&mut cx, VARIABLE, "Ranges", Some(&wide));
    for (width, expected) in [(100.0, narrow_id), (105.0, wide_id)] {
        let fonts = query(
            &mut cx,
            &["Ranges"],
            Attributes {
                width: FontWidth::from_percentage(width),
                weight: FontWeight::new(550.0),
                ..Default::default()
            },
        );
        assert_eq!(fonts.len(), 1);
        assert_eq!(fonts[0].blob.id(), expected);
    }
    let negative = WebFontFace::new(
        0,
        ALL,
        (400.0, 400.0),
        (100.0, 100.0),
        WebFontStyle::Oblique {
            min: -20.0,
            max: -10.0,
        },
    )
    .unwrap();
    add(&mut cx, VARIABLE, "Negative", Some(&negative));
    let fonts = query(
        &mut cx,
        &["Negative"],
        Attributes {
            style: FontStyle::Oblique(Some(30.0)),
            ..Default::default()
        },
    );
    assert_eq!(fonts.len(), 1);
    assert_eq!(axis(&fonts[0], b"slnt"), 10.0);
}
