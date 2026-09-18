//! Bounded texture initialization and framebuffer ownership for the WebGL facade.
//! Uploads accept null or RGBA/UNSIGNED_BYTE bytes with default unpack state.
//! Validation returns GL error codes without draining ANGLE's existing error queue.

use deno_core::{OpState, op2};
use deno_error::JsErrorBox;
use glow::HasContext;

use crate::{State, current, failure, resources::ResourceKind, shaders::Object};

const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;

fn texture(object: &Object) -> glow::NativeTexture {
    match object {
        Object::Texture(value) => *value,
        _ => unreachable!("registry kind invariant"),
    }
}

fn framebuffer(object: &Object) -> glow::NativeFramebuffer {
    match object {
        Object::Framebuffer(value) => *value,
        _ => unreachable!("registry kind invariant"),
    }
}

#[op2(fast)]
pub fn op_gl_create_texture(state: &mut OpState, context: u32) -> Result<u32, JsErrorBox> {
    let State {
        contexts, objects, ..
    } = state.borrow_mut::<State>();
    let owner = contexts
        .get_mut(&context)
        .ok_or_else(|| failure("Unknown context"))?;
    owner.make_current().map_err(failure)?;
    // The current owner context owns the GL name, including insertion rollback.
    let value = unsafe { owner.gl.create_texture() }.map_err(failure)?;
    match objects.insert(context, ResourceKind::Texture, Object::Texture(value)) {
        Ok(id) => Ok(id),
        Err(error) => {
            unsafe { owner.gl.delete_texture(value) };
            Err(failure(error.to_string()))
        }
    }
}

