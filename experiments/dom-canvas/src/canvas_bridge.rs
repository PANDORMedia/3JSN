include!("../../html-v8/src/dom_ops.rs");

use deno_core::{JsRuntime, cppgc, v8};
use deno_webgpu::{
    canvas::{ContextData, GPUCanvasContext},
    texture::GPUTexture,
};
use std::{cell::Cell, collections::HashMap, rc::Rc};

struct Canvas {
    dimensions: Rc<Cell<(u32, u32)>>,
    context: v8::Global<v8::Value>,
}
#[derive(Default)]
struct Canvases(HashMap<String, Canvas>);

#[op2]
fn op_canvas_context<'s>(
    state: &mut OpState,
    scope: &mut v8::PinScope<'s, '_>,
    #[string] id: String,
    #[scoped] canvas: v8::Global<v8::Object>,
    width: u32,
    height: u32,
) -> Result<v8::Global<v8::Value>, JsErrorBox> {
    let node = node_id(&state.borrow::<DomState>().document, &id)?;
    if state
        .borrow::<DomState>()
        .document
        .get_node(node)
        .unwrap()
        .element_data()
        .is_none_or(|element| element.name.local.as_ref() != "canvas")
    {
        return Err(JsErrorBox::type_error("Expected a canvas node"));
    }
    let canvases = &mut state.borrow_mut::<Canvases>().0;
    if let Some(canvas) = canvases.get(&id) {
        return Ok(canvas.context.clone());
    }
    let dimensions = Rc::new(Cell::new((width, height)));
    let options = v8::undefined(scope).into();
    let context = deno_webgpu::canvas::create(
        None,
        canvas,
        ContextData::Texture(dimensions.clone()),
        scope,
        options,
        "HTMLCanvasElement",
        "getContext",
    )?;
    canvases.insert(
        id,
        Canvas {
            dimensions,
            context: context.clone(),
        },
    );
    Ok(context)
}

#[op2(fast)]
fn op_canvas_resize(
    state: &mut OpState,
    scope: &mut v8::PinScope<'_, '_>,
    #[string] id: String,
    width: u32,
    height: u32,
) -> Result<(), JsErrorBox> {
    let canvas = state
        .borrow_mut::<Canvases>()
        .0
        .get_mut(&id)
        .ok_or_else(|| JsErrorBox::type_error("Canvas context missing"))?;
    canvas.dimensions.set((width, height));
    let local = v8::Local::new(scope, &canvas.context);
    let context = cppgc::try_unwrap_cppgc_object::<GPUCanvasContext>(scope, local)
        .expect("registered canvas context");
    context.resize(scope);
    Ok(())
}

deno_core::extension!(
    dom_canvas,
    ops = [op_dom_read, op_dom_mutate, op_observe, op_canvas_context, op_canvas_resize],
    options = { dom: DomState },
    state = |state, options| { state.put(options.dom); state.put(Canvases::default()); },
);

pub fn extension_with_document_and_parser(
    document: BaseDocument,
    html_fragment_parser: Option<HtmlFragmentParser>,
) -> deno_core::Extension {
    let mut extension = dom_canvas::init(DomState {
        document,
        started: Instant::now(),
        messages: vec![],
        html_fragment_parser,
    });
    extension.esm_files = vec![
        deno_core::ExtensionFileSource::new(
            "ext:html_v8_probe/bindings.js",
            deno_core::ascii_str_include!("../../native-html-interop/src/bindings.js"),
        ),
        deno_core::ExtensionFileSource::new(
            "ext:html_v8_probe/focus.js",
            deno_core::ascii_str_include!("../../native-html-interop/src/focus.js"),
        ),
        deno_core::ExtensionFileSource::new(
            "ext:dom_canvas/canvas.js",
            deno_core::ascii_str_include!("canvas.js"),
        ),
    ]
    .into();
    extension.esm_entry_point = Some("ext:dom_canvas/canvas.js");
    extension
}

pub fn with_document<T>(runtime: &mut JsRuntime, apply: impl FnOnce(&mut BaseDocument) -> T) -> T {
    let state = runtime.op_state();
    let mut state = state.borrow_mut();
    apply(&mut state.borrow_mut::<DomState>().document)
}

pub fn with_texture<T>(
    runtime: &mut JsRuntime,
    element_id: &str,
    apply: impl FnOnce(&GPUTexture) -> crate::Result<T>,
) -> crate::Result<T> {
    let context = {
        let state = runtime.op_state();
        let state = state.borrow();
        let id = state
            .borrow::<DomState>()
            .document
            .get_element_by_id(element_id)
            .ok_or("canvas element missing")?;
        state
            .borrow::<Canvases>()
            .0
            .get(&id.as_u64().to_string())
            .ok_or("canvas has no context")?
            .context
            .clone()
    };
    deno_core::scope!(scope, runtime);
    let context = v8::Local::new(scope, context);
    let context = cppgc::try_unwrap_cppgc_object::<GPUCanvasContext>(scope, context)
        .ok_or("context brand changed")?;
    let texture = context.current_texture.borrow();
    let texture = texture
        .as_ref()
        .ok_or("canvas has not rendered a current texture")?;
    let texture = v8::Local::new(scope, texture);
    let texture = cppgc::try_unwrap_cppgc_object::<GPUTexture>(scope, texture.into())
        .ok_or("texture brand changed")?;
    apply(&texture)
}

/// Inspect a configured DOM canvas without asking application code to expose its
/// GPUDevice. The rooted context owns both configuration and current texture.
pub fn with_canvas<T>(
    runtime: &mut JsRuntime,
    element_id: &str,
    apply: impl FnOnce(&GPUCanvasContext, &mut v8::PinScope<'_, '_>) -> crate::Result<T>,
) -> crate::Result<T> {
    let context = {
        let state = runtime.op_state();
        let state = state.borrow();
        let id = state
            .borrow::<DomState>()
            .document
            .get_element_by_id(element_id)
            .ok_or("canvas element missing")?;
        state
            .borrow::<Canvases>()
            .0
            .get(&id.as_u64().to_string())
            .ok_or("canvas has no context")?
            .context
            .clone()
    };
    deno_core::scope!(scope, runtime);
    let context = v8::Local::new(scope, context);
    let context = cppgc::try_unwrap_cppgc_object::<GPUCanvasContext>(scope, context)
        .ok_or("context brand changed")?;
    apply(&context, scope)
}

pub fn expire(runtime: &mut JsRuntime) {
    let contexts: Vec<_> = runtime
        .op_state()
        .borrow()
        .borrow::<Canvases>()
        .0
        .values()
        .map(|canvas| canvas.context.clone())
        .collect();
    deno_core::scope!(scope, runtime);
    for context in contexts {
        let context = v8::Local::new(scope, context);
        cppgc::try_unwrap_cppgc_object::<GPUCanvasContext>(scope, context)
            .unwrap()
            .expire_drawing_buffer(scope);
    }
}

pub fn release(runtime: &mut JsRuntime) {
    expire(runtime);
    runtime
        .op_state()
        .borrow_mut()
        .borrow_mut::<Canvases>()
        .0
        .clear();
}
