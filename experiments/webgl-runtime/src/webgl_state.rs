use deno_core::{OpState, op2};
use deno_error::JsErrorBox;
use glow::HasContext;
use serde::Serialize;

/// The facade reconstructs WebGL typed arrays; object-binding queries must use
/// its resource registry instead of exposing GLES numeric object names.
#[derive(Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "kebab-case")]
pub enum ParameterValue {
    Number(f64),
    Boolean(bool),
    String(String),
    Int32Array(Vec<i32>),
    Float32Array(Vec<f32>),
    BooleanArray(Vec<bool>),
    Null(()),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrecisionFormat {
    range_min: i32,
    range_max: i32,
    precision: i32,
}

fn invalid_enum(gl: &glow::Context) {
    // This invalid capability cannot change state and sets the driver's error
    // flag without consuming any pending errors with getError.
    unsafe { gl.enable(u32::MAX) };
}

fn is_capability(capability: u32) -> bool {
    matches!(
        capability,
        glow::BLEND
            | glow::CULL_FACE
            | glow::DEPTH_TEST
            | glow::DITHER
            | glow::POLYGON_OFFSET_FILL
            | glow::SAMPLE_ALPHA_TO_COVERAGE
            | glow::SAMPLE_COVERAGE
            | glow::SCISSOR_TEST
            | glow::STENCIL_TEST
            | glow::RASTERIZER_DISCARD
    )
}

#[op2]
#[serde]
pub fn op_gl_get_parameter(
    state: &mut OpState,
    context: u32,
    pname: u32,
) -> Result<ParameterValue, JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    // Each allowlisted pname has a fixed native type and arity. An arbitrary
    // pname passed to a scalar glGet* could overwrite its one-element output.
    let value = unsafe {
        match pname {
            glow::VENDOR | glow::RENDERER | glow::VERSION | glow::SHADING_LANGUAGE_VERSION => {
                ParameterValue::String(gl.get_parameter_string(pname))
            }
            glow::COLOR_WRITEMASK => {
                ParameterValue::BooleanArray(gl.get_parameter_bool_array::<4>(pname).to_vec())
            }
            glow::DEPTH_WRITEMASK | glow::SAMPLE_COVERAGE_INVERT => {
                ParameterValue::Boolean(gl.get_parameter_bool(pname))
            }
            capability if is_capability(capability) => {
                ParameterValue::Boolean(gl.is_enabled(capability))
            }
            glow::VIEWPORT | glow::SCISSOR_BOX => {
                let mut values = [0; 4];
                gl.get_parameter_i32_slice(pname, &mut values);
                ParameterValue::Int32Array(values.to_vec())
            }
            glow::MAX_VIEWPORT_DIMS => {
                let mut values = [0; 2];
                gl.get_parameter_i32_slice(pname, &mut values);
                ParameterValue::Int32Array(values.to_vec())
            }
            glow::COLOR_CLEAR_VALUE | glow::BLEND_COLOR => {
                let mut values = [0.0; 4];
                gl.get_parameter_f32_slice(pname, &mut values);
                ParameterValue::Float32Array(values.to_vec())
            }
            glow::DEPTH_RANGE | glow::ALIASED_LINE_WIDTH_RANGE | glow::ALIASED_POINT_SIZE_RANGE => {
                let mut values = [0.0; 2];
                gl.get_parameter_f32_slice(pname, &mut values);
                ParameterValue::Float32Array(values.to_vec())
            }
            glow::DEPTH_CLEAR_VALUE
            | glow::LINE_WIDTH
            | glow::POLYGON_OFFSET_FACTOR
            | glow::POLYGON_OFFSET_UNITS
            | glow::SAMPLE_COVERAGE_VALUE
            | glow::MAX_TEXTURE_LOD_BIAS => {
                ParameterValue::Number(gl.get_parameter_f32(pname).into())
            }
            glow::STENCIL_VALUE_MASK
            | glow::STENCIL_WRITEMASK
            | glow::STENCIL_BACK_VALUE_MASK
            | glow::STENCIL_BACK_WRITEMASK => {
                ParameterValue::Number(f64::from(gl.get_parameter_i32(pname) as u32))
            }
            glow::MAX_UNIFORM_BLOCK_SIZE
            | glow::MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS
            | glow::MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS
            | glow::MAX_ELEMENT_INDEX
            | glow::MAX_SERVER_WAIT_TIMEOUT => {
                ParameterValue::Number(gl.get_parameter_i64(pname) as f64)
            }
            glow::MAX_TEXTURE_IMAGE_UNITS
            | glow::MAX_VERTEX_TEXTURE_IMAGE_UNITS
            | glow::MAX_COMBINED_TEXTURE_IMAGE_UNITS
            | glow::MAX_TEXTURE_SIZE
            | glow::MAX_CUBE_MAP_TEXTURE_SIZE
            | glow::MAX_3D_TEXTURE_SIZE
            | glow::MAX_ARRAY_TEXTURE_LAYERS
            | glow::MAX_VERTEX_ATTRIBS
            | glow::MAX_VERTEX_UNIFORM_VECTORS
            | glow::MAX_FRAGMENT_UNIFORM_VECTORS
            | glow::MAX_VARYING_VECTORS
            | glow::MAX_VARYING_COMPONENTS
            | glow::MAX_VERTEX_UNIFORM_COMPONENTS
            | glow::MAX_FRAGMENT_UNIFORM_COMPONENTS
            | glow::MAX_VERTEX_OUTPUT_COMPONENTS
            | glow::MAX_FRAGMENT_INPUT_COMPONENTS
            | glow::MAX_VERTEX_UNIFORM_BLOCKS
            | glow::MAX_FRAGMENT_UNIFORM_BLOCKS
            | glow::MAX_COMBINED_UNIFORM_BLOCKS
            | glow::MAX_UNIFORM_BUFFER_BINDINGS
            | glow::UNIFORM_BUFFER_OFFSET_ALIGNMENT
            | glow::MAX_SAMPLES
            | glow::SAMPLES
            | glow::SAMPLE_BUFFERS
            | glow::MAX_RENDERBUFFER_SIZE
            | glow::MAX_COLOR_ATTACHMENTS
            | glow::MAX_DRAW_BUFFERS
            | glow::MAX_ELEMENTS_INDICES
            | glow::MAX_ELEMENTS_VERTICES
            | glow::MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS
            | glow::MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS
            | glow::MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS
            | glow::ACTIVE_TEXTURE
            | glow::RED_BITS
            | glow::GREEN_BITS
            | glow::BLUE_BITS
            | glow::ALPHA_BITS
            | glow::DEPTH_BITS
            | glow::STENCIL_BITS
            | glow::DEPTH_FUNC
            | glow::CULL_FACE_MODE
            | glow::FRONT_FACE
            | glow::BLEND_SRC_RGB
            | glow::BLEND_SRC_ALPHA
            | glow::BLEND_DST_RGB
            | glow::BLEND_DST_ALPHA
            | glow::BLEND_EQUATION_RGB
            | glow::BLEND_EQUATION_ALPHA
            | glow::STENCIL_CLEAR_VALUE
            | glow::STENCIL_FUNC
            | glow::STENCIL_REF
            | glow::STENCIL_FAIL
            | glow::STENCIL_PASS_DEPTH_FAIL
            | glow::STENCIL_PASS_DEPTH_PASS
            | glow::STENCIL_BACK_FUNC
            | glow::STENCIL_BACK_REF
            | glow::STENCIL_BACK_FAIL
            | glow::STENCIL_BACK_PASS_DEPTH_FAIL
            | glow::STENCIL_BACK_PASS_DEPTH_PASS
            | glow::PACK_ALIGNMENT
            | glow::UNPACK_ALIGNMENT
            | glow::PACK_ROW_LENGTH
            | glow::PACK_SKIP_PIXELS
            | glow::PACK_SKIP_ROWS
            | glow::UNPACK_ROW_LENGTH
            | glow::UNPACK_IMAGE_HEIGHT
            | glow::UNPACK_SKIP_PIXELS
            | glow::UNPACK_SKIP_ROWS
            | glow::UNPACK_SKIP_IMAGES
            | glow::IMPLEMENTATION_COLOR_READ_FORMAT
            | glow::IMPLEMENTATION_COLOR_READ_TYPE
            | glow::GENERATE_MIPMAP_HINT
            | glow::FRAGMENT_SHADER_DERIVATIVE_HINT => {
                ParameterValue::Number(gl.get_parameter_i32(pname).into())
            }
            _ => {
                invalid_enum(gl);
                ParameterValue::Null(())
            }
        }
    };
    Ok(value)
}

