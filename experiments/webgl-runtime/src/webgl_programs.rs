//! Standard shader/program operations and owner-checked uniform locations.
//! Uploads return host validation errors to the facade without consuming GLES errors.

use std::collections::HashMap;

use deno_core::{OpState, op2};
use deno_error::JsErrorBox;
use glow::HasContext;
use serde::Serialize;

use crate::{
    State, current, failure, resources::ResourceKind, shaders::Object, webgl_state::ParameterValue,
};

#[derive(Clone, Copy)]
pub struct UniformLocation {
    program: u32,
    generation: u64,
    native: glow::NativeUniformLocation,
}

#[derive(Default)]
struct ProgramRecord {
    generation: u64,
    deleted: bool,
}

#[derive(Default)]
struct ContextPrograms {
    shaders: HashMap<u32, u32>,
    programs: HashMap<u32, ProgramRecord>,
    current: Option<u32>,
}

#[derive(Default)]
pub struct ProgramState {
    contexts: HashMap<u32, ContextPrograms>,
}

impl ProgramState {
    pub fn register_shader(&mut self, context: u32, id: u32, kind: u32) {
        self.contexts
            .entry(context)
            .or_default()
            .shaders
            .insert(id, kind);
    }

    pub fn remove_shader(&mut self, context: u32, id: u32) {
        if let Some(owner) = self.contexts.get_mut(&context) {
            owner.shaders.remove(&id);
        }
    }

    pub fn remove_context(&mut self, context: u32) {
        self.contexts.remove(&context);
    }

    pub fn before_link(&mut self, context: u32, program: u32) -> Result<(), JsErrorBox> {
        let record = self
            .contexts
            .entry(context)
            .or_default()
            .programs
            .entry(program)
            .or_default();
        record.generation = record
            .generation
            .checked_add(1)
            .ok_or_else(|| failure("Program link generation exhausted"))?;
        Ok(())
    }

    pub fn remove_program(&mut self, context: u32, program: u32) {
        if let Some(owner) = self.contexts.get_mut(&context) {
            if owner.current == Some(program) {
                // GLES retains a deleted current program until another useProgram.
                owner.programs.entry(program).or_default().deleted = true;
            } else {
                owner.programs.remove(&program);
            }
        }
    }

    fn use_program(&mut self, context: u32, program: Option<u32>) {
        let owner = self.contexts.entry(context).or_default();
        if let Some(previous) = owner.current
            && Some(previous) != program
            && owner
                .programs
                .get(&previous)
                .is_some_and(|record| record.deleted)
        {
            owner.programs.remove(&previous);
        }
        owner.current = program;
        if let Some(program) = program {
            owner.programs.entry(program).or_default();
        }
    }

    fn generation(&self, context: u32, program: u32) -> u64 {
        self.contexts
            .get(&context)
            .and_then(|owner| owner.programs.get(&program))
            .map_or(0, |record| record.generation)
    }

    fn accepts(&self, context: u32, location: &UniformLocation) -> bool {
        self.contexts.get(&context).is_some_and(|owner| {
            owner.current == Some(location.program)
                && owner
                    .programs
                    .get(&location.program)
                    .is_some_and(|record| record.generation == location.generation)
        })
    }
}

fn shader(state: &OpState, context: u32, id: u32) -> Result<glow::NativeShader, JsErrorBox> {
    match state
        .borrow::<State>()
        .objects
        .get(context, ResourceKind::Shader, id)
        .map_err(|error| failure(error.to_string()))?
    {
        Object::Shader(value) => Ok(*value),
        _ => unreachable!("registry kind invariant"),
    }
}

fn program(state: &OpState, context: u32, id: u32) -> Result<glow::NativeProgram, JsErrorBox> {
    match state
        .borrow::<State>()
        .objects
        .get(context, ResourceKind::Program, id)
        .map_err(|error| failure(error.to_string()))?
    {
        Object::Program(value) => Ok(*value),
        _ => unreachable!("registry kind invariant"),
    }
}

fn invalid_enum(gl: &glow::Context) {
    // These rejected GLES calls set a flag without changing state or draining errors.
    unsafe { gl.enable(u32::MAX) };
}

