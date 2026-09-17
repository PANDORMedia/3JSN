use std::{
    num::NonZeroUsize,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyrender_vello::VelloScenePainter;
use blitz_traits::shell::{ColorScheme, Viewport};
use deno_core::JsRuntime;
use serde_json::{Value, json};

use crate::{Result, check, dom_bridge, metal::MetalBridge};

pub struct Painter {
    renderer: vello::Renderer,
    pub bridge: MetalBridge,
    errors: Arc<Mutex<Vec<String>>>,
}

impl Painter {
    pub fn new(bridge: MetalBridge) -> Result<Self> {
        let errors = Arc::new(Mutex::new(Vec::new()));
        let captured = errors.clone();
        bridge
            .device
            .on_uncaptured_error(Arc::new(move |error: wgpu::Error| {
                captured.lock().unwrap().push(error.to_string());
            }));
        let renderer = vello::Renderer::new(
            &bridge.device,
            vello::RendererOptions {
                use_cpu: false,
                antialiasing_support: vello::AaSupport::area_only(),
                num_init_threads: NonZeroUsize::new(1),
                pipeline_cache: None,
            },
        )?;
        Ok(Self {
            renderer,
            bridge,
            errors,
        })
    }

    pub fn render(&mut self, scene: &vello::Scene, texture: &wgpu::Texture) -> Result<()> {
        self.renderer.render_to_texture(
            &self.bridge.device,
            &self.bridge.queue,
            scene,
            &texture.create_view(&Default::default()),
            &vello::RenderParams {
                base_color: vello::peniko::Color::TRANSPARENT,
                width: texture.width(),
                height: texture.height(),
                antialiasing_method: vello::AaConfig::Area,
            },
        )?;
        self.check_errors()
    }

    pub fn drain(&self) -> Result<()> {
        self.bridge.device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(15)),
        })?;
        self.check_errors()
    }

    pub fn check_errors(&self) -> Result<()> {
        let errors = self.errors.lock().unwrap();
        check(errors.is_empty(), &format!("Vello GPU errors: {errors:?}"))
    }

    pub fn paint(&mut self, runtime: &mut JsRuntime, texture: &wgpu::Texture) -> Result<Value> {
        let mut scene = vello::Scene::new();
        let width = texture.width();
        let height = texture.height();
        let geometry = dom_bridge::with_document(runtime, |doc| -> Result<Value> {
            doc.set_viewport(Viewport::new(width, height, 1.0, ColorScheme::Light));
            doc.resolve(0.0);
            let root = doc
                .get_element_by_id("root")
                .ok_or("missing root element")?;
            let rect = doc
                .get_client_bounding_rect(root)
                .ok_or("missing root geometry")?;
            let geometry = json!({"x":rect.x,"y":rect.y,"width":rect.width,"height":rect.height});
            blitz_paint::paint_scene(
                &mut VelloScenePainter::new(&mut scene),
                doc,
                1.0,
                width,
                height,
                0,
                0,
            );
            Ok(geometry)
        })?;
        let glyphs = scene.encoding().resources.glyphs.len();
        self.render(&scene, texture)?;
        Ok(json!({"root":geometry,"glyphs":glyphs}))
    }
}
