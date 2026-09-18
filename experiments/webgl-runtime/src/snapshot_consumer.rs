//! One retained ANGLE snapshot imported into wgpu on the identical Metal device.
//! Producer and consumer access use the snapshot's bidirectional event protocol;
//! the converted RGBA8 output is independent storage and never a CPU frame copy.

use std::{
    ffi::c_void,
    panic::{AssertUnwindSafe, catch_unwind},
    time::Duration,
};

use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_metal::{
    MTLCommandQueue, MTLHazardTrackingMode, MTLPixelFormat, MTLResource, MTLStorageMode,
    MTLTexture, MTLTextureType, MTLTextureUsage,
};

use crate::Snapshot;

const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const DRAIN_TIMEOUT_NS: u64 = 5_000_000_000;
const CONVERT: &str = r#"
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba8unorm, write>;

fn convert(p: vec3<u32>, alpha_conversion: u32) {
    let dimensions = textureDimensions(destination);
    if any(p.xy >= dimensions) { return; }
    let source_pixel = vec2<i32>(i32(p.x), i32(dimensions.y - 1u - p.y));
    var color = textureLoad(source, source_pixel, 0);
    if alpha_conversion == 1u {
        color = vec4<f32>(color.rgb * color.a, color.a);
    } else if alpha_conversion == 2u {
        if color.a > 0.0 {
            color = vec4<f32>(color.rgb / color.a, color.a);
        } else {
            color = vec4<f32>(0.0);
        }
    }
    textureStore(destination, vec2<i32>(p.xy), color);
}

@compute @workgroup_size(8, 8, 1)
fn preserve(@builtin(global_invocation_id) p: vec3<u32>) { convert(p, 0u); }

@compute @workgroup_size(8, 8, 1)
fn premultiply(@builtin(global_invocation_id) p: vec3<u32>) { convert(p, 1u); }

@compute @workgroup_size(8, 8, 1)
fn unpremultiply(@builtin(global_invocation_id) p: vec3<u32>) { convert(p, 2u); }
"#;

/// Conversion applied with the vertical flip into independent RGBA8 storage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlphaConversion {
    /// Preserve all four stored channels, including RGB when alpha is zero.
    Preserve,
    /// Convert straight RGB to premultiplied RGB by multiplying by alpha.
    Premultiply,
    /// Convert premultiplied RGB to straight RGB. Zero alpha produces zero RGBA.
    Unpremultiply,
}

struct Resources {
    snapshot: Snapshot,
    device: wgpu::Device,
    queue: wgpu::Queue,
    // This HAL alias has its own native retain, separate from Snapshot's lease.
    _source: wgpu::Texture,
    output: wgpu::Texture,
    pipeline: wgpu::ComputePipeline,
    bindings: wgpu::BindGroup,
    size: wgpu::Extent3d,
}

/// Owner-thread consumer of one fixed-size native snapshot generation.
///
/// The source is private; callers receive only independently allocated output.
/// A failed handoff poisons updates. Explicit close or Drop first drains both
/// sides, retaining the entire lease on failure instead of releasing live aliases.
/// The caller must continue checking its wgpu device's validation/error handler;
/// native handoff success is not a substitute for GPU execution validation.
pub struct GpuSnapshot {
    resources: Option<Resources>,
    failure: Option<String>,
    has_frame: bool,
}