fn invalid_value(gl: &glow::Context) {
    unsafe { gl.viewport(0, 0, -1, 0) };
}

fn valid_name(gl: &glow::Context, name: &str) -> bool {
    // glow's name queries use CString::new(...).unwrap(); embedded NUL must never reach them.
    if name.contains('\0') || name.len() > 256 {
        invalid_value(gl);
        false
    } else {
        true
    }
}

#[op2(fast)]
pub fn op_wgl_shader_source(
    state: &mut OpState,
    context: u32,
    id: u32,
    #[string] source: String,
) -> Result<(), JsErrorBox> {
    let value = shader(state, context, id)?;
    let gl = &current(state, context)?.gl;
    unsafe { gl.shader_source(value, &source) };
    Ok(())
}

#[op2(fast)]
pub fn op_wgl_compile_shader(state: &mut OpState, context: u32, id: u32) -> Result<(), JsErrorBox> {
    let value = shader(state, context, id)?;
    let gl = &current(state, context)?.gl;
    unsafe { gl.compile_shader(value) };
    Ok(())
}

#[op2(fast)]
pub fn op_wgl_link_program(state: &mut OpState, context: u32, id: u32) -> Result<(), JsErrorBox> {
    let value = program(state, context, id)?;
    // Validate current ownership before advancing the generation. Every link attempt
    // invalidates prior WebGL locations, even when the new executable fails to link.
    current(state, context)?;
    state
        .borrow_mut::<State>()
        .programs
        .before_link(context, id)?;
    let gl = &current(state, context)?.gl;
    unsafe { gl.link_program(value) };
    Ok(())
}

#[op2(fast)]
pub fn op_wgl_use_program(state: &mut OpState, context: u32, id: u32) -> Result<(), JsErrorBox> {
    let value = if id == 0 {
        None
    } else {
        Some(program(state, context, id)?)
    };
    let gl = &current(state, context)?.gl;
    let accepted = unsafe {
        gl.use_program(value);
        gl.get_parameter_program(glow::CURRENT_PROGRAM) == value
    };
    if accepted {
        state
            .borrow_mut::<State>()
            .programs
            .use_program(context, (id != 0).then_some(id));
    }
    Ok(())
}

#[op2(fast)]
pub fn op_wgl_bind_attrib_location(
    state: &mut OpState,
    context: u32,
    id: u32,
    index: u32,
    #[string] name: String,
) -> Result<(), JsErrorBox> {
    let value = program(state, context, id)?;
    let gl = &current(state, context)?.gl;
    if valid_name(gl, &name) {
        unsafe { gl.bind_attrib_location(value, index, &name) };
    }
    Ok(())
}

#[op2]
#[serde]
pub fn op_wgl_shader_parameter(
    state: &mut OpState,
    context: u32,
    id: u32,
    pname: u32,
) -> Result<ParameterValue, JsErrorBox> {
    let value = shader(state, context, id)?;
    let kind = state
        .borrow::<State>()
        .programs
        .contexts
        .get(&context)
        .and_then(|owner| owner.shaders.get(&id))
        .copied();
    let gl = &current(state, context)?.gl;
    Ok(match pname {
        glow::SHADER_TYPE => ParameterValue::Number(f64::from(
            kind.ok_or_else(|| failure("Shader type metadata missing"))?,
        )),
        glow::COMPILE_STATUS => {
            ParameterValue::Boolean(unsafe { gl.get_shader_compile_status(value) })
        }
        // Deleted wrappers leave the identity registry; the facade handles their query lifecycle.
        glow::DELETE_STATUS => ParameterValue::Boolean(false),
        _ => {
            invalid_enum(gl);
            ParameterValue::Null(())
        }
    })
}

