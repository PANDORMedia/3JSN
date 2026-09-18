use deno_webgpu::texture::{GPUTexture, GPUTextureDimension};
use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_metal::{
    MTLCommandQueue, MTLHazardTrackingMode, MTLPixelFormat, MTLResource, MTLStorageMode,
    MTLTexture, MTLTextureType,
};

use crate::{Result, metal::MetalBridge};

const CONVERT: &str = r#"
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var output_image: texture_storage_2d<rgba8unorm, write>;

fn convert(position: vec3<u32>, premultiplied: bool) {
    if any(position.xy >= textureDimensions(source)) { return; }
    let pixel = vec2<i32>(position.xy);
    let value = textureLoad(source, pixel, 0);
    var straight = vec4<f32>(value.rgb, 1.0);
    if premultiplied {
        straight = vec4<f32>(0.0);
        if value.a > 0.0 { straight = vec4<f32>(value.rgb / value.a, value.a); }
    }
    textureStore(output_image, pixel, straight);
}

@compute @workgroup_size(8, 8, 1)
fn opaque(@builtin(global_invocation_id) position: vec3<u32>) { convert(position, false); }

@compute @workgroup_size(8, 8, 1)
fn premultiplied(@builtin(global_invocation_id) position: vec3<u32>) { convert(position, true); }
"#;

/// Persistent host images survive expiry of the application's current texture.
/// Vello retains a clone of `texture`; neither image owns the source's core ID.
pub struct CanvasImage {
    pub texture: wgpu::Texture,
    snapshot: wgpu::Texture,
    size: wgpu::Extent3d,
    source_format: wgpu::TextureFormat,
    device: wgpu::Device,
    queue: wgpu::Queue,
    opaque: wgpu::ComputePipeline,
    premultiplied: wgpu::ComputePipeline,
    bindings: wgpu::BindGroup,
}

impl CanvasImage {
    /// Allocate host storage without reading or importing uninitialized pixels.
    pub fn new(bridge: &MetalBridge, source: &GPUTexture) -> Result<Self> {
        let (size, source_format) = description(bridge, source)?;
        drop(retain_source(bridge, source, size, source_format)?);
        let descriptor = wgpu::TextureDescriptor {
            label: Some("DOM canvas native snapshot"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: source_format,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        };
        let snapshot = bridge.device.create_texture(&descriptor);
        let texture = bridge.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("DOM canvas straight RGBA for Vello"),
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            ..descriptor
        });
        let shader = bridge
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("DOM canvas alpha conversion"),
                source: wgpu::ShaderSource::Wgsl(CONVERT.into()),
            });
        let layout = bridge
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("DOM canvas conversion bindings"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::StorageTexture {
                            access: wgpu::StorageTextureAccess::WriteOnly,
                            format: wgpu::TextureFormat::Rgba8Unorm,
                            view_dimension: wgpu::TextureViewDimension::D2,
                        },
                        count: None,
                    },
                ],
            });
        let pipeline_layout =
            bridge
                .device
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("DOM canvas conversion layout"),
                    bind_group_layouts: &[Some(&layout)],
                    immediate_size: 0,
                });
        let pipeline = |entry_point| {
            bridge
                .device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("DOM canvas alpha conversion"),
                    layout: Some(&pipeline_layout),
                    module: &shader,
                    entry_point: Some(entry_point),
                    compilation_options: Default::default(),
                    cache: None,
                })
        };
        let opaque = pipeline("opaque");
        let premultiplied = pipeline("premultiplied");
        let bindings = bridge.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("DOM canvas snapshot to straight RGBA"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(
                        &snapshot.create_view(&Default::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        &texture.create_view(&Default::default()),
                    ),
                },
            ],
        });
        Ok(Self {
            texture,
            snapshot,
            size,
            source_format,
            device: bridge.device.clone(),
            queue: bridge.queue.clone(),
            opaque,
            premultiplied,
            bindings,
        })
    }

    /// Snapshot the current canvas and convert its alpha representation for Vello.
    ///
    /// # Safety
    ///
    /// Every source texel must be initialized by producer work already submitted
    /// on the bridge's native queue, including pending writes flushed by Deno.
    /// The two registries must be used serially: no concurrent source access or
    /// unsubmitted producer work may cross this handoff. Keep the source alive
    /// until this call returns, then its JS texture may expire. Both registries
    /// and their devices remain alive until a successful teardown drain.
    ///
    /// Deno's initialization tracker is private. These conditions are established
    /// by the trusted full-clear fixture; this is not a generic canvas export API.
    pub unsafe fn update(
        &mut self,
        bridge: &MetalBridge,
        source: &GPUTexture,
        premultiplied: bool,
    ) -> Result<()> {
        check(
            bridge.device == self.device && bridge.queue == self.queue,
            "canvas snapshot belongs to a different wrapper device or queue",
        )?;
        let (size, format) = description(bridge, source)?;
        check(
            size == self.size && format == self.source_format,
            "canvas dimensions or format changed; recreate CanvasImage before updating",
        )?;
        let native = retain_source(bridge, source, size, format)?;
        let descriptor = wgpu::TextureDescriptor {
            label: Some("Host-only canvas copy alias"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        };
        // SAFETY: native identity, shape, format, blit support and hazards were
        // checked with HAL guards. The caller establishes initialization and
        // queue ordering; importing does not consult Deno's lazy-init tracker.
        // COPY_SRC grants only this host alias permission, never the JS texture.
        let alias = unsafe {
            let hal = wgpu_hal::metal::Device::texture_from_raw(
                native,
                format,
                MTLTextureType::Type2D,
                1,
                1,
                wgpu_hal::CopyExtent {
                    width: size.width,
                    height: size.height,
                    depth: 1,
                },
            );
            bridge
                .device
                .create_texture_from_hal::<wgpu_hal::api::Metal>(hal, &descriptor)
        };
        let mut encoder = bridge
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("DOM canvas GPU snapshot and alpha conversion"),
            });
        encoder.copy_texture_to_texture(alias.as_image_copy(), self.snapshot.as_image_copy(), size);
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("DOM canvas alpha conversion"),
                timestamp_writes: None,
            });
            pass.set_pipeline(if premultiplied {
                &self.premultiplied
            } else {
                &self.opaque
            });
            pass.set_bind_group(0, &self.bindings, &[]);
            pass.dispatch_workgroups(size.width.div_ceil(8), size.height.div_ceil(8), 1);
        }
        bridge.queue.submit([encoder.finish()]);
        // Ordinary drop leaves the independently retained native texture owned
        // by submitted wrapper work until completion. Never destroy the alias.
        drop(alias);
        Ok(())
    }
}

