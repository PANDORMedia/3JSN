use std::{
    cell::Cell,
    collections::BTreeMap,
    error::Error,
    num::NonZeroUsize,
    rc::Rc,
    sync::{Arc, Mutex},
};

use anyrender::{PaintScene, RenderContext, Scene};
use anyrender_vello::VelloScenePainter;
use blitz_dom::{BaseDocument, NodeId, Widget, node::ComputedStyles};
use serde_json::{Value, json};
use vello::peniko::{ImageBrush, ImageData, kurbo::Affine};

use crate::metal::MetalBridge;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

struct CanvasImage {
    handle: ImageData,
    active: Cell<bool>,
}

struct CanvasView {
    image: Rc<CanvasImage>,
    content_size: Rc<Cell<(f64, f64)>>,
}

impl Widget for CanvasView {
    fn paint(
        &mut self,
        _context: &mut dyn RenderContext,
        _styles: &ComputedStyles,
        _width: u32,
        _height: u32,
        _scale: f64,
    ) -> Scene {
        let mut scene = Scene::new();
        let (width, height) = self.content_size.get();
        if self.image.active.get() && width > 0.0 && height > 0.0 {
            let image = &self.image.handle;
            let transform = Affine::scale_non_uniform(
                width / f64::from(image.width),
                height / f64::from(image.height),
            );
            scene.draw_image(ImageBrush::new(image.clone()).as_ref(), transform);
        }
        scene
    }
}

/// Registrations retain GPU textures independently of DOM attachment. The host
/// supplies initialized straight-alpha RGBA textures from this bridge's device,
/// orders both registries' submissions, and drains before retiring registrations
/// or destroying their shared aliases. A moved canvas must be attached again.
pub struct Painter {
    renderer: vello::Renderer,
    pub bridge: MetalBridge,
    images: BTreeMap<u64, Rc<CanvasImage>>,
    views: BTreeMap<(usize, NodeId), CanvasView>,
    errors: Arc<Mutex<Vec<String>>>,
}