#[op2]
#[serde]
pub fn op_wgl_program_parameter(
    state: &mut OpState,
    context: u32,
    id: u32,
    pname: u32,
) -> Result<ParameterValue, JsErrorBox> {
    let value = program(state, context, id)?;
    let gl = &current(state, context)?.gl;
    Ok(match pname {
        glow::DELETE_STATUS | glow::LINK_STATUS | glow::VALIDATE_STATUS => {
            ParameterValue::Boolean(unsafe { gl.get_program_parameter_i32(value, pname) } != 0)
        }
        glow::ATTACHED_SHADERS
        | glow::ACTIVE_ATTRIBUTES
        | glow::ACTIVE_UNIFORMS
        | glow::ACTIVE_UNIFORM_BLOCKS
        | glow::TRANSFORM_FEEDBACK_BUFFER_MODE
        | glow::TRANSFORM_FEEDBACK_VARYINGS => ParameterValue::Number(f64::from(unsafe {
            gl.get_program_parameter_i32(value, pname)
        })),
        _ => {
            invalid_enum(gl);
            ParameterValue::Null(())
        }
    })
}

#[op2]
#[string]
pub fn op_wgl_shader_info_log(
    state: &mut OpState,
    context: u32,
    id: u32,
) -> Result<String, JsErrorBox> {
    let value = shader(state, context, id)?;
    Ok(unsafe { current(state, context)?.gl.get_shader_info_log(value) })
}

#[op2]
#[string]
pub fn op_wgl_program_info_log(
    state: &mut OpState,
    context: u32,
    id: u32,
) -> Result<String, JsErrorBox> {
    let value = program(state, context, id)?;
    Ok(unsafe { current(state, context)?.gl.get_program_info_log(value) })
}

#[derive(Serialize)]
pub struct ActiveInfo {
    name: String,
    size: i32,
    #[serde(rename = "type")]
    kind: u32,
}

#[op2]
#[serde]
pub fn op_wgl_get_active_uniform(
    state: &mut OpState,
    context: u32,
    id: u32,
    index: u32,
) -> Result<Option<ActiveInfo>, JsErrorBox> {
    let value = program(state, context, id)?;
    let gl = &current(state, context)?.gl;
    unsafe {
        if index >= gl.get_active_uniforms(value) {
            invalid_value(gl);
            return Ok(None);
        }
        Ok(gl.get_active_uniform(value, index).map(|info| ActiveInfo {
            name: info.name,
            size: info.size,
            kind: info.utype,
        }))
    }
}

#[op2]
#[serde]
pub fn op_wgl_get_active_attrib(
    state: &mut OpState,
    context: u32,
    id: u32,
    index: u32,
) -> Result<Option<ActiveInfo>, JsErrorBox> {
    let value = program(state, context, id)?;
    let gl = &current(state, context)?.gl;
    unsafe {
        if index >= gl.get_active_attributes(value) {
            invalid_value(gl);
            return Ok(None);
        }
        Ok(gl
            .get_active_attribute(value, index)
            .map(|info| ActiveInfo {
                name: info.name,
                size: info.size,
                kind: info.atype,
            }))
    }
}

#[op2(fast)]
pub fn op_wgl_get_attrib_location(
    state: &mut OpState,
    context: u32,
    id: u32,
    #[string] name: String,
) -> Result<i32, JsErrorBox> {
    let value = program(state, context, id)?;
    let gl = &current(state, context)?.gl;
    if !valid_name(gl, &name) {
        return Ok(-1);
    }
    Ok(unsafe { gl.get_attrib_location(value, &name) }.map_or(-1, |index| index as i32))
}

#[op2(fast)]
pub fn op_wgl_get_uniform_location(
    state: &mut OpState,
    context: u32,
    id: u32,
    #[string] name: String,
) -> Result<u32, JsErrorBox> {
    let value = program(state, context, id)?;
    let gl = &current(state, context)?.gl;
    if !valid_name(gl, &name) {
        return Ok(0);
    }
    let Some(native) = (unsafe { gl.get_uniform_location(value, &name) }) else {
        return Ok(0);
    };
    let state = state.borrow_mut::<State>();
    let generation = state.programs.generation(context, id);
    state
        .objects
        .insert(
            context,
            ResourceKind::UniformLocation,
            Object::UniformLocation(UniformLocation {
                program: id,
                generation,
                native,
            }),
        )
        .map_err(|error| failure(error.to_string()))
}