impl GpuSnapshot {
    /// Import Snapshot's initialized, privately owned RGBA8 texture once.
    ///
    /// `alpha_conversion` must match the producer's stored alpha convention and
    /// the output consumer's requirements; this does not change the GL context.
    /// The same texture is reused until close; bitmap resize requires a new
    /// snapshot generation after closing the previous one.
    pub fn new(
        snapshot: Snapshot,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        alpha_conversion: AlphaConversion,
    ) -> Result<Self, String> {
        let (width, height) = snapshot.size();
        let limits = device.limits();
        if width == 0
            || height == 0
            || width > limits.max_texture_dimension_2d
            || height > limits.max_texture_dimension_2d
        {
            return Err("snapshot dimensions exceed the consumer's 2D texture limits".into());
        }
        let native = retain_source(&snapshot, device, queue)?;
        let size = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        let descriptor = wgpu::TextureDescriptor {
            label: Some("Retained ANGLE snapshot source"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        };
        // SAFETY: Snapshot creation completes initialization before exposing this
        // private texture. retain_source checks exact device, dimensions, format,
        // shader usage and hazards. Its independent retain transfers into HAL.
        // Only update can access the imported alias, after its producer wait.
        let source = unsafe {
            let texture = wgpu_hal::metal::Device::texture_from_raw(
                native,
                descriptor.format,
                MTLTextureType::Type2D,
                1,
                1,
                wgpu_hal::CopyExtent {
                    width,
                    height,
                    depth: 1,
                },
            );
            device.create_texture_from_hal::<wgpu_hal::api::Metal>(texture, &descriptor)
        };
        let output = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("WebGL canvas top-left RGBA snapshot"),
            usage: wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::TEXTURE_BINDING,
            ..descriptor
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("WebGL snapshot orientation and alpha conversion"),
            source: wgpu::ShaderSource::Wgsl(CONVERT.into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("WebGL snapshot conversion"),
            layout: None,
            module: &shader,
            entry_point: Some(match alpha_conversion {
                AlphaConversion::Preserve => "preserve",
                AlphaConversion::Premultiply => "premultiply",
                AlphaConversion::Unpremultiply => "unpremultiply",
            }),
            compilation_options: Default::default(),
            cache: None,
        });
        let bindings = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("WebGL snapshot conversion bindings"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(
                        &source.create_view(&Default::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        &output.create_view(&Default::default()),
                    ),
                },
            ],
        });
        Ok(Self {
            resources: Some(Resources {
                snapshot,
                device: device.clone(),
                queue: queue.clone(),
                _source: source,
                output,
                pipeline,
                bindings,
                size,
            }),
            failure: None,
            has_frame: false,
        })
    }

    /// Persistent output of a successfully submitted update, available for later
    /// commands on the same serialized queue. Completion is not implied here.
    pub fn texture(&self) -> Result<&wgpu::Texture, String> {
        let resources = self
            .resources
            .as_ref()
            .ok_or("snapshot consumer is closed")?;
        if let Some(error) = &self.failure {
            return Err(format!("snapshot consumer is poisoned: {error}"));
        }
        if !self.has_frame {
            return Err("snapshot consumer has not submitted a frame".into());
        }
        Ok(&resources.output)
    }

    /// Publish, wait, convert, submit and acknowledge one native snapshot token.
    ///
    /// # Safety
    ///
    /// The supplied device and queue must be a pair from the same wgpu device.
    /// Use the owning thread and serialize all access to this queue across this
    /// call. No pre-existing unsubmitted encoder/command buffer may straddle
    /// the raw Metal wait/signal handoffs. The source must remain exclusively
    /// controlled by Snapshot; callers must not submit independent writes to it.
    /// Later consumers of the output must submit on this same ordered queue.
    pub unsafe fn update(&mut self) -> Result<u64, String> {
        let resources = self
            .resources
            .as_mut()
            .ok_or("snapshot consumer is closed")?;
        if let Some(error) = &self.failure {
            return Err(format!("snapshot consumer is poisoned: {error}"));
        }
        // Set before any publication: errors and panics cannot expose a previous
        // output as a newly completed handoff or allow an unsafe producer retry.
        self.failure = Some("snapshot update did not complete".into());
        // SAFETY: the caller supplies exclusive queue ordering for this handoff.
        match unsafe { resources.update() } {
            Ok(token) => {
                self.failure = None;
                self.has_frame = true;
                Ok(token)
            }
            Err(error) => {
                self.failure = Some(error.clone());
                Err(error)
            }
        }
    }

    /// Stop updates, drain both queues with bounded waits and release the lease.
    /// Failure retains all resources for an explicit retry or Drop's final drain.
    /// This does not process JavaScript event-loop notifications.
    pub fn close(&mut self) -> Result<(), String> {
        let Some(resources) = self.resources.as_mut() else {
            return Ok(());
        };
        self.failure
            .get_or_insert_with(|| "snapshot consumer is closing".into());
        let result = catch_unwind(AssertUnwindSafe(|| resources.close()));
        match result {
            Ok(Ok(())) => {
                self.resources.take();
                self.has_frame = false;
                self.failure = None;
                Ok(())
            }
            Ok(Err(error)) => {
                self.failure = Some(error.clone());
                Err(error)
            }
            Err(_) => {
                let error = "snapshot teardown panicked; retained resources were not released";
                self.failure = Some(error.into());
                Err(error.into())
            }
        }
    }
}

