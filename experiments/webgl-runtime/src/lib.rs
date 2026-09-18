use std::{collections::BTreeMap, path::Path, rc::Rc};

use deno_core::{Extension, OpState, op2};
use deno_error::JsErrorBox;
use glow::HasContext;
use serde_json::json;

mod native;
pub mod resources;
mod shaders;
mod webgl_state;
mod webgl_textures;
use shaders::*;
use webgl_state::*;
use webgl_textures::*;

struct State {
    display: Rc<native::Display>,
    contexts: BTreeMap<u32, native::Context>,
    next_id: u32,
    objects: resources::Registry<shaders::Object>,
}

fn failure(message: impl Into<String>) -> JsErrorBox {
    JsErrorBox::generic(message.into())
}

fn current(state: &mut OpState, id: u32) -> Result<&mut native::Context, JsErrorBox> {
    let context = state
        .borrow_mut::<State>()
        .contexts
        .get_mut(&id)
        .ok_or_else(|| JsErrorBox::type_error("Unknown or disposed ANGLE context"))?;
    context.make_current().map_err(failure)?;
    Ok(context)
}

#[op2(fast)]
fn op_angle_create(state: &mut OpState, width: u32, height: u32) -> Result<u32, JsErrorBox> {
    let state = state.borrow_mut::<State>();
    if state.contexts.len() >= 16 {
        return Err(failure("The experimental context limit is 16"));
    }
    let next = state
        .next_id
        .checked_add(1)
        .ok_or_else(|| failure("Context identity exhausted"))?;
    let context = native::Context::new(state.display.clone(), width, height).map_err(failure)?;
    state.next_id = next;
    state.contexts.insert(next, context);
    Ok(next)
}

#[op2]
#[serde]
fn op_angle_info(state: &mut OpState, id: u32) -> Result<serde_json::Value, JsErrorBox> {
    let context = current(state, id)?;
    // All GLES calls occur with this live owner-thread context current.
    unsafe {
        Ok(
            json!({ "renderer": context.gl.get_parameter_string(glow::RENDERER),
            "version": context.gl.get_parameter_string(glow::VERSION),
            "vendor": context.gl.get_parameter_string(glow::VENDOR) }),
        )
    }
}

#[op2(fast)]
fn op_angle_clear(
    state: &mut OpState,
    id: u32,
    red: f32,
    green: f32,
    blue: f32,
    alpha: f32,
) -> Result<(), JsErrorBox> {
    let context = current(state, id)?;
    // Scalar arguments contain no JS/native pointers; ANGLE owns validation and storage.
    unsafe {
        context.gl.clear_color(red, green, blue, alpha);
        context.gl.clear(glow::COLOR_BUFFER_BIT);
    }
    Ok(())
}

#[op2(fast)]
fn op_angle_read_pixel(
    state: &mut OpState,
    id: u32,
    #[buffer] output: &mut [u8],
) -> Result<(), JsErrorBox> {
    if output.len() != 4 {
        return Err(JsErrorBox::type_error(
            "Pixel observation requires exactly four bytes",
        ));
    }
    let context = current(state, id)?;
    // Fixed RGBA8 extent needs four writable bytes. Readback is a probe assertion,
    // never a compositor transport path or a general WebGL readPixels binding.
    unsafe {
        context.gl.read_pixels(
            0,
            0,
            1,
            1,
            glow::RGBA,
            glow::UNSIGNED_BYTE,
            glow::PixelPackData::Slice(Some(output)),
        );
        let error = context.gl.get_error();
        if error != glow::NO_ERROR {
            return Err(failure(format!("ANGLE observation failed: {error:#x}")));
        }
    }
    Ok(())
}

#[op2(fast)]
fn op_angle_resize(
    state: &mut OpState,
    id: u32,
    width: u32,
    height: u32,
) -> Result<(), JsErrorBox> {
    current(state, id)?.resize(width, height).map_err(failure)
}

#[op2(fast)]
fn op_angle_dispose(state: &mut OpState, id: u32) -> Result<(), JsErrorBox> {
    let State {
        contexts, objects, ..
    } = state.borrow_mut::<State>();
    contexts
        .get_mut(&id)
        .ok_or_else(|| JsErrorBox::type_error("Unknown or disposed ANGLE context"))?
        .close()
        .map_err(failure)?;
    contexts.remove(&id);
    objects.remove_context(id);
    Ok(())
}

deno_core::extension!(
    angle_probe,
    ops = [op_angle_create, op_angle_info, op_angle_clear, op_angle_read_pixel, op_angle_resize, op_angle_dispose,
        op_gl_create_shader, op_gl_compile_shader, op_gl_shader_status,
        op_gl_create_program, op_gl_attach_shader, op_gl_link_program,
        op_gl_delete_shader, op_gl_delete_program,
        op_gl_get_parameter, op_gl_get_shader_precision_format, op_gl_get_error,
        op_gl_stencil_mask, op_gl_clear_color, op_gl_clear_depth, op_gl_clear_stencil, op_gl_clear,
        op_gl_enable, op_gl_disable, op_gl_depth_func, op_gl_depth_mask,
        op_gl_color_mask, op_gl_front_face, op_gl_cull_face, op_gl_viewport, op_gl_scissor,
        op_gl_create_texture, op_gl_bind_texture, op_gl_delete_texture, op_gl_tex_parameteri,
        op_gl_tex_image_2d, op_gl_tex_image_3d,
        op_gl_create_framebuffer, op_gl_bind_framebuffer, op_gl_delete_framebuffer],
    esm_entry_point = "ext:angle_probe/probe-bootstrap.js",
    esm = [dir "src", "probe-bootstrap.js", "webgl.js", "webgl-bootstrap.js"],
    options = { native: State },
    state = |state, options| state.put(options.native),
);

/// Temporary backend probe. It does not expose a WebGL context to application canvases.
pub fn probe_extension(libraries: &Path) -> Result<Extension, String> {
    Ok(angle_probe::init(State {
        display: native::Display::new(libraries)?,
        contexts: BTreeMap::new(),
        next_id: 0,
        objects: resources::Registry::new(),
    }))
}
