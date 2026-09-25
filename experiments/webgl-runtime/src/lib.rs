use std::{collections::BTreeMap, path::Path, rc::Rc};

use deno_core::{Extension, OpState, op2};
use deno_error::JsErrorBox;
use glow::HasContext;
use serde_json::json;

mod native;
mod snapshot;
pub use snapshot::Snapshot;
pub mod resources;
mod shaders;
#[cfg(feature = "metal-snapshot")]
pub mod snapshot_consumer;
mod webgl_geometry;
mod webgl_programs;
mod webgl_readback;
use webgl_geometry::*;
use webgl_programs::*;
use webgl_readback::*;
mod webgl_state;
mod webgl_textures;
use shaders::*;
use webgl_state::*;
use webgl_textures::*;

#[cfg(test)]
mod uniform_lifecycle_tests;

struct State {
    display: Rc<native::Display>,
    contexts: BTreeMap<u32, native::Context>,
    next_id: u32,
    programs: webgl_programs::ProgramState,
    objects: resources::Registry<shaders::Object>,
}

/// Create a host-only export lease for a live context identity.
/// Close the lease before resizing or disposing that canvas.
pub fn snapshot(runtime: &mut deno_core::JsRuntime, context_id: u32) -> Result<Snapshot, String> {
    let state = runtime.op_state();
    let state = state.borrow();
    state
        .borrow::<State>()
        .contexts
        .get(&context_id)
        .ok_or_else(|| "Unknown or disposed ANGLE context".to_string())?
        .snapshot()
}

/// Clear the default drawing buffer after the host has presented its composite.
pub fn discard_drawing_buffer(
    runtime: &mut deno_core::JsRuntime,
    context_id: u32,
) -> Result<(), String> {
    let state = runtime.op_state();
    state
        .borrow_mut()
        .borrow_mut::<State>()
        .contexts
        .get(&context_id)
        .ok_or_else(|| "Unknown or disposed ANGLE context".to_string())?
        .discard_drawing_buffer()
}