impl Resources {
    unsafe fn update(&mut self) -> Result<u64, String> {
        // Flush wgpu's deferred writes before the raw wait. Their internal Metal
        // command buffer may already exist even without a caller-owned encoder.
        self.queue.submit([]);
        let token = self.snapshot.publish()?;
        {
            // SAFETY: the owned Queue retains this Metal queue throughout the
            // native call. The caller guarantees serialized consumer submission.
            let queue = unsafe { self.queue.as_hal::<wgpu_hal::api::Metal>() }
                .ok_or("snapshot consumer queue is no longer Metal")?;
            let raw = (queue.as_raw() as *const ProtocolObject<dyn MTLCommandQueue>)
                .cast_mut()
                .cast::<c_void>();
            unsafe { self.snapshot.queue_wait(raw, token)? };
        }
        // Create only after the raw wait is committed; Metal command-buffer
        // enqueue order must not put the conversion ahead of its producer.
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Consume WebGL native snapshot"),
            });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("WebGL snapshot flip and alpha conversion"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bindings, &[]);
            pass.dispatch_workgroups(self.size.width.div_ceil(8), self.size.height.div_ceil(8), 1);
        }
        self.queue.submit([encoder.finish()]);
        {
            // SAFETY: all conversion commands were submitted before this signal;
            // the snapshot may not overwrite its source until the token completes.
            let queue = unsafe { self.queue.as_hal::<wgpu_hal::api::Metal>() }
                .ok_or("snapshot consumer queue is no longer Metal")?;
            let raw = (queue.as_raw() as *const ProtocolObject<dyn MTLCommandQueue>)
                .cast_mut()
                .cast::<c_void>();
            unsafe { self.snapshot.queue_signal(raw, token)? };
        }
        Ok(token)
    }

    fn close(&mut self) -> Result<(), String> {
        // A final ordered submission also sits after the raw event command
        // buffers; polling only an earlier wgpu index would not cover them.
        let tail = self.queue.submit([]);
        self.device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(tail),
                timeout: Some(DRAIN_TIMEOUT),
            })
            .map_err(|error| format!("snapshot consumer drain failed: {error}"))?;
        self.snapshot
            .drain(DRAIN_TIMEOUT_NS)
            .map_err(|error| format!("snapshot producer drain failed: {error}"))?;
        self.snapshot
            .close()
            .map_err(|error| format!("snapshot lease close failed: {error}"))
    }
}

impl Drop for GpuSnapshot {
    fn drop(&mut self) {
        if let Err(error) = self.close() {
            if let Some(resources) = self.resources.take() {
                // Completion is unknown. Keep the native lease, HAL alias,
                // bindings, device and queue alive as one failed generation.
                std::mem::forget(resources);
            }
            eprintln!("WebGL snapshot teardown failed; resources deliberately retained: {error}");
        }
    }
}

fn retain_source(
    snapshot: &Snapshot,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
) -> Result<Retained<ProtocolObject<dyn MTLTexture>>, String> {
    // SAFETY: Snapshot owns both borrowed native objects; HAL guards protect the
    // consumer handles during inspection. The only ownership operation is retain.
    unsafe {
        let device = device
            .as_hal::<wgpu_hal::api::Metal>()
            .ok_or("snapshot consumer device is not Metal")?;
        let queue = queue
            .as_hal::<wgpu_hal::api::Metal>()
            .ok_or("snapshot consumer queue is not Metal")?;
        let raw_device = Retained::as_ptr(device.raw_device())
            .cast_mut()
            .cast::<c_void>();
        if raw_device != snapshot.device_raw()
            || !std::ptr::eq(&*queue.as_raw().device(), &**device.raw_device())
        {
            return Err(
                "ANGLE snapshot, consumer device and queue must share the identical MTLDevice"
                    .into(),
            );
        }
        let texture: Retained<ProtocolObject<dyn MTLTexture>> =
            Retained::retain(snapshot.texture_raw().cast())
                .ok_or("snapshot has no retained native texture")?;
        let (width, height) = snapshot.size();
        if !std::ptr::eq(&*texture.device(), &**device.raw_device())
            || texture.textureType() != MTLTextureType::Type2D
            || texture.pixelFormat() != MTLPixelFormat::RGBA8Unorm
            || texture.width() != width as usize
            || texture.height() != height as usize
            || texture.depth() != 1
            || texture.arrayLength() != 1
            || texture.mipmapLevelCount() != 1
            || texture.sampleCount() != 1
        {
            return Err(
                "native snapshot texture differs from its declared RGBA8 2D extent or device"
                    .into(),
            );
        }
        if !texture.usage().contains(MTLTextureUsage::ShaderRead)
            || texture.hazardTrackingMode() != MTLHazardTrackingMode::Tracked
            || texture.isFramebufferOnly()
            || texture.isAliasable()
            || texture.storageMode() == MTLStorageMode::Memoryless
        {
            return Err(
                "native snapshot texture lacks retained shader-read storage or tracked hazards"
                    .into(),
            );
        }
        Ok(texture)
    }
}
