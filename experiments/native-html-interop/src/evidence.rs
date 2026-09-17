use crate::{Result, check};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::BufWriter, path::Path};

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn verify(pixels: &[u8], width: u32, height: u32, green: bool) -> Result<Value> {
    check(
        pixels.len() == (width * height * 12) as usize,
        "wrong capture size",
    )?;
    let pixel = |x: u32, y: u32, plane: u32| -> &[u8] {
        let offset = ((y * width * 3 + x + plane * width) * 4) as usize;
        &pixels[offset..offset + 4]
    };
    let mut maximum_error = 0;
    let mut foreground = 0;
    let mut white_text = 0;
    for y in 0..height {
        for x in 0..width {
            let composed = pixel(x, y, 0);
            let game = pixel(x, y, 1);
            let ui = pixel(x, y, 2);
            for channel in 0..4 {
                let source_alpha = if channel == 3 {
                    1.0
                } else {
                    f64::from(ui[3]) / 255.0
                };
                let expected = f64::from(ui[channel]) * source_alpha
                    + f64::from(game[channel]) * (1.0 - f64::from(ui[3]) / 255.0);
                let error = (f64::from(composed[channel]) - expected).abs().ceil() as u32;
                maximum_error = maximum_error.max(error);
            }
            check(
                game[3] == 255 && composed[3] == 255,
                "game/composed image is not opaque",
            )?;
            if game[..3] != pixel(0, 0, 1)[..3] {
                foreground += 1;
            }
            if (32..88).contains(&y) && (32..256).contains(&x) && ui.iter().all(|c| *c > 235) {
                white_text += 1;
            }
        }
    }
    check(
        maximum_error <= 2,
        "straight-alpha source-over differs from independent CPU formula",
    )?;
    check(
        pixel(4, 4, 2) == [0, 0, 0, 0],
        "UI background must be transparent",
    )?;
    check(
        foreground > 1000,
        "Three.js scene has no substantial foreground",
    )?;
    check(white_text > 100, "HTML text did not paint glyphs")?;
    let expected = if green {
        [32, 160, 96, 128]
    } else {
        [200, 40, 60, 128]
    };
    let sample = pixel(200, 130, 2);
    check(
        sample
            .iter()
            .zip(expected)
            .all(|(actual, expected)| (i32::from(*actual) - expected).abs() <= 1),
        &format!("CSS mutation did not reach shared UI texture: {sample:?}"),
    )?;
    Ok(
        json!({"pixelsChecked":width*height,"maximumBlendErrorBytes":maximum_error,
        "gameForegroundPixels":foreground,"whiteTextPixels":white_text,"uiSample":sample,
        "rgbaSha256":sha256(pixels)}),
    )
}

pub fn save(path: &Path, pixels: &[u8], width: u32, height: u32) -> Result<()> {
    let mut encoder = png::Encoder::new(BufWriter::new(fs::File::create(path)?), width * 3, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header()?.write_image_data(pixels)?;
    Ok(())
}

pub fn changed_game_pixels(first: &[u8], last: &[u8], width: u32, height: u32) -> usize {
    (0..height)
        .flat_map(|y| (0..width).map(move |x| ((y * width * 3 + width + x) * 4) as usize))
        .filter(|offset| first[*offset..*offset + 4] != last[*offset..*offset + 4])
        .count()
}
