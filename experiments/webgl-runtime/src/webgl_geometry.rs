//! Typed buffer/VAO operations with a 64 MiB per-buffer allocation limit.
//! Only ARRAY_BUFFER and ELEMENT_ARRAY_BUFFER are admitted; client arrays and
//! pixel-buffer offsets cannot enter through this module. Returned GL codes are
//! host validation errors, not a drain of ANGLE's pending error flags.

use deno_core::{OpState, op2};
use deno_error::JsErrorBox;
use glow::HasContext;

use crate::{State, current, failure, resources::ResourceKind, shaders::Object};

const MAX_BUFFER_BYTES: usize = 64 * 1024 * 1024;

fn buffer(object: &Object) -> glow::NativeBuffer {
    match object {
        Object::Buffer(value) => *value,
        _ => unreachable!("registry kind invariant"),
    }
}

fn vertex_array(object: &Object) -> glow::NativeVertexArray {
    match object {
        Object::VertexArray(value) => *value,
        _ => unreachable!("registry kind invariant"),
    }
}

fn binding_parameter(target: u32) -> Result<u32, u32> {
    match target {
        glow::ARRAY_BUFFER => Ok(glow::ARRAY_BUFFER_BINDING),
        glow::ELEMENT_ARRAY_BUFFER => Ok(glow::ELEMENT_ARRAY_BUFFER_BINDING),
        _ => Err(glow::INVALID_ENUM),
    }
}

fn valid_usage(usage: u32) -> bool {
    matches!(
        usage,
        glow::STATIC_DRAW
            | glow::DYNAMIC_DRAW
            | glow::STREAM_DRAW
            | glow::STATIC_READ
            | glow::DYNAMIC_READ
            | glow::STREAM_READ
            | glow::STATIC_COPY
            | glow::DYNAMIC_COPY
            | glow::STREAM_COPY
    )
}

fn allocation_size(size: f64) -> Result<i32, u32> {
    if !size.is_finite() || size < 0.0 || size.fract() != 0.0 {
        return Err(glow::INVALID_VALUE);
    }
    if size > MAX_BUFFER_BYTES as f64 {
        return Err(glow::OUT_OF_MEMORY);
    }
    Ok(size as i32)
}

fn pointer_offset(offset: f64) -> Result<i32, u32> {
    if !offset.is_finite() || offset < 0.0 || offset.fract() != 0.0 || offset > i32::MAX as f64 {
        return Err(glow::INVALID_VALUE);
    }
    Ok(offset as i32)
}

fn byte_range(offset: i32, length: usize, capacity: i32) -> Result<(), u32> {
    let offset = usize::try_from(offset).map_err(|_| glow::INVALID_VALUE)?;
    let capacity = usize::try_from(capacity).map_err(|_| glow::INVALID_OPERATION)?;
    if offset.checked_add(length).is_none_or(|end| end > capacity) {
        return Err(glow::INVALID_OPERATION);
    }
    Ok(())
}

fn sub_data_range(offset: i32, length: usize, capacity: i32) -> Result<(), u32> {
    // WebGL reports writes outside an existing store as INVALID_VALUE; indexed
    // draw reads retain the separate INVALID_OPERATION mapping in byte_range.
    byte_range(offset, length, capacity).map_err(|_| glow::INVALID_VALUE)
}

fn bound_buffer_size(gl: &glow::Context, target: u32) -> Result<i32, u32> {
    let binding = binding_parameter(target)?;
    // Both admitted binding queries and BUFFER_SIZE have one scalar result.
    // Checking binding first prevents a missing-buffer query from adding errors.
    unsafe {
        if gl.get_parameter_i32(binding) == 0 {
            return Err(glow::INVALID_OPERATION);
        }
        let size = gl.get_buffer_parameter_i32(target, glow::BUFFER_SIZE);
        if size < 0 {
            return Err(glow::INVALID_OPERATION);
        }
        Ok(size)
    }
}