#[op2]
#[serde]
pub fn op_gl_get_shader_precision_format(
    state: &mut OpState,
    context: u32,
    shader_type: u32,
    precision_type: u32,
) -> Result<Option<PrecisionFormat>, JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    if !matches!(shader_type, glow::VERTEX_SHADER | glow::FRAGMENT_SHADER)
        || !matches!(
            precision_type,
            glow::LOW_FLOAT
                | glow::MEDIUM_FLOAT
                | glow::HIGH_FLOAT
                | glow::LOW_INT
                | glow::MEDIUM_INT
                | glow::HIGH_INT
        )
    {
        invalid_enum(gl);
        return Ok(None);
    }
    // GLES3 provides this query. Glow discards its all-zero unsupported-precision
    // result; WebGL still returns a zero-valued precision object in that case.
    let value = unsafe { gl.get_shader_precision_format(shader_type, precision_type) };
    Ok(Some(match value {
        Some(value) => PrecisionFormat {
            range_min: value.range_min,
            range_max: value.range_max,
            precision: value.precision,
        },
        None => PrecisionFormat {
            range_min: 0,
            range_max: 0,
            precision: 0,
        },
    }))
}

#[op2(fast)]
pub fn op_gl_get_error(state: &mut OpState, context: u32) -> Result<u32, JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    Ok(unsafe { gl.get_error() })
}

