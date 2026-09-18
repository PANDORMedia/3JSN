//! Explicit final-frame assertion capture; never used to transport rendered frames.

use std::{
    fs::File,
    io::{BufWriter, Write},
    path::Path,
    sync::mpsc,
    time::Duration,
};

/// Read one completed RGBA8 frame and write a PNG without creating directories.
pub fn save(
    bridge: &crate::metal::MetalBridge,
    texture: &wgpu::Texture,
    path: &Path,
) -> crate::Result<()> {
    const MAX_ALLOCATION: u64 = 256 * 1024 * 1024;
    if texture.format() != wgpu::TextureFormat::Rgba8Unorm
        || texture.dimension() != wgpu::TextureDimension::D2
        || texture.depth_or_array_layers() != 1
        || texture.sample_count() != 1
        || !texture.usage().contains(wgpu::TextureUsages::COPY_SRC)
    {
        return Err("frame capture requires a single-sample RGBA8Unorm 2D COPY_SRC texture".into());
    }
    let (width, height) = (texture.width(), texture.height());
    if width == 0 || height == 0 {
        return Err("frame capture dimensions must be nonzero".into());
    }
    let row_bytes = width.checked_mul(4).ok_or("frame capture row overflow")?;
    let alignment = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let padded_row_bytes = row_bytes
        .checked_add(alignment - 1)
        .and_then(|value| (value / alignment).checked_mul(alignment))
        .ok_or("frame capture row padding overflow")?;
    let buffer_bytes = u64::from(padded_row_bytes)
        .checked_mul(u64::from(height))
        .ok_or("frame capture buffer overflow")?;
    let pixel_bytes = u64::from(row_bytes)
        .checked_mul(u64::from(height))
        .ok_or("frame capture pixel overflow")?;
    if buffer_bytes
        .checked_add(pixel_bytes)
        .ok_or("frame capture allocation overflow")?
        > MAX_ALLOCATION
        || buffer_bytes > bridge.device.limits().max_buffer_size
    {
        return Err("frame capture exceeds its bounded allocation limit".into());
    }
    let pixel_bytes = usize::try_from(pixel_bytes)?;
    let row_bytes = usize::try_from(row_bytes)?;
    let row_stride = usize::try_from(padded_row_bytes)?;
    let buffer = bridge.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("final window frame assertion readback"),
        size: buffer_bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let read = (|| -> crate::Result<Vec<u8>> {
        let mut encoder = bridge.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_row_bytes),
                    rows_per_image: Some(height),
                },
            },
            texture.size(),
        );
        let submission = bridge.queue.submit([encoder.finish()]);
        let (sender, receiver) = mpsc::channel();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });
        bridge.device.poll(wgpu::PollType::Wait {
            submission_index: Some(submission),
            timeout: Some(Duration::from_secs(15)),
        })?;
        receiver.recv_timeout(Duration::from_secs(5))??;
        let bytes = buffer.slice(..).get_mapped_range();
        let mut pixels = Vec::new();
        pixels.try_reserve_exact(pixel_bytes)?;
        for row in bytes.chunks_exact(row_stride) {
            pixels.extend_from_slice(&row[..row_bytes]);
        }
        Ok(pixels)
    })();
    // Cancel pending mapping and release the staging allocation on timeout too.
    buffer.unmap();
    buffer.destroy();
    let pixels = read?;
    let mut output = BufWriter::new(File::create(path)?);
    let mut encoder = png::Encoder::new(&mut output, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header()?;
    writer.write_image_data(&pixels)?;
    writer.finish()?;
    output.flush()?;
    Ok(())
}