fn uniform_location(
    state: &OpState,
    context: u32,
    id: u32,
) -> Result<Option<glow::NativeUniformLocation>, u32> {
    if id == 0 {
        return Ok(None);
    }
    let state = state.borrow::<State>();
    let location = match state
        .objects
        .get(context, ResourceKind::UniformLocation, id)
    {
        Ok(Object::UniformLocation(location)) => location,
        _ => return Err(glow::INVALID_OPERATION),
    };
    if !state.programs.accepts(context, location) {
        return Err(glow::INVALID_OPERATION);
    }
    Ok(Some(location.native))
}

fn signed_uniform_values(data: &[u32]) -> &[i32] {
    // Deno's fast buffer mapping supports u32, not i32. Both types have identical
    // size/alignment and every bit pattern is valid; the shared borrow prevents
    // mutation during this synchronous upload and retains the original lifetime.
    unsafe { std::slice::from_raw_parts(data.as_ptr().cast::<i32>(), data.len()) }
}

fn valid_upload_length(length: usize, components: u32) -> bool {
    components != 0
        && length.is_multiple_of(components as usize)
        && length / components as usize <= i32::MAX as usize
}

#[op2(fast)]
pub fn op_wgl_uniform_float(
    state: &mut OpState,
    context: u32,
    id: u32,
    components: u32,
    x: f32,
    y: f32,
    z: f32,
    w: f32,
) -> Result<u32, JsErrorBox> {
    let location = match uniform_location(state, context, id) {
        Ok(value) => value,
        Err(error) => return Ok(error),
    };
    let gl = &current(state, context)?.gl;
    let Some(location) = location else {
        return Ok(glow::NO_ERROR);
    };
    unsafe {
        match components {
            1 => gl.uniform_1_f32(Some(&location), x),
            2 => gl.uniform_2_f32(Some(&location), x, y),
            3 => gl.uniform_3_f32(Some(&location), x, y, z),
            4 => gl.uniform_4_f32(Some(&location), x, y, z, w),
            _ => return Ok(glow::INVALID_VALUE),
        }
    }
    Ok(glow::NO_ERROR)
}

#[op2(fast)]
pub fn op_wgl_uniform_int(
    state: &mut OpState,
    context: u32,
    id: u32,
    components: u32,
    x: i32,
    y: i32,
    z: i32,
    w: i32,
) -> Result<u32, JsErrorBox> {
    let location = match uniform_location(state, context, id) {
        Ok(value) => value,
        Err(error) => return Ok(error),
    };
    let gl = &current(state, context)?.gl;
    let Some(location) = location else {
        return Ok(glow::NO_ERROR);
    };
    unsafe {
        match components {
            1 => gl.uniform_1_i32(Some(&location), x),
            2 => gl.uniform_2_i32(Some(&location), x, y),
            3 => gl.uniform_3_i32(Some(&location), x, y, z),
            4 => gl.uniform_4_i32(Some(&location), x, y, z, w),
            _ => return Ok(glow::INVALID_VALUE),
        }
    }
    Ok(glow::NO_ERROR)
}

#[op2(fast)]
pub fn op_wgl_uniform_fv(
    state: &mut OpState,
    context: u32,
    id: u32,
    components: u32,
    #[buffer] data: &[f32],
) -> Result<u32, JsErrorBox> {
    let location = match uniform_location(state, context, id) {
        Ok(value) => value,
        Err(error) => return Ok(error),
    };
    let gl = &current(state, context)?.gl;
    let Some(location) = location else {
        return Ok(glow::NO_ERROR);
    };
    if !(1..=4).contains(&components) || !valid_upload_length(data.len(), components) {
        return Ok(glow::INVALID_VALUE);
    }
    unsafe {
        match components {
            1 => gl.uniform_1_f32_slice(Some(&location), data),
            2 => gl.uniform_2_f32_slice(Some(&location), data),
            3 => gl.uniform_3_f32_slice(Some(&location), data),
            4 => gl.uniform_4_f32_slice(Some(&location), data),
            _ => unreachable!(),
        }
    }
    Ok(glow::NO_ERROR)
}

