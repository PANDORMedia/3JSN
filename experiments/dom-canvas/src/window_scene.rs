use deno_core::{JsRuntime, cppgc, v8};
use deno_webgpu::{canvas::GPUCanvasAlphaMode, texture::GPUTexture};
use vello::peniko::ImageData;

use crate::{
    Result, canvas_texture::CanvasImage, dom_bridge, metal::MetalBridge, painter::Painter,
};

/// One DOM canvas is the declared boundary of this presentation experiment.
/// WebGPU shares its native queue; WebGL uses checked device identity and events.
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
    registered_node: Option<u64>,
    #[cfg(feature = "native-webgl")]
    webgl: Option<crate::webgl_backend::Canvas>,
    #[cfg(feature = "native-webgl")]
    webgl_generation: Option<(String, u64)>,
}

impl WindowScene {
    pub fn new(
        runtime: &mut JsRuntime,
        instance: &wgpu::Instance,
        surface: wgpu::Surface<'static>,
        width: u32,
        height: u32,
    ) -> Result<Self> {
        #[cfg(feature = "native-webgl")]
        let webgl = crate::webgl_backend::find(runtime, "scene")?;
        #[cfg(feature = "native-webgl")]
        let independent = if let Some(canvas) = &webgl {
            let mut lease = threejs_native_webgl_runtime::snapshot(runtime, canvas.context_id())?;
            let bridge = MetalBridge::with_native_device(instance, &surface, lease.device_raw())?;
            lease.close()?;
            Some(bridge)
        } else {
            None
        };
        #[cfg(not(feature = "native-webgl"))]
        let independent: Option<MetalBridge> = None;
        let bridge = if let Some(bridge) = independent {
            bridge
        } else {
            dom_bridge::with_canvas(runtime, "scene", |context, _| {
                let config = context.configuration.borrow();
                let device = &config.as_ref().ok_or("canvas is not configured")?.device;
                MetalBridge::with_instance(
                    device.instance.clone(),
                    device.id,
                    device.queue,
                    instance,
                )
            })?
        };
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
            registered_node: None,
            #[cfg(feature = "native-webgl")]
            webgl,
            #[cfg(feature = "native-webgl")]
            webgl_generation: None,
        })
    }

    pub fn canvas_api(&self) -> &'static str {
        #[cfg(feature = "native-webgl")]
        if self.webgl.is_some() {
            return "webgl2";
        }
        "webgpu"
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
        let node = dom_bridge::with_document(runtime, |doc| {
            doc.get_element_by_id("scene").map(|node| node.as_u64())
        })
        .ok_or("canvas disappeared")?;
        #[cfg(feature = "native-webgl")]
        if self.webgl.is_some() {
            return self.compose_webgl(runtime, node);
        }
        if self
            .registered_node
            .is_some_and(|registered| registered != node)
        {
            self.painter.drain()?;
            if let Some(registration) = self.registration.take() {
                self.painter.unregister_canvas(registration)?;
            }
            self.image = None;
            self.source = None;
            self.registered_node = None;
        }
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
            self.registered_node = Some(node);
            self.painter
                .mark_canvas_dirty(self.registration.as_ref().unwrap())?;
        }
        dom_bridge::expire(runtime);
        dom_bridge::with_document(runtime, |doc| self.painter.paint(doc, &self.output))?;
        Ok(())
    }

    #[cfg(feature = "native-webgl")]
    fn compose_webgl(&mut self, runtime: &mut JsRuntime, node: u64) -> Result<()> {
        let canvas = crate::webgl_backend::find(runtime, "scene")?
            .ok_or("scene canvas changed away from its WebGL backend")?;
        if self
            .webgl
            .as_ref()
            .is_some_and(|old| old.node_key() != canvas.node_key())
        {
            self.webgl.as_ref().unwrap().retire()?;
        }
        self.webgl = Some(canvas.clone());
        // SAFETY: this worker owns and serializes all compositor queue use. No
        // unsubmitted encoder survives a frame, and output reads use this queue.
        let (texture, revision) = unsafe {
            canvas.update(
                runtime,
                &self.painter.bridge.device,
                &self.painter.bridge.queue,
            )?
        };
        let generation = (canvas.node_key().to_string(), revision);
        if self.webgl_generation.as_ref() != Some(&generation) {
            self.painter.drain()?;
            if let Some(registration) = self.registration.take() {
                self.painter.unregister_canvas(registration)?;
            }
            self.registration = Some(dom_bridge::with_document(runtime, |doc| {
                let node = doc.get_element_by_id("scene").ok_or("canvas disappeared")?;
                self.painter.register_canvas(doc, node, texture)
            })?);
            self.webgl_generation = Some(generation);
            self.registered_node = Some(node);
        }
        self.snapshots += 1;
        self.painter
            .mark_canvas_dirty(self.registration.as_ref().unwrap())?;
        dom_bridge::expire(runtime);
        dom_bridge::with_document(runtime, |doc| self.painter.paint(doc, &self.output))?;
        Ok(())
    }

    pub fn capture(&self, path: &std::path::Path) -> Result<()> {
        crate::window_capture::save(&self.painter.bridge, &self.output, path)
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
        #[cfg(feature = "native-webgl")]
        if let Some(canvas) = &self.webgl {
            canvas.retire()?;
        }
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
        usage: wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}
