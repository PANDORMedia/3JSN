use blitz_dom::{BaseDocument, DocumentConfig};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};

const FONT: &[u8] = include_bytes!("../../web-font-matcher/fixtures/narrow.ttf");
const FONT_SIZE: f64 = 13.25;

fn document(scale: f32, body: &str, extra_style: &str) -> BaseDocument {
    let html = format!(
        "<!doctype html><style>html,body{{margin:0}}body{{font: {FONT_SIZE}px '3JSN narrow';line-height:20px}}\
         #subject{{display:inline-block}}{extra_style}</style>{body}"
    );
    let mut doc = HtmlDocument::from_html(
        &html,
        DocumentConfig {
            viewport: Some(Viewport::new(600, 360, scale, ColorScheme::Light)),
            font_ctx: Some(blitz_dom::build_single_font_ctx(FONT)),
            ..Default::default()
        },
    )
    .into_inner();
    doc.resolve(0.0);
    doc
}

fn measurements(doc: &BaseDocument, scale: f32) -> (f64, f64, f64, usize) {
    let id = doc.get_element_by_id("subject").unwrap();
    let node = doc.get_node(id).unwrap();
    let text = node
        .element_data()
        .unwrap()
        .inline_layout_data
        .as_ref()
        .unwrap();
    (
        node.unrounded_layout().size.width.into(),
        doc.get_client_bounding_rect(id).unwrap().width,
        f64::from(text.layout.width() / scale),
        text.layout.lines().count(),
    )
}

fn close(actual: f64, expected: f64, message: &str) {
    assert!(
        (actual - expected).abs() < 0.0001,
        "{message}: {actual} != {expected}"
    );
}

#[test]
fn fractional_intrinsic_inline_width_is_independent_of_device_pixel_scale() {
    // The original fixture font has 500-unit glyph advances and 1000 units/em.
    let expected = 3.0 * FONT_SIZE * 0.5;
    for scale in [1.0, 2.0, 1.5] {
        let doc = document(scale, "<span id=subject>AAA</span>", "");
        let (unrounded, cssom, advance, lines) = measurements(&doc, scale);
        close(advance, expected, "raw shaped advance");
        close(
            unrounded,
            expected,
            &format!("intrinsic CSS width at DPR{scale}"),
        );
        close(cssom, expected, "fractional CSSOM width");
        assert_eq!(lines, 1);
    }
}

#[test]
fn ligature_intrinsic_width_keeps_its_fractional_advance() {
    // The fixture's fi substitution advances 900 font units, not two 500-unit glyphs.
    let expected = FONT_SIZE * 0.9;
    for scale in [1.0, 2.0, 1.5] {
        let doc = document(scale, "<span id=subject>fi</span>", "");
        let (unrounded, cssom, advance, lines) = measurements(&doc, scale);
        close(advance, expected, "ligature shaped advance");
        close(unrounded, expected, "ligature intrinsic width");
        close(
            cssom,
            (expected * 64.0).round() / 64.0,
            "existing CSSOM layout-unit quantization",
        );
        assert_eq!(lines, 1);
    }
}

#[test]
fn inline_wrap_thresholds_use_fractional_css_width() {
    for (text, intrinsic) in [("A A", FONT_SIZE * 1.5), ("fi fi", FONT_SIZE * 2.3)] {
        for scale in [1.0, 2.0, 1.5] {
            for (delta, expected_lines) in [(-1.0 / 64.0, 2), (0.0, 1), (1.0 / 64.0, 1)] {
                let available = intrinsic + delta;
                let doc = document(
                    scale,
                    &format!("<div id=container><span id=subject>{text}</span></div>"),
                    &format!("#container{{width:{available}px}}"),
                );
                let (width, _, _, lines) = measurements(&doc, scale);
                assert_eq!(
                    lines, expected_lines,
                    "{text}, DPR{scale}, available{available}"
                );
                close(width, available.min(intrinsic), "shrink-to-fit width");
            }
        }
    }
}

#[test]
fn explicit_fractional_width_and_padding_are_preserved() {
    for scale in [1.0, 2.0, 1.5] {
        let doc = document(
            scale,
            "<span id=subject>AA</span>",
            "#subject{box-sizing:content-box;width:33.375px;padding:0 1.25px;border:0}",
        );
        let (width, cssom, advance, lines) = measurements(&doc, scale);
        close(width, 35.875, "specified width plus padding");
        close(cssom, 35.875, "specified fractional CSSOM width");
        close(
            advance,
            FONT_SIZE,
            "unmodified shaped text within explicit width",
        );
        assert_eq!(lines, 1);
    }
}

#[test]
fn integer_intrinsic_text_sizes_remain_unchanged() {
    for scale in [1.0, 2.0, 1.5] {
        let doc = document(
            scale,
            "<span id=subject>AAAA</span>",
            "#subject{font-size:16px}",
        );
        let (width, cssom, advance, lines) = measurements(&doc, scale);
        close(width, 32.0, "integer intrinsic width");
        close(cssom, 32.0, "integer CSSOM width");
        close(advance, 32.0, "integer raw advance");
        assert_eq!(lines, 1);
    }
}