impl Drop for Painter {
    fn drop(&mut self) {
        // DOM views may outlive this renderer, whose image handles are private
        // to its atlas and cannot be reused by a replacement renderer.
        for image in self.images.values() {
            image.active.set(false);
        }
    }
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
            images: BTreeMap::new(),
            views: BTreeMap::new(),
            errors,
        })
    }

    pub fn register_canvas(
        &mut self,
        doc: &mut BaseDocument,
        node: NodeId,
        texture: wgpu::Texture,
    ) -> Result<ImageData> {
        check_canvas(doc, node)?;
        check_texture(&texture, wgpu::TextureUsages::COPY_SRC)?;
        let image = self.renderer.register_texture(texture);
        self.images.insert(
            image.data.id(),
            Rc::new(CanvasImage {
                handle: image.clone(),
                active: Cell::new(true),
            }),
        );
        if let Err(error) = self.attach_canvas(doc, node, &image) {
            self.images.remove(&image.data.id());
            self.renderer.unregister_texture(image);
            return Err(error);
        }
        Ok(image)
    }

    /// Reattach the paint view after Blitz unloads a Widget during DOM removal.
    /// This preserves the canvas registration and does not allocate a texture.
    pub fn attach_canvas(
        &mut self,
        doc: &mut BaseDocument,
        node: NodeId,
        image: &ImageData,
    ) -> Result<()> {
        check_canvas(doc, node)?;
        let image = self
            .images
            .get(&image.data.id())
            .ok_or("canvas image is not registered with this painter")?
            .clone();
        let content_size = Rc::new(Cell::new((0.0, 0.0)));
        doc.mutate().set_custom_widget(
            node,
            Box::new(CanvasView {
                image: image.clone(),
                content_size: content_size.clone(),
            }),
        );
        self.views.insert(
            (doc.id(), node),
            CanvasView {
                image,
                content_size,
            },
        );
        Ok(())
    }

    /// Mark after producer writes and before painting; Vello otherwise reuses
    /// the prior atlas pixels even though the registered texture has changed.
    pub fn mark_canvas_dirty(&mut self, image: &ImageData) -> Result<()> {
        let image = self
            .images
            .get(&image.data.id())
            .ok_or("cannot dirty an unregistered canvas image")?;
        self.renderer.mark_override_image_dirty(&image.handle);
        Ok(())
    }

    /// Call after drain. Invalidating all views prevents a retained DOM Widget
    /// from drawing Vello's empty image placeholder after its texture is removed.
    pub fn unregister_canvas(&mut self, image: ImageData) -> Result<()> {
        let id = image.data.id();
        let image = self
            .images
            .remove(&id)
            .ok_or("cannot unregister an unknown canvas image")?;
        image.active.set(false);
        self.views
            .retain(|_, view| view.image.handle.data.id() != id);
        self.renderer.unregister_texture(image.handle.clone());
        Ok(())
    }

    pub fn paint(&mut self, doc: &mut BaseDocument, output: &wgpu::Texture) -> Result<Value> {
        check_texture(output, wgpu::TextureUsages::STORAGE_BINDING)?;
        let (width, height) = (output.width(), output.height());
        let mut viewport = doc.viewport().clone();
        viewport.window_size = (width, height);
        let scale = viewport.scale_f64();
        ensure(scale.is_finite() && scale > 0.0, "invalid document scale")?;
        doc.set_viewport(viewport);
        doc.resolve(0.0);

        let mut canvases = Vec::new();
        for (&(document_id, node_id), view) in &self.views {
            if document_id != doc.id() || !is_connected(doc, node_id) {
                continue;
            }
            let node = doc.get_node(node_id).ok_or("canvas node disappeared")?;
            ensure(
                node.element_data()
                    .and_then(|element| element.custom_widget_data())
                    .is_some(),
                "canvas widget was detached; attach_canvas is required after moving it",
            )?;
            let layout = node.final_layout();
            ensure(
                [
                    layout.border.left,
                    layout.border.right,
                    layout.border.top,
                    layout.border.bottom,
                    layout.padding.left,
                    layout.padding.right,
                    layout.padding.top,
                    layout.padding.bottom,
                ]
                .iter()
                .all(|value| *value == 0.0),
                "canvas border/padding is outside this probe's paint contract",
            )?;
            let content_width = f64::from(layout.content_box_width()) * scale;
            let content_height = f64::from(layout.content_box_height()) * scale;
            ensure(
                content_width.is_finite()
                    && content_height.is_finite()
                    && content_width >= 0.0
                    && content_height >= 0.0,
                "invalid canvas content size",
            )?;
            view.content_size.set((content_width, content_height));
            let rect = doc
                .get_client_bounding_rect(node_id)
                .ok_or("canvas has no layout rectangle")?;
            canvases.push(json!({
                "node":node_id.to_string(),
                "rect":{"x":rect.x,"y":rect.y,"width":rect.width,"height":rect.height},
                "contentSize":{"width":content_width,"height":content_height},
                "imageSize":{"width":view.image.handle.width,"height":view.image.handle.height},
            }));
        }

        let mut scene = vello::Scene::new();
        blitz_paint::paint_scene(
            &mut VelloScenePainter::new(&mut scene),
            doc,
            scale,
            width,
            height,
            0,
            0,
        );
        let glyphs = scene.encoding().resources.glyphs.len();
        self.renderer.render_to_texture(
            &self.bridge.device,
            &self.bridge.queue,
            &scene,
            &output.create_view(&Default::default()),
            &vello::RenderParams {
                base_color: vello::peniko::Color::TRANSPARENT,
                width,
                height,
                antialiasing_method: vello::AaConfig::Area,
            },
        )?;
        self.check_errors()?;
        Ok(json!({"canvases":canvases,"glyphs":glyphs,"scale":scale}))
    }

    pub fn drain(&self) -> Result<()> {
        let mut errors = Vec::new();
        if let Err(error) = self.bridge.drain() {
            errors.push(error.to_string());
        }
        if let Err(error) = self.check_errors() {
            errors.push(error.to_string());
        }
        ensure(errors.is_empty(), &errors.join("; "))
    }

    pub fn check_errors(&self) -> Result<()> {
        let errors = self.errors.lock().unwrap();
        ensure(errors.is_empty(), &format!("Vello GPU errors: {errors:?}"))
    }
}

fn check_canvas(doc: &BaseDocument, node: NodeId) -> Result<()> {
    ensure(
        doc.get_node(node)
            .and_then(|node| node.element_data())
            .is_some_and(|element| element.name.local == blitz_dom::local_name!("canvas")),
        "expected a canvas element in this document",
    )
}

fn check_texture(texture: &wgpu::Texture, usage: wgpu::TextureUsages) -> Result<()> {
    ensure(
        texture.format() == wgpu::TextureFormat::Rgba8Unorm
            && texture.dimension() == wgpu::TextureDimension::D2
            && texture.width() > 0
            && texture.height() > 0
            && texture.depth_or_array_layers() == 1
            && texture.mip_level_count() == 1
            && texture.sample_count() == 1
            && texture.usage().contains(usage),
        "canvas paint requires a nonempty single-layer/mip/sample RGBA8 texture with the requested usage",
    )
}

fn is_connected(doc: &BaseDocument, node: NodeId) -> bool {
    let mut current = Some(node);
    while let Some(id) = current {
        if id == doc.root_node().id {
            return true;
        }
        current = doc.get_node(id).and_then(|node| node.parent);
    }
    false
}

fn ensure(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}
