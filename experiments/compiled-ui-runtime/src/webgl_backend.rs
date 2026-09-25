//! Native DOM identity and GPU lease ownership for the optional ANGLE canvas backend.

use deno_core::{JsRuntime, OpState, op2};
use deno_error::JsErrorBox;
use std::{cell::RefCell, collections::HashMap, rc::Rc};
use threejs_native_webgl_runtime::snapshot_consumer::{AlphaConversion, GpuSnapshot};

struct Generation {
    context_id: u32,
    alpha_conversion: AlphaConversion,
    preserve_drawing_buffer: bool,
    consumer: Option<GpuSnapshot>,
    revision: u64,
    released: bool,
}

#[derive(Default)]
struct Registry(HashMap<String, Rc<RefCell<Generation>>>);

#[derive(Clone)]
pub struct Canvas {
    node_key: String,
    context_id: u32,
    generation: Rc<RefCell<Generation>>,
}

impl Canvas {
    pub fn context_id(&self) -> u32 {
        self.context_id
    }

    pub fn node_key(&self) -> &str {
        &self.node_key
    }

    /// Apply WebGL's post-composite drawing-buffer discard when preservation is disabled.
    pub fn discard_after_composite(&self, runtime: &mut JsRuntime) -> crate::Result<()> {
        let should_discard = {
            let mut generation = self.generation.try_borrow_mut()?;
            if generation.preserve_drawing_buffer {
                false
            } else {
                if let Some(consumer) = generation.consumer.as_mut() {
                    consumer.order_source_write_after_consumer()?;
                }
                true
            }
        };
        if should_discard {
            threejs_native_webgl_runtime::discard_drawing_buffer(runtime, self.context_id)?;
        }
        Ok(())
    }

    /// Convert the latest ANGLE frame into a top-left, straight-alpha GPU texture.
    ///
    /// # Safety
    /// The device/queue pair must match, and host submissions must be serialized
    /// with this operation, including submissions reading previously returned textures.
    pub unsafe fn update(
        &self,
        runtime: &mut JsRuntime,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
    ) -> crate::Result<(wgpu::Texture, u64)> {
        let mut generation = self.generation.try_borrow_mut()?;
        if generation.released {
            return Err("WebGL canvas registry has been released".into());
        }
        if generation.consumer.is_none() {
            let snapshot = threejs_native_webgl_runtime::snapshot(runtime, self.context_id)?;
            let alpha_conversion = generation.alpha_conversion;
            generation.consumer =
                Some(GpuSnapshot::new(snapshot, device, queue, alpha_conversion)?);
        }
        let consumer = generation
            .consumer
            .as_mut()
            .ok_or("WebGL snapshot missing")?;
        // SAFETY: caller supplies the shared-device and serialized-queue contract.
        unsafe { consumer.update()? };
        Ok((consumer.texture()?.clone(), generation.revision))
    }

    /// Drain the old lease before changing the surface. A failed close retains it.
    pub fn retire(&self) -> crate::Result<()> {
        let mut generation = self.generation.try_borrow_mut()?;
        let next = generation
            .revision
            .checked_add(1)
            .ok_or("WebGL generation exhausted")?;
        if let Some(consumer) = generation.consumer.as_mut() {
            consumer.close()?;
        }
        generation.consumer = None;
        generation.revision = next;
        Ok(())
    }
}

fn registered(state: &OpState, node_key: &str) -> Option<Canvas> {
    let generation = state.try_borrow::<Registry>()?.0.get(node_key)?.clone();
    let context_id = generation.borrow().context_id;
    Some(Canvas {
        node_key: node_key.to_owned(),
        context_id,
        generation,
    })
}

#[op2(fast)]
fn op_webgl_canvas_register(
    state: &mut OpState,
    #[string] node_key: String,
    context_id: u32,
    premultiplied_alpha: bool,
    preserve_drawing_buffer: bool,
) -> Result<(), JsErrorBox> {
    // Both identities come from private JS brands, never application properties.
    if node_key.parse::<u64>().is_err() {
        return Err(JsErrorBox::type_error("Invalid native canvas identity"));
    }
    let registry = &mut state.borrow_mut::<Registry>().0;
    if registry.contains_key(&node_key)
        || registry
            .values()
            .any(|generation| generation.borrow().context_id == context_id)
    {
        return Err(JsErrorBox::type_error("WebGL canvas is already registered"));
    }
    registry.insert(
        node_key,
        Rc::new(RefCell::new(Generation {
            context_id,
            alpha_conversion: if premultiplied_alpha {
                AlphaConversion::Unpremultiply
            } else {
                AlphaConversion::Preserve
            },
            preserve_drawing_buffer,
            consumer: None,
            revision: 0,
            released: false,
        })),
    );
    Ok(())
}

#[op2(fast)]
fn op_webgl_canvas_retire(
    state: &mut OpState,
    #[string] node_key: String,
) -> Result<(), JsErrorBox> {
    let canvas = registered(state, &node_key)
        .ok_or_else(|| JsErrorBox::type_error("WebGL canvas registration missing"))?;
    canvas
        .retire()
        .map_err(|error| JsErrorBox::generic(error.to_string()))
}

/// Resolve the document's actual ID index rather than any application-facing property.
pub fn find(runtime: &mut JsRuntime, element_id: &str) -> crate::Result<Option<Canvas>> {
    if !runtime.op_state().borrow().has::<Registry>() {
        return Ok(None);
    }
    let node_key = crate::dom_bridge::with_document(runtime, |document| {
        let id = document.get_element_by_id(element_id)?;
        let element = document.get_node(id)?.element_data()?;
        (element.name.local.as_ref() == "canvas").then(|| id.as_u64().to_string())
    });
    let Some(node_key) = node_key else {
        return Ok(None);
    };
    let state = runtime.op_state();
    let state = state.borrow();
    Ok(registered(&state, &node_key))
}

/// Close every GPU lease before the host disposes its ANGLE contexts.
pub fn release_all(runtime: &mut JsRuntime) -> crate::Result<()> {
    let canvases = {
        let state = runtime.op_state();
        let state = state.borrow();
        state
            .borrow::<Registry>()
            .0
            .keys()
            .filter_map(|key| registered(&state, key))
            .collect::<Vec<_>>()
    };
    for canvas in canvases {
        canvas.retire()?;
        canvas.generation.borrow_mut().released = true;
    }
    // Keep registrations so a retained host handle cannot revive a released lease.
    Ok(())
}

deno_core::extension!(
    webgl_dom_backend,
    deps = [dom_canvas, angle_probe],
    ops = [op_webgl_canvas_register, op_webgl_canvas_retire],
    state = |state| state.put(Registry::default()),
);

pub fn extension() -> deno_core::Extension {
    let mut extension = webgl_dom_backend::init();
    extension.esm_files = vec![deno_core::ExtensionFileSource::new(
        "ext:webgl_dom_backend/webgl-canvas.js",
        deno_core::ascii_str_include!("webgl-canvas.js"),
    )]
    .into();
    extension.esm_entry_point = Some("ext:webgl_dom_backend/webgl-canvas.js");
    extension
}
