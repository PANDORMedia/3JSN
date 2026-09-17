mod native;
use native::Native;
use objc2::rc::Retained;
use objc2_metal::MTLTextureType;
use serde_json::json;
use std::{error::Error, ffi::c_void, path::PathBuf, sync::mpsc, time::Duration};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const FRAMES: u32 = 8;
const SHADER: &str = r#"
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8)
fn composite(@builtin(global_invocation_id) p: vec3<u32>) {
    let dimensions = textureDimensions(destination);
    if (p.x >= dimensions.x || p.y >= dimensions.y) { return; }
    var color = textureLoad(source, vec2<i32>(p.xy), 0);
    if (p.x < dimensions.x / 2u) { color = mix(color, vec4<f32>(0, 1, 0, 1), 0.5); }
    textureStore(destination, vec2<i32>(p.xy), color);
}
"#;

fn check_device(device: &wgpu::Device, native: &Native) -> Result<()> {
    // Identity is observed without mutating or releasing wgpu's retained Metal device.
    let hal = unsafe { device.as_hal::<wgpu_hal::api::Metal>() }.ok_or("Expected Metal device")?;
    let raw = Retained::as_ptr(hal.raw_device()).cast::<c_void>();
    if raw != native.device() {
        return Err("OWNERSHIP_GATE: ANGLE and wgpu do not expose the identical MTLDevice object; refusing texture import".into());
    }
    Ok(())
}
fn generation(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    pipeline: &wgpu::ComputePipeline,
    native: &mut Native,
    width: u32,
    height: u32,
) -> Result<u64> {
    check_device(device, native)?;
    let extent = wgpu::Extent3d {
        width,
        height,
        depth_or_array_layers: 1,
    };
    let description = wgpu::TextureDescriptor {
        label: Some("ANGLE owned source"),
        size: extent,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    };
    // Exact device identity is checked above. The bridge completed a zero clear before
    // exposing this private RGBA8 2D texture, with one layer/mip and shader-read usage.
    // Both APIs retain the object, and shared-event handoffs serialize all later access.
    let source = unsafe {
        let texture = wgpu_hal::metal::Device::texture_from_raw(
            native.texture(),
            description.format,
            MTLTextureType::Type2D,
            1,
            1,
            wgpu_hal::CopyExtent {
                width,
                height,
                depth: 1,
            },
        );
        device.create_texture_from_hal::<wgpu_hal::api::Metal>(texture, &description)
    };
    let source_view = source.create_view(&Default::default());
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("wgpu composed target"),
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
        ..description
    });
    let target_view = target.create_view(&Default::default());
    let bindings = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("ANGLE source -> WGSL compositor"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&source_view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&target_view),
            },
        ],
    });
    let row_bytes = (width * 4).div_ceil(256) * 256;
    let mut buffers = Vec::new();
    for frame in 0..FRAMES {
        native.render(frame)?;
        // Commit the wait before wgpu creates any command buffer for this submission.
        native.queue_event(queue, frame, true)?;
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Final validation pixels"),
            size: u64::from(row_bytes * height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("WGSL composition and final validation copy"),
        });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Compose ANGLE GPU texture"),
                timestamp_writes: None,
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &bindings, &[]);
            pass.dispatch_workgroups(width.div_ceil(8), height.div_ceil(8), 1);
        }
        encoder.copy_texture_to_buffer(
            target.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row_bytes),
                    rows_per_image: Some(height),
                },
            },
            extent,
        );
        queue.submit([encoder.finish()]);
        // wgpu submitted all of this frame before the raw queue signals ANGLE's reuse event.
        native.queue_event(queue, frame, false)?;
        buffers.push(readback);
    }
    native.finish(FRAMES)?;
    let mut notifications = Vec::new();
    for buffer in &buffers {
        let (sender, receiver) = mpsc::channel();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });
        notifications.push(receiver);
    }
    device.poll(wgpu::PollType::Wait {
        submission_index: None,
        timeout: Some(Duration::from_secs(10)),
    })?;
    for (frame, (buffer, receiver)) in buffers.iter().zip(notifications).enumerate() {
        receiver.recv_timeout(Duration::from_secs(5))??;
        let bytes = buffer.slice(..).get_mapped_range();
        let expected = if frame % 2 == 0 {
            [64.0, 128.0, 191.0, 255.0]
        } else {
            [191.0, 64.0, 128.0, 255.0]
        };
        for y in 0..height {
            for x in 0..width {
                for channel in 0..4 {
                    let mut value = expected[channel];
                    if x < width / 2 {
                        value = value * 0.5
                            + if channel == 1 || channel == 3 {
                                127.5
                            } else {
                                0.0
                            };
                    }
                    let actual = f64::from(bytes[(y * row_bytes + x * 4) as usize + channel]);
                    if (actual - value).abs() > 1.1 {
                        return Err(format!("Pixel mismatch frame {frame}, ({x},{y}), channel {channel}: {actual} expected {value}").into());
                    }
                }
            }
        }
        drop(bytes);
        buffer.unmap();
    }
    Ok(u64::from(width * height * FRAMES))
}

fn main() -> Result<()> {
    let libraries = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("usage: probe <ANGLE-library-directory>")?,
    );
    let first = Native::new(&libraries, 32, 16)?;
    let renderer = first.renderer();
    let version = first.version();
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::METAL,
        flags: wgpu::InstanceFlags::VALIDATION,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))?;
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))?;
    check_device(&device, &first)?;
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("WGSL native composition"),
        source: wgpu::ShaderSource::Wgsl(SHADER.into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("Composite ANGLE texture"),
        layout: None,
        module: &shader,
        entry_point: Some("composite"),
        compilation_options: Default::default(),
        cache: None,
    });
    let sizes = [(32, 16), (64, 32), (96, 24)];
    let mut initial = Some(first);
    let mut pixels = 0;
    for _ in 0..4 {
        for (width, height) in sizes {
            let mut native = match initial.take() {
                Some(first) => first,
                None => Native::new(&libraries, width, height)?,
            };
            pixels += generation(&device, &queue, &pipeline, &mut native, width, height)?;
        }
    }
    let report = json!({
        "status":"pass", "wgpu":"29.0.1", "wgpuCore":"29.0.1", "wgpuHal":"29.0.4", "wgpuTypes":"29.0.1",
        "renderer":renderer,"glesVersion":version,"wgpuAdapter":adapter.get_info().name,
        "exactMTLDeviceIdentityChecked":true,"wgpuQueueDeviceIdentityChecked":true,
        "frames":12*FRAMES,"textureGenerations":12,"pixelsChecked":pixels,"framesQueuedBeforeCpuWait":FRAMES,
        "sizes":sizes,"transport":"Retained private ANGLE MTLTexture imported into wgpu-core through the public Metal HAL texture API",
        "composition":"WGSL textureLoad and blend into a distinct wgpu storage texture",
        "synchronization":"Bidirectional GPU MTLSharedEvent handoff; wait and signal command buffers committed on wgpu's actual native queue around each wgpu submission",
        "initialization":"One completed GL zero clear per imported texture before unsafe HAL import",
        "cpuReadback":"Only final composed pixels for validation; no producer-to-compositor CPU image transport",
        "validation":"wgpu InstanceFlags::VALIDATION; Metal validation availability recorded by runner",
        "unverified":["deno_webgpu registry integration","JavaScript WebGL binding","native window presentation","HTML DOM compositor","device loss","performance","Windows/Linux"]
    });
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