#[op2(fast)]
pub fn op_wgl_create_buffer(state: &mut OpState, context: u32) -> Result<u32, JsErrorBox> {
    let State {
        contexts, objects, ..
    } = state.borrow_mut::<State>();
    let owner = contexts
        .get_mut(&context)
        .ok_or_else(|| failure("Unknown context"))?;
    owner.make_current().map_err(failure)?;
    // The current owner context owns the GL name, including insertion rollback.
    let value = unsafe { owner.gl.create_buffer() }.map_err(failure)?;
    match objects.insert(context, ResourceKind::Buffer, Object::Buffer(value)) {
        Ok(id) => Ok(id),
        Err(error) => {
            unsafe { owner.gl.delete_buffer(value) };
            Err(failure(error.to_string()))
        }
    }
}

#[op2(fast)]
pub fn op_wgl_bind_buffer(
    state: &mut OpState,
    context: u32,
    target: u32,
    id: u32,
) -> Result<u32, JsErrorBox> {
    if let Err(error) = binding_parameter(target) {
        return Ok(error);
    }
    let value = if id == 0 {
        None
    } else {
        Some(buffer(
            state
                .borrow::<State>()
                .objects
                .get(context, ResourceKind::Buffer, id)
                .map_err(|error| failure(error.to_string()))?,
        ))
    };
    let owner = current(state, context)?;
    // Non-null names were checked for kind, liveness and context ownership.
    unsafe { owner.gl.bind_buffer(target, value) };
    Ok(glow::NO_ERROR)
}

#[op2(fast)]
pub fn op_wgl_delete_buffer(state: &mut OpState, context: u32, id: u32) -> Result<(), JsErrorBox> {
    let State {
        contexts, objects, ..
    } = state.borrow_mut::<State>();
    let owner = contexts
        .get_mut(&context)
        .ok_or_else(|| failure("Unknown context"))?;
    owner.make_current().map_err(failure)?;
    if id == 0 {
        return Ok(());
    }
    let value = buffer(
        &objects
            .remove(context, ResourceKind::Buffer, id)
            .map_err(|error| failure(error.to_string()))?,
    );
    unsafe { owner.gl.delete_buffer(value) };
    Ok(())
}

#[op2(fast)]
pub fn op_wgl_buffer_data_size(
    state: &mut OpState,
    context: u32,
    target: u32,
    size: f64,
    usage: u32,
) -> Result<u32, JsErrorBox> {
    let size = match allocation_size(size) {
        Ok(size) => size,
        Err(error) => return Ok(error),
    };
    if !valid_usage(usage) {
        return Ok(glow::INVALID_ENUM);
    }
    let owner = current(state, context)?;
    if let Err(error) = bound_buffer_size(&owner.gl, target) {
        return Ok(error);
    }
    // Null allocation uses the context's robust resource initialization.
    unsafe { owner.gl.buffer_data_size(target, size, usage) };
    Ok(glow::NO_ERROR)
}

#[op2(fast)]
pub fn op_wgl_buffer_data_bytes(
    state: &mut OpState,
    context: u32,
    target: u32,
    #[buffer] data: &[u8],
    usage: u32,
) -> Result<u32, JsErrorBox> {
    if data.len() > MAX_BUFFER_BYTES {
        return Ok(glow::OUT_OF_MEMORY);
    }
    if !valid_usage(usage) {
        return Ok(glow::INVALID_ENUM);
    }
    let owner = current(state, context)?;
    if let Err(error) = bound_buffer_size(&owner.gl, target) {
        return Ok(error);
    }
    // Glow passes this checked slice's own byte length; the borrow survives the
    // synchronous copy and cannot be reinterpreted as a pixel-buffer offset.
    unsafe { owner.gl.buffer_data_u8_slice(target, data, usage) };
    Ok(glow::NO_ERROR)
}