/// Read a bounded RGBA frame for host-side integration assertions.
pub fn observe_frame(
    runtime: &mut deno_core::JsRuntime,
    context_id: u32,
    width: u32,
    height: u32,
    output: &mut [u8],
) -> Result<(), String> {
    let required = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4));
    if required.is_none_or(|bytes| {
        bytes == 0 || bytes as usize != output.len() || bytes > 16 * 1024 * 1024
    }) {
        return Err("RGBA observation exceeds its bounded output".into());
    }
    let state = runtime.op_state();
    let mut state = state.borrow_mut();
    let context = current(&mut state, context_id).map_err(|error| error.to_string())?;
    unsafe {
        for (name, expected) in [
            (glow::PIXEL_PACK_BUFFER_BINDING, 0),
            (glow::PACK_ALIGNMENT, 4),
            (glow::PACK_ROW_LENGTH, 0),
            (glow::PACK_SKIP_PIXELS, 0),
            (glow::PACK_SKIP_ROWS, 0),
        ] {
            if context.gl.get_parameter_i32(name) != expected {
                return Err("RGBA observation requires default pack state".into());
            }
        }
        context.gl.read_pixels(
            0,
            0,
            width as i32,
            height as i32,
            glow::RGBA,
            glow::UNSIGNED_BYTE,
            glow::PixelPackData::Slice(Some(output)),
        );
        let error = context.gl.get_error();
        if error != glow::NO_ERROR {
            return Err(format!("ANGLE observation failed: {error:#x}"));
        }
    }
    Ok(())
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
fn op_angle_create_with_attributes(
    state: &mut OpState,
    width: u32,
    height: u32,
    alpha: bool,
    depth: bool,
    stencil: bool,
) -> Result<serde_json::Value, JsErrorBox> {
    let state = state.borrow_mut::<State>();
    if state.contexts.len() >= 16 {
        return Err(failure("The experimental context limit is 16"));
    }
    let id = state
        .next_id
        .checked_add(1)
        .ok_or_else(|| failure("Context identity exhausted"))?;
    let context = native::Context::with_attributes(
        state.display.clone(),
        width,
        height,
        alpha,
        depth,
        stencil,
    )
    .map_err(failure)?;
    // Native selection enforces exact buffer presence before returning the context.
    state.next_id = id;
    state.contexts.insert(id, context);
    Ok(json!({"id": id, "alpha": alpha, "depth": depth, "stencil": stencil}))
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
fn op_angle_read_rgba(
    state: &mut OpState,
    id: u32,
    width: u32,
    height: u32,
    #[buffer] output: &mut [u8],
) -> Result<(), JsErrorBox> {
    let required = width.checked_mul(height).and_then(|n| n.checked_mul(4));
    if required.is_none_or(|n| n > 16 * 1024 * 1024 || n as usize != output.len()) {
        return Err(JsErrorBox::type_error(
            "RGBA observation exceeds its bounded output",
        ));
    }
    let owner = current(state, id)?;
    unsafe {
        for (name, expected) in [
            (glow::PIXEL_PACK_BUFFER_BINDING, 0),
            (glow::PACK_ALIGNMENT, 4),
            (glow::PACK_ROW_LENGTH, 0),
            (glow::PACK_SKIP_PIXELS, 0),
            (glow::PACK_SKIP_ROWS, 0),
        ] {
            if owner.gl.get_parameter_i32(name) != expected {
                return Err(failure("RGBA observation requires default pack state"));
            }
        }
        owner.gl.read_pixels(
            0,
            0,
            width as i32,
            height as i32,
            glow::RGBA,
            glow::UNSIGNED_BYTE,
            glow::PixelPackData::Slice(Some(output)),
        );
        if owner.gl.get_error() != glow::NO_ERROR {
            return Err(failure(
                "RGBA observation failed or inherited a pending GL error",
            ));
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
        contexts,
        objects,
        programs,
        ..
    } = state.borrow_mut::<State>();
    contexts
        .get_mut(&id)
        .ok_or_else(|| JsErrorBox::type_error("Unknown or disposed ANGLE context"))?
        .close()
        .map_err(failure)?;
    contexts.remove(&id);
    objects.remove_context(id);
    programs.remove_context(id);
    Ok(())
}

deno_core::extension!(
    angle_probe,
    ops = [op_wgl_shader_source, op_wgl_compile_shader, op_wgl_link_program, op_wgl_use_program, op_wgl_bind_attrib_location, op_wgl_shader_parameter, op_wgl_program_parameter, op_wgl_shader_info_log, op_wgl_program_info_log, op_wgl_get_active_uniform, op_wgl_get_active_attrib, op_wgl_get_attrib_location, op_wgl_get_uniform_location, op_wgl_uniform_float, op_wgl_uniform_int, op_wgl_uniform_fv, op_wgl_uniform_iv, op_wgl_uniform_matrix,
        op_wgl_create_buffer, op_wgl_bind_buffer, op_wgl_delete_buffer, op_wgl_buffer_data_size, op_wgl_buffer_data_bytes, op_wgl_buffer_sub_data, op_wgl_create_vertex_array, op_wgl_bind_vertex_array, op_wgl_delete_vertex_array, op_wgl_enable_vertex_attrib_array, op_wgl_disable_vertex_attrib_array, op_wgl_vertex_attrib_divisor, op_wgl_vertex_attrib_pointer, op_wgl_draw_arrays, op_wgl_draw_elements,
        op_angle_read_rgba, op_angle_create, op_angle_create_with_attributes, op_angle_info, op_angle_clear, op_angle_read_pixel, op_angle_resize, op_angle_dispose,
        op_gl_create_shader, op_gl_compile_shader, op_gl_shader_status,
        op_gl_create_program, op_gl_attach_shader, op_gl_link_program,
        op_gl_delete_shader, op_gl_delete_program,
        op_gl_get_parameter, op_gl_get_shader_precision_format, op_gl_get_error,
        op_gl_stencil_mask, op_gl_clear_color, op_gl_clear_depth, op_gl_clear_stencil, op_gl_clear,
        op_gl_blend_equation, op_gl_blend_equation_separate, op_gl_blend_func,
        op_gl_blend_func_separate, op_gl_blend_color,
        op_gl_enable, op_gl_disable, op_gl_depth_func, op_gl_depth_mask,
        op_gl_color_mask, op_gl_front_face, op_gl_cull_face, op_gl_viewport, op_gl_scissor,
        op_gl_create_texture, op_gl_bind_texture, op_gl_delete_texture, op_gl_tex_parameteri,
        op_gl_tex_image_2d, op_gl_tex_image_3d,
        op_gl_create_framebuffer, op_gl_bind_framebuffer, op_gl_delete_framebuffer,
        op_gl_read_pixels],
    esm_entry_point = "ext:angle_probe/probe-bootstrap.js",
    esm = [dir "src", "probe-bootstrap.js", "webgl.js", "webgl-bootstrap.js", "webgl-geometry.js", "webgl-programs.js"],
    options = { native: State },
    state = |state, options| state.put(options.native),
);

/// Temporary backend probe. It does not expose a WebGL context to application canvases.
pub fn probe_extension(libraries: &Path) -> Result<Extension, String> {
    Ok(angle_probe::init(State {
        display: native::Display::new(libraries)?,
        contexts: BTreeMap::new(),
        next_id: 0,
        programs: webgl_programs::ProgramState::default(),
        objects: resources::Registry::new(),
    }))
}

/// Register native operations and importable modules without installing probe globals.
/// The embedding host must remove Deno bootstrap globals after constructing its
/// realm and before application execution; extension registration alone does not
/// hide `Deno.core.ops`. The shared DOM host uses `seal_application_realm`.
pub fn runtime_extension(libraries: &Path) -> Result<Extension, String> {
    let mut extension = probe_extension(libraries)?;
    extension.esm_entry_point = None;
    extension.esm_files = vec![
        deno_core::ExtensionFileSource::new(
            "ext:angle_probe/webgl.js",
            deno_core::ascii_str_include!("webgl.js"),
        ),
        deno_core::ExtensionFileSource::new(
            "ext:angle_probe/webgl-geometry.js",
            deno_core::ascii_str_include!("webgl-geometry.js"),
        ),
        deno_core::ExtensionFileSource::new(
            "ext:angle_probe/webgl-programs.js",
            deno_core::ascii_str_include!("webgl-programs.js"),
        ),
    ]
    .into();
    Ok(extension)
}

/// Close contexts after the host has completed every external GPU consumer.
/// Failed native teardown keeps its identity available for retry.
pub fn release_all(runtime: &mut deno_core::JsRuntime) -> Result<(), String> {
    let state = runtime.op_state();
    let mut state = state.borrow_mut();
    let State {
        contexts,
        objects,
        programs,
        ..
    } = state.borrow_mut::<State>();
    let ids: Vec<_> = contexts.keys().copied().collect();
    let mut failures = Vec::new();
    for id in ids {
        match contexts.get_mut(&id).unwrap().close() {
            Ok(()) => {
                contexts.remove(&id);
                objects.remove_context(id);
                programs.remove_context(id);
            }
            Err(error) => failures.push(format!("Context {id}: {error}")),
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}