#[op2(fast)]
pub fn op_wgl_uniform_iv(
    state: &mut OpState,
    context: u32,
    id: u32,
    components: u32,
    #[buffer] data: &[u32],
) -> Result<u32, JsErrorBox> {
    let location = match uniform_location(state, context, id) {
        Ok(value) => value,
        Err(error) => return Ok(error),
    };
    let gl = &current(state, context)?.gl;
    let Some(location) = location else {
        return Ok(glow::NO_ERROR);
    };
    if !(1..=4).contains(&components) || !valid_upload_length(data.len(), components) {
        return Ok(glow::INVALID_VALUE);
    }
    let data = signed_uniform_values(data);
    unsafe {
        match components {
            1 => gl.uniform_1_i32_slice(Some(&location), data),
            2 => gl.uniform_2_i32_slice(Some(&location), data),
            3 => gl.uniform_3_i32_slice(Some(&location), data),
            4 => gl.uniform_4_i32_slice(Some(&location), data),
            _ => unreachable!(),
        }
    }
    Ok(glow::NO_ERROR)
}

#[op2(fast)]
pub fn op_wgl_uniform_matrix(
    state: &mut OpState,
    context: u32,
    id: u32,
    dimension: u32,
    transpose: bool,
    #[buffer] data: &[f32],
) -> Result<u32, JsErrorBox> {
    let location = match uniform_location(state, context, id) {
        Ok(value) => value,
        Err(error) => return Ok(error),
    };
    let gl = &current(state, context)?.gl;
    let Some(location) = location else {
        return Ok(glow::NO_ERROR);
    };
    if transpose
        || !(2..=4).contains(&dimension)
        || !valid_upload_length(data.len(), dimension * dimension)
    {
        return Ok(glow::INVALID_VALUE);
    }
    unsafe {
        match dimension {
            2 => gl.uniform_matrix_2_f32_slice(Some(&location), false, data),
            3 => gl.uniform_matrix_3_f32_slice(Some(&location), false, data),
            4 => gl.uniform_matrix_4_f32_slice(Some(&location), false, data),
            _ => unreachable!(),
        }
    }
    Ok(glow::NO_ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn location(program: u32, generation: u64) -> UniformLocation {
        UniformLocation {
            program,
            generation,
            native: glow::NativeUniformLocation(3),
        }
    }

    #[test]
    fn location_requires_same_context_current_program_and_link_generation() {
        let mut state = ProgramState::default();
        state.before_link(1, 10).unwrap();
        state.before_link(1, 11).unwrap();
        state.use_program(1, Some(10));
        let first = location(10, 1);
        assert!(state.accepts(1, &first));
        assert!(!state.accepts(2, &first));
        assert!(!state.accepts(1, &location(11, 1)));
        state.before_link(1, 10).unwrap();
        assert!(!state.accepts(1, &first));
        assert!(state.accepts(1, &location(10, 2)));
        state.use_program(1, None);
        assert!(!state.accepts(1, &location(10, 2)));
    }

    #[test]
    fn deleting_current_program_preserves_executable_until_unbound() {
        let mut state = ProgramState::default();
        state.before_link(1, 10).unwrap();
        state.use_program(1, Some(10));
        state.remove_program(1, 10);
        assert!(state.accepts(1, &location(10, 1)));
        state.use_program(1, Some(11));
        assert!(!state.accepts(1, &location(10, 1)));
        assert!(!state.contexts[&1].programs.contains_key(&10));
        state.remove_context(1);
        assert!(!state.accepts(1, &location(11, 0)));
    }

    #[test]
    fn signed_buffer_view_preserves_negative_values_and_subview_extent() {
        let bits = [123, u32::MAX, 0x8000_0000, 0x7fff_ffff, 456];
        let signed = signed_uniform_values(&bits[1..4]);
        assert_eq!(signed, &[-1, i32::MIN, i32::MAX]);
        assert_eq!(signed.as_ptr().cast::<u32>(), bits[1..].as_ptr());
        assert!(signed_uniform_values(&[]).is_empty());
    }

    #[test]
    fn upload_lengths_never_truncate_partial_vectors_or_overflow_glsizei() {
        assert!(valid_upload_length(0, 4));
        assert!(valid_upload_length(12, 3));
        assert!(!valid_upload_length(11, 3));
        assert!(!valid_upload_length(4, 0));
        assert!(valid_upload_length(i32::MAX as usize * 4, 4));
        assert!(!valid_upload_length((i32::MAX as usize + 1) * 4, 4));
    }
}