#[op2(fast)]
pub fn op_wgl_buffer_sub_data(
    state: &mut OpState,
    context: u32,
    target: u32,
    offset: f64,
    #[buffer] data: &[u8],
) -> Result<u32, JsErrorBox> {
    let offset = match pointer_offset(offset) {
        Ok(offset) => offset,
        Err(error) => return Ok(error),
    };
    let owner = current(state, context)?;
    let capacity = match bound_buffer_size(&owner.gl, target) {
        Ok(size) => size,
        Err(error) => return Ok(error),
    };
    if let Err(error) = sub_data_range(offset, data.len(), capacity) {
        return Ok(error);
    }
    // The actual bound store contains the complete write. The source pointer is
    // borrowed only for this call and glow uses its exact slice length.
    unsafe { owner.gl.buffer_sub_data_u8_slice(target, offset, data) };
    Ok(glow::NO_ERROR)
}

#[op2(fast)]
pub fn op_wgl_create_vertex_array(state: &mut OpState, context: u32) -> Result<u32, JsErrorBox> {
    let State {
        contexts, objects, ..
    } = state.borrow_mut::<State>();
    let owner = contexts
        .get_mut(&context)
        .ok_or_else(|| failure("Unknown context"))?;
    owner.make_current().map_err(failure)?;
    let value = unsafe { owner.gl.create_vertex_array() }.map_err(failure)?;
    match objects.insert(
        context,
        ResourceKind::VertexArray,
        Object::VertexArray(value),
    ) {
        Ok(id) => Ok(id),
        Err(error) => {
            unsafe { owner.gl.delete_vertex_array(value) };
            Err(failure(error.to_string()))
        }
    }
}

#[op2(fast)]
pub fn op_wgl_bind_vertex_array(
    state: &mut OpState,
    context: u32,
    id: u32,
) -> Result<(), JsErrorBox> {
    let value = if id == 0 {
        None
    } else {
        Some(vertex_array(
            state
                .borrow::<State>()
                .objects
                .get(context, ResourceKind::VertexArray, id)
                .map_err(|error| failure(error.to_string()))?,
        ))
    };
    let owner = current(state, context)?;
    unsafe { owner.gl.bind_vertex_array(value) };
    Ok(())
}

#[op2(fast)]
pub fn op_wgl_delete_vertex_array(
    state: &mut OpState,
    context: u32,
    id: u32,
) -> Result<(), JsErrorBox> {
    let State {
        contexts, objects, ..
    } = state.borrow_mut::<State>();
    let owner = contexts
        .get_mut(&context)
        .ok_or_else(|| failure("Unknown context"))?;
    owner.make_current().map_err(failure)?;
    if id == 0 {
        return Ok(());
    }
    let value = vertex_array(
        &objects
            .remove(context, ResourceKind::VertexArray, id)
            .map_err(|error| failure(error.to_string()))?,
    );
    unsafe { owner.gl.delete_vertex_array(value) };
    Ok(())
}

#[op2(fast)]
pub fn op_wgl_enable_vertex_attrib_array(
    state: &mut OpState,
    context: u32,
    index: u32,
) -> Result<(), JsErrorBox> {
    let owner = current(state, context)?;
    unsafe { owner.gl.enable_vertex_attrib_array(index) };
    Ok(())
}

#[op2(fast)]
pub fn op_wgl_disable_vertex_attrib_array(
    state: &mut OpState,
    context: u32,
    index: u32,
) -> Result<(), JsErrorBox> {
    let owner = current(state, context)?;
    unsafe { owner.gl.disable_vertex_attrib_array(index) };
    Ok(())
}

#[op2(fast)]
pub fn op_wgl_vertex_attrib_divisor(
    state: &mut OpState,
    context: u32,
    index: u32,
    divisor: u32,
) -> Result<(), JsErrorBox> {
    let owner = current(state, context)?;
    unsafe { owner.gl.vertex_attrib_divisor(index, divisor) };
    Ok(())
}