#[op2(fast)]
pub fn op_gl_clear_color(
    state: &mut OpState,
    context: u32,
    red: f32,
    green: f32,
    blue: f32,
    alpha: f32,
) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    unsafe { gl.clear_color(red, green, blue, alpha) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_clear_depth(state: &mut OpState, context: u32, depth: f32) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    unsafe { gl.clear_depth_f32(depth) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_clear_stencil(
    state: &mut OpState,
    context: u32,
    stencil: i32,
) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    unsafe { gl.clear_stencil(stencil) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_clear(state: &mut OpState, context: u32, mask: u32) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    unsafe { gl.clear(mask) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_enable(state: &mut OpState, context: u32, capability: u32) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    if is_capability(capability) {
        unsafe { gl.enable(capability) };
    } else {
        invalid_enum(gl);
    }
    Ok(())
}

#[op2(fast)]
pub fn op_gl_disable(state: &mut OpState, context: u32, capability: u32) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    if is_capability(capability) {
        unsafe { gl.disable(capability) };
    } else {
        invalid_enum(gl);
    }
    Ok(())
}

#[op2(fast)]
pub fn op_gl_blend_equation(
    state: &mut OpState,
    context: u32,
    mode: u32,
) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    unsafe { gl.blend_equation(mode) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_blend_equation_separate(
    state: &mut OpState,
    context: u32,
    rgb: u32,
    alpha: u32,
) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    unsafe { gl.blend_equation_separate(rgb, alpha) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_blend_func(
    state: &mut OpState,
    context: u32,
    source: u32,
    destination: u32,
) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    unsafe { gl.blend_func(source, destination) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_blend_func_separate(
    state: &mut OpState,
    context: u32,
    source_rgb: u32,
    destination_rgb: u32,
    source_alpha: u32,
    destination_alpha: u32,
) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    unsafe { gl.blend_func_separate(source_rgb, destination_rgb, source_alpha, destination_alpha) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_blend_color(
    state: &mut OpState,
    context: u32,
    red: f32,
    green: f32,
    blue: f32,
    alpha: f32,
) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    unsafe { gl.blend_color(red, green, blue, alpha) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_depth_func(
    state: &mut OpState,
    context: u32,
    function: u32,
) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    unsafe { gl.depth_func(function) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_depth_mask(state: &mut OpState, context: u32, mask: bool) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    unsafe { gl.depth_mask(mask) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_color_mask(
    state: &mut OpState,
    context: u32,
    red: bool,
    green: bool,
    blue: bool,
    alpha: bool,
) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    unsafe { gl.color_mask(red, green, blue, alpha) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_front_face(state: &mut OpState, context: u32, winding: u32) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    unsafe { gl.front_face(winding) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_cull_face(state: &mut OpState, context: u32, mode: u32) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    unsafe { gl.cull_face(mode) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_viewport(
    state: &mut OpState,
    context: u32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    unsafe { gl.viewport(x, y, width, height) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_scissor(
    state: &mut OpState,
    context: u32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), JsErrorBox> {
    let gl = &crate::current(state, context)?.gl;
    unsafe { gl.scissor(x, y, width, height) };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_wire_shape_preserves_typed_array_kind_and_explicit_null() {
        assert_eq!(
            serde_json::to_value(ParameterValue::Int32Array(vec![0, -2, 64, 32])).unwrap(),
            serde_json::json!({"kind":"int32-array","value":[0,-2,64,32]})
        );
        assert_eq!(
            serde_json::to_value(ParameterValue::Null(())).unwrap(),
            serde_json::json!({"kind":"null","value":null})
        );
    }
}

#[op2(fast)]
pub fn op_gl_stencil_mask(state: &mut OpState, context: u32, mask: u32) -> Result<(), JsErrorBox> {
    let owner = crate::current(state, context)?;
    unsafe { owner.gl.stencil_mask(mask) };
    Ok(())
}