fn description(
    bridge: &MetalBridge,
    source: &GPUTexture,
) -> Result<(wgpu::Extent3d, wgpu::TextureFormat)> {
    let size = source.size;
    let format = wgpu::TextureFormat::from(source.format.clone());
    check(
        matches!(source.dimension, GPUTextureDimension::D2)
            && size.width > 0
            && size.height > 0
            && size.depth_or_array_layers == 1
            && source.mip_level_count == 1
            && source.sample_count == 1,
        "canvas snapshot requires nonempty 2D texture with one layer, mip and sample",
    )?;
    check(
        matches!(
            format,
            wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Bgra8Unorm
        ),
        "canvas snapshot supports only rgba8unorm and bgra8unorm",
    )?;
    let limits = bridge.device.limits();
    check(
        size.width <= limits.max_texture_dimension_2d
            && size.height <= limits.max_texture_dimension_2d,
        "canvas snapshot exceeds the wrapper device's 2D texture limit",
    )?;
    Ok((size, format))
}

fn retain_source(
    bridge: &MetalBridge,
    source: &GPUTexture,
    size: wgpu::Extent3d,
    format: wgpu::TextureFormat,
) -> Result<Retained<ProtocolObject<dyn MTLTexture>>> {
    // SAFETY: guards protect the borrowed native objects while inspected and
    // retained. No handle is destroyed. All guards end before wrapper import.
    unsafe {
        let wrapper_device = bridge
            .device
            .as_hal::<wgpu_hal::api::Metal>()
            .ok_or("canvas wrapper device is not Metal")?;
        let wrapper_queue = bridge
            .queue
            .as_hal::<wgpu_hal::api::Metal>()
            .ok_or("canvas wrapper queue is not Metal")?;
        let producer_device = source
            .instance
            .device_as_hal::<wgpu_hal::api::Metal>(source.device_id)
            .ok_or("canvas producer device is not Metal")?;
        let producer_queue = source
            .instance
            .queue_as_hal::<wgpu_hal::api::Metal>(source.queue_id)
            .ok_or("canvas producer queue is not Metal")?;
        check(
            std::ptr::eq(
                &**producer_device.raw_device(),
                &**wrapper_device.raw_device(),
            ) && std::ptr::eq(producer_queue.as_raw(), wrapper_queue.as_raw()),
            "canvas producer and wrapper must share the identical native device and queue",
        )?;
        let texture = source
            .instance
            .texture_as_hal::<wgpu_hal::api::Metal>(source.id)
            .ok_or("canvas source texture is destroyed or is not Metal")?;
        let native = texture.raw_handle();
        check(
            std::ptr::eq(&*native.device(), &**wrapper_device.raw_device())
                && std::ptr::eq(
                    &*wrapper_queue.as_raw().device(),
                    &**wrapper_device.raw_device(),
                ),
            "canvas native texture or queue belongs to another Metal device",
        )?;
        let native_format = match format {
            wgpu::TextureFormat::Rgba8Unorm => MTLPixelFormat::RGBA8Unorm,
            wgpu::TextureFormat::Bgra8Unorm => MTLPixelFormat::BGRA8Unorm,
            _ => return Err("unsupported native canvas format".into()),
        };
        check(
            native.textureType() == MTLTextureType::Type2D
                && native.pixelFormat() == native_format
                && native.width() == size.width as usize
                && native.height() == size.height as usize
                && native.depth() == 1
                && native.arrayLength() == 1
                && native.mipmapLevelCount() == 1
                && native.sampleCount() == 1,
            "native canvas texture does not match the declared format or dimensions",
        )?;
        check(
            native.hazardTrackingMode() == MTLHazardTrackingMode::Tracked,
            "canvas interop requires tracked Metal texture hazards",
        )?;
        check(
            !native.isFramebufferOnly()
                && !native.isAliasable()
                && native.storageMode() != MTLStorageMode::Memoryless,
            "canvas source does not permit a retained native blit",
        )?;
        // Metal blits require no ShaderRead flag. A render-only source therefore
        // keeps its original native and JS usages while this alias is copy-only.
        Retained::retain(std::ptr::from_ref(native).cast_mut())
            .ok_or_else(|| "could not retain the native canvas texture".into())
    }
}

fn check(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}