#[op2(fast)]
pub fn op_gl_bind_texture(
    state: &mut OpState,
    context: u32,
    target: u32,
    id: u32,
) -> Result<(), JsErrorBox> {
    let value = if id == 0 {
        None
    } else {
        Some(texture(
            state
                .borrow::<State>()
                .objects
                .get(context, ResourceKind::Texture, id)
                .map_err(|error| failure(error.to_string()))?,
        ))
    };
    let owner = current(state, context)?;
    // Non-null names were checked for kind, liveness and context ownership.
    unsafe { owner.gl.bind_texture(target, value) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_delete_texture(state: &mut OpState, context: u32, id: u32) -> Result<(), JsErrorBox> {
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
    let value = texture(
        &objects
            .remove(context, ResourceKind::Texture, id)
            .map_err(|error| failure(error.to_string()))?,
    );
    // Removing the unique registry entry prevents reuse of this JS identity.
    unsafe { owner.gl.delete_texture(value) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_tex_parameteri(
    state: &mut OpState,
    context: u32,
    target: u32,
    pname: u32,
    param: i32,
) -> Result<(), JsErrorBox> {
    let owner = current(state, context)?;
    // Only scalar arguments cross this boundary; ANGLE validates GL state/enums.
    unsafe { owner.gl.tex_parameter_i32(target, pname, param) };
    Ok(())
}

fn rgba8_bytes(width: i32, height: i32, depth: i32) -> Result<usize, u32> {
    let width = usize::try_from(width).map_err(|_| glow::INVALID_VALUE)?;
    let height = usize::try_from(height).map_err(|_| glow::INVALID_VALUE)?;
    let depth = usize::try_from(depth).map_err(|_| glow::INVALID_VALUE)?;
    // Four-byte pixels already satisfy the only admitted unpack alignment (4).
    let bytes = width
        .checked_mul(4)
        .and_then(|row| row.checked_mul(height))
        .and_then(|image| image.checked_mul(depth))
        .ok_or(glow::OUT_OF_MEMORY)?;
    if bytes > MAX_IMAGE_BYTES {
        return Err(glow::OUT_OF_MEMORY);
    }
    Ok(bytes)
}

fn validate_image(
    dimensions: [i32; 3],
    level: i32,
    border: i32,
    internal_format: i32,
    format: u32,
    ty: u32,
    data_len: Option<usize>,
) -> Result<(), u32> {
    if level < 0 || border != 0 {
        return Err(glow::INVALID_VALUE);
    }
    if format != glow::RGBA
        || ty != glow::UNSIGNED_BYTE
        || ![glow::RGBA as i32, glow::RGBA8 as i32].contains(&internal_format)
    {
        return Err(glow::INVALID_ENUM);
    }
    let required = rgba8_bytes(dimensions[0], dimensions[1], dimensions[2])?;
    if data_len.is_some_and(|len| len < required) {
        return Err(glow::INVALID_OPERATION);
    }
    Ok(())
}

const DEFAULT_UNPACK: [(u32, i32); 7] = [
    (glow::PIXEL_UNPACK_BUFFER_BINDING, 0),
    (glow::UNPACK_ALIGNMENT, 4),
    (glow::UNPACK_ROW_LENGTH, 0),
    (glow::UNPACK_IMAGE_HEIGHT, 0),
    (glow::UNPACK_SKIP_PIXELS, 0),
    (glow::UNPACK_SKIP_ROWS, 0),
    (glow::UNPACK_SKIP_IMAGES, 0),
];

fn default_unpack(gl: &glow::Context) -> bool {
    // GLES 3 exposes these scalar queries. A PBO would reinterpret even null as
    // an offset; row/image/skip state could read beyond the checked slice.
    DEFAULT_UNPACK
        .iter()
        .all(|&(name, expected)| unsafe { gl.get_parameter_i32(name) } == expected)
}

#[op2]
pub fn op_gl_tex_image_2d(
    state: &mut OpState,
    context: u32,
    target: u32,
    level: i32,
    internal_format: i32,
    width: i32,
    height: i32,
    border: i32,
    format: u32,
    ty: u32,
    #[buffer] data: Option<&[u8]>,
) -> Result<u32, JsErrorBox> {
    if target != glow::TEXTURE_2D
        && !(glow::TEXTURE_CUBE_MAP_POSITIVE_X..=glow::TEXTURE_CUBE_MAP_NEGATIVE_Z)
            .contains(&target)
    {
        return Ok(glow::INVALID_ENUM);
    }
    if let Err(error) = validate_image(
        [width, height, 1],
        level,
        border,
        internal_format,
        format,
        ty,
        data.map(<[u8]>::len),
    ) {
        return Ok(error);
    }
    let owner = current(state, context)?;
    if !default_unpack(&owner.gl) {
        return Ok(glow::INVALID_OPERATION);
    }
    // The borrowed slice remains live for the synchronous call. Its byte extent
    // covers every admitted unpack address; null requests robust initialization.
    unsafe {
        owner.gl.tex_image_2d(
            target,
            level,
            internal_format,
            width,
            height,
            border,
            format,
            ty,
            glow::PixelUnpackData::Slice(data),
        );
    }
    Ok(glow::NO_ERROR)
}

#[op2]
pub fn op_gl_tex_image_3d(
    state: &mut OpState,
    context: u32,
    target: u32,
    level: i32,
    internal_format: i32,
    width: i32,
    height: i32,
    depth: i32,
    border: i32,
    format: u32,
    ty: u32,
    #[buffer] data: Option<&[u8]>,
) -> Result<u32, JsErrorBox> {
    if ![glow::TEXTURE_3D, glow::TEXTURE_2D_ARRAY].contains(&target) {
        return Ok(glow::INVALID_ENUM);
    }
    if let Err(error) = validate_image(
        [width, height, depth],
        level,
        border,
        internal_format,
        format,
        ty,
        data.map(<[u8]>::len),
    ) {
        return Ok(error);
    }
    let owner = current(state, context)?;
    if !default_unpack(&owner.gl) {
        return Ok(glow::INVALID_OPERATION);
    }
    // The checked size includes every depth slice and default-aligned row. No
    // pointer or pixel-buffer offset is supplied by the JS caller.
    unsafe {
        owner.gl.tex_image_3d(
            target,
            level,
            internal_format,
            width,
            height,
            depth,
            border,
            format,
            ty,
            glow::PixelUnpackData::Slice(data),
        );
    }
    Ok(glow::NO_ERROR)
}

#[op2(fast)]
pub fn op_gl_create_framebuffer(state: &mut OpState, context: u32) -> Result<u32, JsErrorBox> {
    let State {
        contexts, objects, ..
    } = state.borrow_mut::<State>();
    let owner = contexts
        .get_mut(&context)
        .ok_or_else(|| failure("Unknown context"))?;
    owner.make_current().map_err(failure)?;
    let value = unsafe { owner.gl.create_framebuffer() }.map_err(failure)?;
    match objects.insert(
        context,
        ResourceKind::Framebuffer,
        Object::Framebuffer(value),
    ) {
        Ok(id) => Ok(id),
        Err(error) => {
            unsafe { owner.gl.delete_framebuffer(value) };
            Err(failure(error.to_string()))
        }
    }
}

#[op2(fast)]
pub fn op_gl_bind_framebuffer(
    state: &mut OpState,
    context: u32,
    target: u32,
    id: u32,
) -> Result<(), JsErrorBox> {
    let value = if id == 0 {
        None
    } else {
        Some(framebuffer(
            state
                .borrow::<State>()
                .objects
                .get(context, ResourceKind::Framebuffer, id)
                .map_err(|error| failure(error.to_string()))?,
        ))
    };
    let owner = current(state, context)?;
    unsafe { owner.gl.bind_framebuffer(target, value) };
    Ok(())
}

#[op2(fast)]
pub fn op_gl_delete_framebuffer(
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
    let value = framebuffer(
        &objects
            .remove(context, ResourceKind::Framebuffer, id)
            .map_err(|error| failure(error.to_string()))?,
    );
    unsafe { owner.gl.delete_framebuffer(value) };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validate(dimensions: [i32; 3], length: Option<usize>) -> Result<(), u32> {
        validate_image(
            dimensions,
            0,
            0,
            glow::RGBA as i32,
            glow::RGBA,
            glow::UNSIGNED_BYTE,
            length,
        )
    }

    #[test]
    fn upload_bounds_cover_rows_depth_and_view_length() {
        assert_eq!(validate([1, 1, 1], Some(4)), Ok(()));
        assert_eq!(validate([3, 2, 4], Some(96)), Ok(()));
        assert_eq!(validate([3, 2, 4], Some(95)), Err(glow::INVALID_OPERATION));
        assert_eq!(validate([3, 2, 4], Some(100)), Ok(()));
        assert_eq!(validate([1, 1, 1], Some(3)), Err(glow::INVALID_OPERATION));
        assert_eq!(validate([0, 2, 4], Some(0)), Ok(()));
        assert_eq!(validate([3, 0, 4], Some(0)), Ok(()));
        assert_eq!(validate([3, 2, 0], Some(0)), Ok(()));
    }

    #[test]
    fn null_storage_and_uploads_share_checked_allocation_limit() {
        assert_eq!(validate([1, 1, 1], None), Ok(()));
        assert_eq!(validate([4096, 4096, 1], None), Ok(()));
        assert_eq!(validate([4096, 4096, 2], None), Err(glow::OUT_OF_MEMORY));
        assert_eq!(
            validate([i32::MAX, i32::MAX, i32::MAX], Some(usize::MAX)),
            Err(glow::OUT_OF_MEMORY)
        );
        for dimensions in [[-1, 1, 1], [1, -1, 1], [1, 1, -1]] {
            assert_eq!(validate(dimensions, None), Err(glow::INVALID_VALUE));
        }
    }

    #[test]
    fn unsupported_formats_and_invalid_scalar_arguments_never_reach_gl() {
        for (internal, format, ty, level, border, expected) in [
            (
                glow::RGBA8 as i32,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                0,
                0,
                Ok(()),
            ),
            (
                glow::RGB as i32,
                glow::RGB,
                glow::UNSIGNED_BYTE,
                0,
                0,
                Err(glow::INVALID_ENUM),
            ),
            (
                glow::RGBA as i32,
                glow::RGBA,
                glow::FLOAT,
                0,
                0,
                Err(glow::INVALID_ENUM),
            ),
            (
                glow::RGBA as i32,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                -1,
                0,
                Err(glow::INVALID_VALUE),
            ),
            (
                glow::RGBA as i32,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                0,
                1,
                Err(glow::INVALID_VALUE),
            ),
        ] {
            assert_eq!(
                validate_image([1, 1, 1], level, border, internal, format, ty, Some(4)),
                expected
            );
        }
    }
}
