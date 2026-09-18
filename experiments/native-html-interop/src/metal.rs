//! Metal-only experiment: two wgpu registries sharing one native device and queue.

use std::{borrow::Cow, error::Error, time::Duration};

use deno_webgpu::{Instance, wgpu_core::id};
use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_metal::{
    MTLCommandQueue, MTLDevice, MTLHazardTrackingMode, MTLPixelFormat, MTLResource, MTLTexture,
    MTLTextureType, MTLTextureUsage,
};
use wgpu_hal::Adapter as _;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

/// The host keeps Deno's device/queue alive, serializes both registries' work,
/// and drains both owners before teardown. Sharing native objects does not share
/// wgpu resource IDs, validation state, pending writes, or completion fences.
pub struct MetalBridge {
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    deno: Instance,
    deno_device: id::DeviceId,
    deno_queue: id::QueueId,
    native_device: Retained<ProtocolObject<dyn MTLDevice>>,
}

impl MetalBridge {
    pub fn new(deno: Instance, device_id: id::DeviceId, queue_id: id::QueueId) -> Result<Self> {
        let wrapper = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::METAL,
            flags: wgpu::InstanceFlags::VALIDATION,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        Self::with_instance(deno, device_id, queue_id, &wrapper)
    }

    /// Reuse the instance that created the native presentation surface. Device
    /// and queue identity are still checked before sharing any canvas storage.
    pub fn with_instance(
        deno: Instance,
        device_id: id::DeviceId,
        queue_id: id::QueueId,
        wrapper: &wgpu::Instance,
    ) -> Result<Self> {
        // The guards keep core objects alive while Objective-C references are
        // retained. Neither native object is manually destroyed or transferred.
        let (native_device, native_queue) = unsafe {
            let device = deno
                .device_as_hal::<wgpu_hal::api::Metal>(device_id)
                .ok_or("Deno device is not Metal")?;
            let queue = deno
                .queue_as_hal::<wgpu_hal::api::Metal>(queue_id)
                .ok_or("Deno queue is not Metal")?;
            let native_device = device.raw_device().clone();
            let raw_queue = queue.as_raw();
            ensure(
                same_device(&raw_queue.device(), &native_device),
                "Deno queue belongs to a different native device",
            )?;
            let native_queue = Retained::retain(std::ptr::from_ref(raw_queue).cast_mut())
                .ok_or("could not retain Deno Metal queue")?;
            (native_device, native_queue)
        };
        let timestamp_period = deno.queue_get_timestamp_period(queue_id);
        ensure(
            timestamp_period.is_finite() && timestamp_period > 0.0,
            "Deno queue has an invalid timestamp period",
        )?;
        let descriptor = wgpu::DeviceDescriptor {
            label: Some("Vello on Deno's native Metal queue"),
            ..Default::default()
        };
        for adapter in pollster::block_on(wrapper.enumerate_adapters(wgpu::Backends::METAL)) {
            if !adapter.features().contains(descriptor.required_features)
                || !descriptor.required_limits.check_limits(&adapter.limits())
            {
                continue;
            }
            // Metal exposes no public raw-device getter on Adapter. Opening it
            // establishes provenance and lets us compare the exact device. Its
            // unused queue is replaced and released before wrapper registration.
            let mut opened = unsafe {
                let adapter = adapter
                    .as_hal::<wgpu_hal::api::Metal>()
                    .ok_or("enumerated adapter is not Metal")?;
                adapter.open(
                    descriptor.required_features,
                    &descriptor.required_limits,
                    &descriptor.memory_hints,
                )?
            };
            if !same_device(opened.device.raw_device(), &native_device) {
                continue;
            }
            // SAFETY: this retained queue belongs to the identical MTLDevice.
            // The HAL device came from this adapter with the checked descriptor.
            // The caller serializes submissions and bounds outstanding encoders
            // across both queue wrappers, whose counters are independent.
            let (device, queue) = unsafe {
                opened.queue =
                    wgpu_hal::metal::Queue::queue_from_raw(native_queue.clone(), timestamp_period);
                adapter.create_device_from_hal::<wgpu_hal::api::Metal>(opened, &descriptor)?
            };
            {
                // Inspect only; dropping guards does not destroy native objects.
                let (device, queue) = unsafe {
                    (
                        device.as_hal::<wgpu_hal::api::Metal>(),
                        queue.as_hal::<wgpu_hal::api::Metal>(),
                    )
                };
                let device = device.ok_or("imported wrapper device is not Metal")?;
                let queue = queue.ok_or("imported wrapper queue is not Metal")?;
                ensure(
                    same_device(device.raw_device(), &native_device),
                    "wrapper changed the native device identity",
                )?;
                ensure(
                    std::ptr::eq(queue.as_raw(), &*native_queue),
                    "wrapper changed the native queue identity",
                )?;
            }
            return Ok(Self {
                adapter,
                device,
                queue,
                deno,
                deno_device: device_id,
                deno_queue: queue_id,
                native_device,
            });
        }
        Err("no compatible wrapper adapter exposes Deno's identical MTLDevice".into())
    }

