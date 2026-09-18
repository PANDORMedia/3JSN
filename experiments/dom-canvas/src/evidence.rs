use std::{fs, io::BufWriter, path::Path, sync::mpsc, time::Duration};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{Result, check, metal::MetalBridge};

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn read(bridge: &MetalBridge, texture: &wgpu::Texture) -> Result<Vec<u8>> {
    let (width, height) = (texture.width(), texture.height());
    let row_bytes = (width * 4).div_ceil(256) * 256;
    let buffer = bridge.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("DOM canvas assertion readback"),
        size: u64::from(row_bytes) * u64::from(height),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = bridge.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(row_bytes),
                rows_per_image: Some(height),
            },
        },
        texture.size(),
    );
    bridge.queue.submit([encoder.finish()]);
    let (sender, receiver) = mpsc::channel();
    buffer
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
    bridge.device.poll(wgpu::PollType::Wait {
        submission_index: None,
        timeout: Some(Duration::from_secs(15)),
    })?;
    receiver.recv_timeout(Duration::from_secs(5))??;
    let bytes = buffer.slice(..).get_mapped_range();
    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    for row in bytes.chunks_exact(row_bytes as usize) {
        pixels.extend_from_slice(&row[..(width * 4) as usize]);
    }
    drop(bytes);
    buffer.unmap();
    buffer.destroy();
    Ok(pixels)
}

pub fn pixel(pixels: &[u8], x: usize, y: usize) -> &[u8] {
    let offset = (y * 448 + x) * 4;
    &pixels[offset..offset + 4]
}

pub fn expect(pixels: &[u8], x: usize, y: usize, expected: [u8; 4]) -> Result<()> {
    let actual = pixel(pixels, x, y);
    check(
        actual.iter().zip(expected).all(|(a, b)| a.abs_diff(b) <= 2),
        &format!("pixel ({x},{y}) expected {expected:?}, got {actual:?}"),
    )
}

pub fn save(path: &Path, pixels: &[u8]) -> Result<Value> {
    check(
        pixels.len() == 448 * 256 * 4,
        "wrong assertion image length",
    )?;
    check(
        pixels.chunks_exact(4).all(|p| p[3] == 255),
        "final DOM image is not opaque",
    )?;
    let text_pixels = (192..224)
        .flat_map(|y| (24..180).map(move |x| (x, y)))
        .filter(|&(x, y)| pixel(pixels, x, y)[..3].iter().all(|c| *c > 235))
        .count();
    check(text_pixels > 100, "caption glyphs did not paint")?;
    let mut encoder = png::Encoder::new(BufWriter::new(fs::File::create(path)?), 448, 256);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header()?.write_image_data(pixels)?;
    Ok(
        json!({"rgbaSha256":sha256(pixels),"whiteCaptionPixels":text_pixels,"pixelsChecked":448*256}),
    )
}
