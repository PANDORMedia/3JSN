use deno_core::{JsRuntime, cppgc, v8};
use deno_webgpu::{canvas::GPUCanvasAlphaMode, texture::GPUTexture};
use vello::peniko::ImageData;

use crate::{
    Result, canvas_texture::CanvasImage, dom_bridge, metal::MetalBridge, painter::Painter,
};

/// One DOM canvas is the declared boundary of this presentation experiment.
/// All texture transport stays on the bridge's checked native Metal queue.
pub struct WindowScene {
    pub painter: Painter,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    output: wgpu::Texture,
    blitter: wgpu::util::TextureBlitter,
    image: Option<CanvasImage>,
    registration: Option<ImageData>,
    source: Option<(wgpu::Extent3d, wgpu::TextureFormat)>,
    pub snapshots: u64,
}

impl WindowScene {
    pub fn new(
        runtime: &mut JsRuntime,
        instance: &wgpu::Instance,
        surface: wgpu::Surface<'static>,
        width: u32,
        height: u32,
    ) -> Result<Self> {
        let bridge = dom_bridge::with_canvas(runtime, "scene", |context, _| {
            let config = context.configuration.borrow();
            let device = &config.as_ref().ok_or("canvas is not configured")?.device;
            MetalBridge::with_instance(device.instance.clone(), device.id, device.queue, instance)
        })?;
        if !bridge.adapter.is_surface_supported(&surface) {
            return Err("canvas device cannot present to this surface".into());
        }
        let capabilities = surface.get_capabilities(&bridge.adapter);
        let format = [
            wgpu::TextureFormat::Bgra8Unorm,
            wgpu::TextureFormat::Rgba8Unorm,
        ]
        .into_iter()
        .find(|f| capabilities.formats.contains(f))
        .ok_or("surface lacks a supported linear UNORM presentation format")?;
        if !capabilities
            .alpha_modes
            .contains(&wgpu::CompositeAlphaMode::Opaque)
        {
            return Err("surface lacks opaque composition".into());
        }
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: wgpu::CompositeAlphaMode::Opaque,
            view_formats: vec![],
        };
        surface.configure(&bridge.device, &config);
        let blitter = wgpu::util::TextureBlitter::new(&bridge.device, format);
        let output = output(&bridge.device, width, height);
        Ok(Self {
            painter: Painter::new(bridge)?,
            surface,
            config,
            output,
            blitter,
            image: None,
            registration: None,
            source: None,
            snapshots: 0,
        })
    }

    pub fn resize(&mut self, width: u32, height: u32) -> Result<()> {
        if width == self.config.width && height == self.config.height {
            return Ok(());
        }
        self.painter.drain()?;
        self.config.width = width;
        self.config.height = height;
        self.surface
            .configure(&self.painter.bridge.device, &self.config);
        self.output = output(&self.painter.bridge.device, width, height);
        Ok(())
    }

    pub fn compose(&mut self, runtime: &mut JsRuntime) -> Result<()> {
        let changed = dom_bridge::with_canvas(runtime, "scene", |context, scope| {
            let configuration = context.configuration.borrow();
            let configuration = configuration.as_ref().ok_or("canvas was unconfigured")?;
            let premultiplied =
                matches!(configuration.alpha_mode, GPUCanvasAlphaMode::Premultiplied);
            let current = context.current_texture.borrow();
            let Some(texture) = current.as_ref() else {
                return Ok(false);
            };
            let texture = v8::Local::new(scope, texture);
            let texture = cppgc::try_unwrap_cppgc_object::<GPUTexture>(scope, texture.into())
                .ok_or("current canvas texture brand changed")?;
            let descriptor = (
                texture.size,
                wgpu::TextureFormat::from(texture.format.clone()),
            );
            if self.source != Some(descriptor) {
                self.painter.drain()?;
                if let Some(registration) = self.registration.take() {
                    self.painter.unregister_canvas(registration)?;
                }
                self.image = Some(CanvasImage::new(&self.painter.bridge, &texture)?);
                self.source = Some(descriptor);
            }
            // SAFETY: the context roots this Deno-created texture; one worker
            // serializes producer, initialization and snapshot on the same queue.
            unsafe {
                self.image.as_mut().unwrap().update(
                    &self.painter.bridge,
                    &texture,
                    premultiplied,
                )?;
            }
            Ok(true)
        })?;
        if changed {
            self.snapshots += 1;
            if self.registration.is_none() {
                self.registration = Some(dom_bridge::with_document(runtime, |doc| {
                    let node = doc.get_element_by_id("scene").ok_or("canvas disappeared")?;
                    self.painter.register_canvas(
                        doc,
                        node,
                        self.image.as_ref().unwrap().texture.clone(),
                    )
                })?);
            }
            self.painter
                .mark_canvas_dirty(self.registration.as_ref().unwrap())?;
        }
        dom_bridge::expire(runtime);
        dom_bridge::with_document(runtime, |doc| self.painter.paint(doc, &self.output))?;
        Ok(())
    }

    pub fn acquire(&mut self) -> Result<Option<wgpu::SurfaceTexture>> {
        let texture = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture)
            | wgpu::CurrentSurfaceTexture::Suboptimal(texture) => texture,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                return Ok(None);
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface
                    .configure(&self.painter.bridge.device, &self.config);
                return Ok(None);
            }
            wgpu::CurrentSurfaceTexture::Lost => {
                return Err("native presentation surface was lost; recreation is not implemented by this probe".into());
            }
            wgpu::CurrentSurfaceTexture::Validation => {
                return Err("surface acquisition validation failure".into());
            }
        };
        let mut encoder = self
            .painter
            .bridge
            .device
            .create_command_encoder(&Default::default());
        self.blitter.copy(
            &self.painter.bridge.device,
            &mut encoder,
            &self.output.create_view(&Default::default()),
            &texture.texture.create_view(&Default::default()),
        );
        self.painter.bridge.queue.submit([encoder.finish()]);
        self.painter.check_errors()?;
        Ok(Some(texture))
    }

    pub fn release(&mut self) -> Result<()> {
        self.painter.drain()?;
        if let Some(registration) = self.registration.take() {
            self.painter.unregister_canvas(registration)?;
        }
        self.image = None;
        self.painter.check_errors()
    }
}

fn output(device: &wgpu::Device, width: u32, height: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("DOM scene for native presentation"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}