    /// Flush and drain both registries before generation teardown, including
    /// after a failed render. Call while producer and imported aliases remain
    /// alive. This is a bounded cleanup barrier, never a per-frame handoff.
    /// A failed drain must be reported; it does not certify orderly teardown.
    pub fn drain(&self) -> Result<()> {
        let deno_flush = self
            .deno
            .queue_submit(self.deno_queue, &[])
            .map_err(|(_, error)| format!("Deno cleanup submit failed: {error}"));
        self.queue.submit([]);
        // Attempt both waits even if one registry has lost its device. Queue
        // fences and deferred resource destruction belong to separate cores.
        let wrapper_wait = self.device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(15)),
        });
        let deno_wait = self.deno.device_poll(
            self.deno_device,
            wgpu_types::PollType::Wait {
                submission_index: None,
                timeout: Some(Duration::from_secs(15)),
            },
        );
        let mut errors = Vec::new();
        if let Err(error) = deno_flush {
            errors.push(error);
        }
        if let Err(error) = wrapper_wait {
            errors.push(format!("wrapper cleanup wait failed: {error}"));
        }
        if let Err(error) = deno_wait {
            errors.push(format!("Deno cleanup wait failed: {error}"));
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; ").into())
        }
    }

    /// Import an owned Objective-C reference into Deno's separate texture registry.
    /// The returned ID transfers to the caller, which must drop it exactly once.
    /// This probe accepts only single-layer/mip/sample RGBA8 textures without views.
    ///
    /// # Safety
    ///
    /// The entire texture must already be initialized by completed GPU work.
    /// The caller must flush producer pending writes and serialize all later
    /// accesses on the shared queue; neither registry tracks the other alias.
    /// Deno's device must remain live. All imported and source resources must
    /// remain alive through their GPU uses, and both queues must be drained
    /// before their owners are destroyed. No surface texture may be imported.
    pub unsafe fn import_texture_to_deno(
        &self,
        texture: &wgpu::Texture,
        descriptor: &wgpu::TextureDescriptor<'_>,
    ) -> Result<id::TextureId> {
        ensure(
            descriptor.dimension == wgpu::TextureDimension::D2
                && descriptor.format == wgpu::TextureFormat::Rgba8Unorm
                && descriptor.size.width > 0
                && descriptor.size.height > 0
                && descriptor.size.depth_or_array_layers == 1
                && descriptor.mip_level_count == 1
                && descriptor.sample_count == 1
                && descriptor.view_formats.is_empty(),
            "import requires nonempty RGBA8 2D texture with one layer/mip/sample and no view formats",
        )?;
        ensure(
            texture.size() == descriptor.size
                && texture.dimension() == descriptor.dimension
                && texture.format() == descriptor.format
                && texture.mip_level_count() == descriptor.mip_level_count
                && texture.sample_count() == descriptor.sample_count
                && texture.usage() == descriptor.usage,
            "import descriptor disagrees with wrapper texture",
        )?;
        let limits = self.deno.device_limits(self.deno_device);
        ensure(
            descriptor.size.width <= limits.max_texture_dimension_2d
                && descriptor.size.height <= limits.max_texture_dimension_2d,
            "texture exceeds Deno device limits",
        )?;
        let native = {
            // SAFETY: the HAL guard prevents destruction while we inspect and
            // retain the object. Drop it before touching another core registry.
            let hal = unsafe { texture.as_hal::<wgpu_hal::api::Metal>() }
                .ok_or("source texture is destroyed or is not Metal")?;
            let native = hal.raw_handle();
            ensure(
                same_device(&native.device(), &self.native_device),
                "source texture belongs to a different MTLDevice",
            )?;
            ensure(
                native.textureType() == MTLTextureType::Type2D
                    && native.pixelFormat() == MTLPixelFormat::RGBA8Unorm
                    && native.width() == descriptor.size.width as usize
                    && native.height() == descriptor.size.height as usize
                    && native.depth() == 1
                    && native.arrayLength() == 1
                    && native.mipmapLevelCount() == 1
                    && native.sampleCount() == 1,
                "native Metal texture does not match import descriptor",
            )?;
            ensure(
                native.hazardTrackingMode() == MTLHazardTrackingMode::Tracked,
                "interop requires tracked Metal texture hazards",
            )?;
            let mut required = MTLTextureUsage::empty();
            if descriptor
                .usage
                .contains(wgpu::TextureUsages::TEXTURE_BINDING)
            {
                required |= MTLTextureUsage::ShaderRead;
            }
            if descriptor
                .usage
                .contains(wgpu::TextureUsages::STORAGE_BINDING)
            {
                required |= MTLTextureUsage::ShaderRead | MTLTextureUsage::ShaderWrite;
            }
            if descriptor
                .usage
                .contains(wgpu::TextureUsages::RENDER_ATTACHMENT)
            {
                required |= MTLTextureUsage::RenderTarget;
            }
            ensure(
                native.usage().contains(required),
                "native Metal texture lacks requested shader/render usage",
            )?;
            // SAFETY: the borrowed native object is protected by the HAL guard.
            unsafe { Retained::retain(std::ptr::from_ref(native).cast_mut()) }
                .ok_or("could not retain shared Metal texture")?
        };
        let core_descriptor = deno_webgpu::wgpu_core::resource::TextureDescriptor {
            label: descriptor.label.map(Cow::Borrowed),
            size: descriptor.size,
            mip_level_count: descriptor.mip_level_count,
            sample_count: descriptor.sample_count,
            dimension: descriptor.dimension,
            format: descriptor.format,
            usage: descriptor.usage,
            view_formats: vec![],
        };
        // SAFETY: native identity, dimensions, format, and usages were checked.
        // The caller supplies initialization and serialized access. The imported
        // HAL texture owns an independent Objective-C retain, not a borrowed ID.
        let (id, error) = unsafe {
            let hal = wgpu_hal::metal::Device::texture_from_raw(
                native,
                descriptor.format,
                MTLTextureType::Type2D,
                1,
                1,
                wgpu_hal::CopyExtent {
                    width: descriptor.size.width,
                    height: descriptor.size.height,
                    depth: 1,
                },
            );
            self.deno.create_texture_from_hal(
                Box::new(hal),
                self.deno_device,
                &core_descriptor,
                None,
            )
        };
        if let Some(error) = error {
            self.deno.texture_drop(id);
            return Err(error.into());
        }
        Ok(id)
    }
}

fn ensure(condition: bool, message: &'static str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}

fn same_device(
    a: &Retained<ProtocolObject<dyn MTLDevice>>,
    b: &Retained<ProtocolObject<dyn MTLDevice>>,
) -> bool {
    Retained::as_ptr(a) == Retained::as_ptr(b)
}