fn attribute_layout(size: i32, ty: u32, stride: i32, offset: f64) -> Result<i32, u32> {
    if !(1..=4).contains(&size) || !(0..=255).contains(&stride) {
        return Err(glow::INVALID_VALUE);
    }
    let component_bytes = match ty {
        glow::BYTE | glow::UNSIGNED_BYTE => 1,
        glow::SHORT | glow::UNSIGNED_SHORT | glow::HALF_FLOAT => 2,
        glow::INT | glow::UNSIGNED_INT | glow::FLOAT => 4,
        glow::INT_2_10_10_10_REV | glow::UNSIGNED_INT_2_10_10_10_REV => {
            if size != 4 {
                return Err(glow::INVALID_OPERATION);
            }
            4
        }
        _ => return Err(glow::INVALID_ENUM),
    };
    let offset = pointer_offset(offset)?;
    if offset % component_bytes != 0 || stride % component_bytes != 0 {
        return Err(glow::INVALID_OPERATION);
    }
    Ok(offset)
}

#[op2(fast)]
pub fn op_wgl_vertex_attrib_pointer(
    state: &mut OpState,
    context: u32,
    index: u32,
    size: i32,
    ty: u32,
    normalized: bool,
    stride: i32,
    offset: f64,
) -> Result<u32, JsErrorBox> {
    let offset = match attribute_layout(size, ty, stride, offset) {
        Ok(offset) => offset,
        Err(error) => return Ok(error),
    };
    let owner = current(state, context)?;
    if let Err(error) = bound_buffer_size(&owner.gl, glow::ARRAY_BUFFER) {
        return Ok(error);
    }
    // With a VBO bound, glow's pointer-shaped argument is a GPU-buffer offset,
    // never client memory. ANGLE checks attribute store bounds at draw time.
    unsafe {
        owner
            .gl
            .vertex_attrib_pointer_f32(index, size, ty, normalized, stride, offset);
    }
    Ok(glow::NO_ERROR)
}

fn valid_primitive(mode: u32) -> bool {
    matches!(
        mode,
        glow::POINTS
            | glow::LINES
            | glow::LINE_LOOP
            | glow::LINE_STRIP
            | glow::TRIANGLES
            | glow::TRIANGLE_STRIP
            | glow::TRIANGLE_FAN
    )
}

fn array_range(first: i32, count: i32) -> Result<(), u32> {
    if first < 0 || count < 0 {
        return Err(glow::INVALID_VALUE);
    }
    if count > 0 && first.checked_add(count - 1).is_none() {
        return Err(glow::INVALID_OPERATION);
    }
    Ok(())
}

fn index_range(count: i32, ty: u32, offset: f64, capacity: i32) -> Result<i32, u32> {
    let count = usize::try_from(count).map_err(|_| glow::INVALID_VALUE)?;
    let bytes = match ty {
        glow::UNSIGNED_BYTE => 1,
        glow::UNSIGNED_SHORT => 2,
        glow::UNSIGNED_INT => 4,
        _ => return Err(glow::INVALID_ENUM),
    };
    let offset = pointer_offset(offset)?;
    if !(offset as usize).is_multiple_of(bytes) {
        return Err(glow::INVALID_OPERATION);
    }
    let length = count.checked_mul(bytes).ok_or(glow::INVALID_OPERATION)?;
    byte_range(offset, length, capacity)?;
    Ok(offset)
}

#[op2(fast)]
pub fn op_wgl_draw_arrays(
    state: &mut OpState,
    context: u32,
    mode: u32,
    first: i32,
    count: i32,
) -> Result<u32, JsErrorBox> {
    if !valid_primitive(mode) {
        return Ok(glow::INVALID_ENUM);
    }
    if let Err(error) = array_range(first, count) {
        return Ok(error);
    }
    let owner = current(state, context)?;
    // ANGLE WebGL mode rejects enabled attributes without buffers and validates
    // vertex-fetch bounds. This call supplies no native client-memory pointer.
    unsafe { owner.gl.draw_arrays(mode, first, count) };
    Ok(glow::NO_ERROR)
}

