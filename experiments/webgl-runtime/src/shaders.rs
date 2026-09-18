use deno_core::{OpState, op2};
use deno_error::JsErrorBox;
use glow::HasContext;

use crate::{State, failure, resources::ResourceKind};

pub enum Object {
    Texture(glow::NativeTexture),
    Framebuffer(glow::NativeFramebuffer),
    Shader(glow::NativeShader),
    Program(glow::NativeProgram),
}

impl Object {
    fn shader(&self) -> glow::NativeShader {
        match self {
            Self::Shader(value) => *value,
            _ => unreachable!("registry kind invariant"),
        }
    }
    fn program(&self) -> glow::NativeProgram {
        match self {
            Self::Program(value) => *value,
            _ => unreachable!("registry kind invariant"),
        }
    }
}

#[op2(fast)]
pub fn op_gl_create_shader(
    state: &mut OpState,
    context: u32,
    kind: u32,
) -> Result<u32, JsErrorBox> {
    if kind != glow::VERTEX_SHADER && kind != glow::FRAGMENT_SHADER {
        return Err(JsErrorBox::type_error("Expected vertex or fragment shader"));
    }
    let State {
        contexts, objects, ..
    } = state.borrow_mut::<State>();
    let owner = contexts
        .get_mut(&context)
        .ok_or_else(|| failure("Unknown context"))?;
    owner.make_current().map_err(failure)?;
    // A live current context owns every GL object stored behind these identities.
    let shader = unsafe { owner.gl.create_shader(kind) }.map_err(failure)?;
    match objects.insert(context, ResourceKind::Shader, Object::Shader(shader)) {
        Ok(id) => Ok(id),
        Err(error) => {
            unsafe { owner.gl.delete_shader(shader) };
            Err(failure(error.to_string()))
        }
    }
}

#[op2(fast)]
pub fn op_gl_compile_shader(
    state: &mut OpState,
    context: u32,
    id: u32,
    #[string] source: String,
) -> Result<(), JsErrorBox> {
    let State {
        contexts, objects, ..
    } = state.borrow_mut::<State>();
    let shader = objects
        .get(context, ResourceKind::Shader, id)
        .map_err(|e| failure(e.to_string()))?
        .shader();
    let owner = contexts
        .get_mut(&context)
        .ok_or_else(|| failure("Unknown context"))?;
    owner.make_current().map_err(failure)?;
    // ANGLE's WebGL-compatible compiler validates the application's GLSL.
    unsafe {
        owner.gl.shader_source(shader, &source);
        owner.gl.compile_shader(shader);
    }
    Ok(())
}

#[op2]
#[serde]
pub fn op_gl_shader_status(
    state: &mut OpState,
    context: u32,
    id: u32,
) -> Result<serde_json::Value, JsErrorBox> {
    let State {
        contexts, objects, ..
    } = state.borrow_mut::<State>();
    let shader = objects
        .get(context, ResourceKind::Shader, id)
        .map_err(|e| failure(e.to_string()))?
        .shader();
    let owner = contexts
        .get_mut(&context)
        .ok_or_else(|| failure("Unknown context"))?;
    owner.make_current().map_err(failure)?;
    unsafe {
        Ok(
            serde_json::json!({"compiled": owner.gl.get_shader_compile_status(shader), "log": owner.gl.get_shader_info_log(shader)}),
        )
    }
}

#[op2(fast)]
pub fn op_gl_create_program(state: &mut OpState, context: u32) -> Result<u32, JsErrorBox> {
    let State {
        contexts, objects, ..
    } = state.borrow_mut::<State>();
    let owner = contexts
        .get_mut(&context)
        .ok_or_else(|| failure("Unknown context"))?;
    owner.make_current().map_err(failure)?;
    let program = unsafe { owner.gl.create_program() }.map_err(failure)?;
    match objects.insert(context, ResourceKind::Program, Object::Program(program)) {
        Ok(id) => Ok(id),
        Err(error) => {
            unsafe { owner.gl.delete_program(program) };
            Err(failure(error.to_string()))
        }
    }
}

#[op2(fast)]
pub fn op_gl_attach_shader(
    state: &mut OpState,
    context: u32,
    program: u32,
    shader: u32,
) -> Result<(), JsErrorBox> {
    let State {
        contexts, objects, ..
    } = state.borrow_mut::<State>();
    let program = objects
        .get(context, ResourceKind::Program, program)
        .map_err(|e| failure(e.to_string()))?
        .program();
    let shader = objects
        .get(context, ResourceKind::Shader, shader)
        .map_err(|e| failure(e.to_string()))?
        .shader();
    let owner = contexts
        .get_mut(&context)
        .ok_or_else(|| failure("Unknown context"))?;
    owner.make_current().map_err(failure)?;
    unsafe {
        owner.gl.attach_shader(program, shader);
    }
    Ok(())
}

#[op2]
#[serde]
pub fn op_gl_link_program(
    state: &mut OpState,
    context: u32,
    id: u32,
) -> Result<serde_json::Value, JsErrorBox> {
    let State {
        contexts, objects, ..
    } = state.borrow_mut::<State>();
    let program = objects
        .get(context, ResourceKind::Program, id)
        .map_err(|e| failure(e.to_string()))?
        .program();
    let owner = contexts
        .get_mut(&context)
        .ok_or_else(|| failure("Unknown context"))?;
    owner.make_current().map_err(failure)?;
    unsafe {
        owner.gl.link_program(program);
        Ok(
            serde_json::json!({"linked": owner.gl.get_program_link_status(program), "log": owner.gl.get_program_info_log(program)}),
        )
    }
}

#[op2(fast)]
pub fn op_gl_delete_shader(state: &mut OpState, context: u32, id: u32) -> Result<(), JsErrorBox> {
    let State {
        contexts, objects, ..
    } = state.borrow_mut::<State>();
    let owner = contexts
        .get_mut(&context)
        .ok_or_else(|| failure("Unknown context"))?;
    owner.make_current().map_err(failure)?;
    let shader = objects
        .remove(context, ResourceKind::Shader, id)
        .map_err(|e| failure(e.to_string()))?
        .shader();
    unsafe { owner.gl.delete_shader(shader) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_delete_program(state: &mut OpState, context: u32, id: u32) -> Result<(), JsErrorBox> {
    let State {
        contexts, objects, ..
    } = state.borrow_mut::<State>();
    let owner = contexts
        .get_mut(&context)
        .ok_or_else(|| failure("Unknown context"))?;
    owner.make_current().map_err(failure)?;
    let program = objects
        .remove(context, ResourceKind::Program, id)
        .map_err(|e| failure(e.to_string()))?
        .program();
    unsafe { owner.gl.delete_program(program) };
    Ok(())
}