#[op2(fast)]
pub fn op_wgl_draw_elements(
    state: &mut OpState,
    context: u32,
    mode: u32,
    count: i32,
    ty: u32,
    offset: f64,
) -> Result<u32, JsErrorBox> {
    if !valid_primitive(mode) {
        return Ok(glow::INVALID_ENUM);
    }
    let owner = current(state, context)?;
    let capacity = match bound_buffer_size(&owner.gl, glow::ELEMENT_ARRAY_BUFFER) {
        Ok(size) => size,
        Err(error) => return Ok(error),
    };
    let offset = match index_range(count, ty, offset, capacity) {
        Ok(offset) => offset,
        Err(error) => return Ok(error),
    };
    // A live EBO and its checked byte range make the pointer-shaped argument an
    // offset. ANGLE separately validates the decoded indices against each VBO.
    unsafe { owner.gl.draw_elements(mode, count, ty, offset) };
    Ok(glow::NO_ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocations_reject_nonintegers_and_limit_before_native_narrowing() {
        for value in [-1.0, f64::NAN, f64::INFINITY, 1.5] {
            assert_eq!(allocation_size(value), Err(glow::INVALID_VALUE));
        }
        assert_eq!(allocation_size(0.0), Ok(0));
        assert_eq!(
            allocation_size(MAX_BUFFER_BYTES as f64),
            Ok(MAX_BUFFER_BYTES as i32)
        );
        assert_eq!(
            allocation_size(MAX_BUFFER_BYTES as f64 + 1.0),
            Err(glow::OUT_OF_MEMORY)
        );
        assert_eq!(allocation_size(u64::MAX as f64), Err(glow::OUT_OF_MEMORY));
        assert_eq!(pointer_offset(i32::MAX as f64), Ok(i32::MAX));
        assert_eq!(
            pointer_offset(i32::MAX as f64 + 1.0),
            Err(glow::INVALID_VALUE)
        );
    }

    #[test]
    fn byte_bounds_allow_empty_end_and_reject_overflow() {
        assert_eq!(byte_range(8, 4, 12), Ok(()));
        assert_eq!(byte_range(12, 0, 12), Ok(()));
        assert_eq!(byte_range(12, 1, 12), Err(glow::INVALID_OPERATION));
        assert_eq!(byte_range(13, 0, 12), Err(glow::INVALID_OPERATION));
        assert_eq!(byte_range(1, usize::MAX, 12), Err(glow::INVALID_OPERATION));
        assert_eq!(byte_range(-1, 0, 12), Err(glow::INVALID_VALUE));
        assert_eq!(byte_range(0, 0, -1), Err(glow::INVALID_OPERATION));
    }

    #[test]
    fn subdata_overruns_are_invalid_value_but_index_overruns_are_invalid_operation() {
        assert_eq!(sub_data_range(2, 4, 6), Ok(()));
        assert_eq!(sub_data_range(6, 0, 6), Ok(()));
        assert_eq!(sub_data_range(2, 4, 5), Err(glow::INVALID_VALUE));
        assert_eq!(sub_data_range(7, 0, 6), Err(glow::INVALID_VALUE));
        assert_eq!(sub_data_range(1, usize::MAX, 6), Err(glow::INVALID_VALUE));
        assert_eq!(sub_data_range(-1, 0, 6), Err(glow::INVALID_VALUE));
        assert_eq!(index_range(2, glow::UNSIGNED_SHORT, 2.0, 6), Ok(2));
        assert_eq!(
            index_range(2, glow::UNSIGNED_SHORT, 2.0, 5),
            Err(glow::INVALID_OPERATION)
        );
    }

    #[test]
    fn attribute_offsets_and_strides_preserve_element_alignment() {
        assert_eq!(attribute_layout(3, glow::FLOAT, 12, 24.0), Ok(24));
        assert_eq!(attribute_layout(4, glow::UNSIGNED_BYTE, 255, 1.0), Ok(1));
        assert_eq!(
            attribute_layout(3, glow::FLOAT, 12, 2.0),
            Err(glow::INVALID_OPERATION)
        );
        assert_eq!(
            attribute_layout(3, glow::FLOAT, 10, 0.0),
            Err(glow::INVALID_OPERATION)
        );
        assert_eq!(
            attribute_layout(3, glow::FLOAT, 256, 0.0),
            Err(glow::INVALID_VALUE)
        );
        assert_eq!(
            attribute_layout(0, glow::FLOAT, 0, 0.0),
            Err(glow::INVALID_VALUE)
        );
        assert_eq!(
            attribute_layout(4, glow::UNSIGNED_INT_2_10_10_10_REV, 4, 0.0),
            Ok(0)
        );
        assert_eq!(
            attribute_layout(3, glow::UNSIGNED_INT_2_10_10_10_REV, 4, 0.0),
            Err(glow::INVALID_OPERATION)
        );
        assert_eq!(
            attribute_layout(3, glow::DOUBLE, 0, 0.0),
            Err(glow::INVALID_ENUM)
        );
    }

    #[test]
    fn indexed_ranges_cover_u8_u16_u32_and_reject_short_stores() {
        assert_eq!(index_range(3, glow::UNSIGNED_BYTE, 1.0, 4), Ok(1));
        assert_eq!(index_range(3, glow::UNSIGNED_SHORT, 2.0, 8), Ok(2));
        assert_eq!(index_range(3, glow::UNSIGNED_INT, 4.0, 16), Ok(4));
        assert_eq!(
            index_range(3, glow::UNSIGNED_INT, 4.0, 15),
            Err(glow::INVALID_OPERATION)
        );
        assert_eq!(
            index_range(1, glow::UNSIGNED_SHORT, 1.0, 8),
            Err(glow::INVALID_OPERATION)
        );
        assert_eq!(
            index_range(-1, glow::UNSIGNED_INT, 0.0, 16),
            Err(glow::INVALID_VALUE)
        );
        assert_eq!(
            index_range(1, glow::FLOAT, 0.0, 16),
            Err(glow::INVALID_ENUM)
        );
        assert_eq!(
            index_range(i32::MAX, glow::UNSIGNED_INT, 0.0, MAX_BUFFER_BYTES as i32),
            Err(glow::INVALID_OPERATION)
        );
        assert_eq!(index_range(0, glow::UNSIGNED_SHORT, 8.0, 8), Ok(8));
    }

    #[test]
    fn array_ranges_preserve_last_valid_vertex_without_wrapping() {
        assert_eq!(array_range(0, 3), Ok(()));
        assert_eq!(array_range(i32::MAX, 0), Ok(()));
        assert_eq!(array_range(i32::MAX, 1), Ok(()));
        assert_eq!(array_range(i32::MAX, 2), Err(glow::INVALID_OPERATION));
        assert_eq!(array_range(-1, 0), Err(glow::INVALID_VALUE));
        assert_eq!(array_range(0, -1), Err(glow::INVALID_VALUE));
    }

    #[test]
    fn buffer_targets_exclude_pointer_reinterpreting_pixel_bindings() {
        assert_eq!(
            binding_parameter(glow::ARRAY_BUFFER),
            Ok(glow::ARRAY_BUFFER_BINDING)
        );
        assert_eq!(
            binding_parameter(glow::ELEMENT_ARRAY_BUFFER),
            Ok(glow::ELEMENT_ARRAY_BUFFER_BINDING)
        );
        for target in [
            glow::PIXEL_PACK_BUFFER,
            glow::PIXEL_UNPACK_BUFFER,
            glow::COPY_READ_BUFFER,
            u32::MAX,
        ] {
            assert_eq!(binding_parameter(target), Err(glow::INVALID_ENUM));
        }
    }
}
