//! Bounded current read-framebuffer readback for the partial WebGL facade.
//! Only RGBA/UNSIGNED_BYTE into a caller-owned Uint8Array is admitted.

use deno_core::{OpState, op2};
use deno_error::JsErrorBox;
use glow::HasContext;

use crate::State;

const MAX_READBACK_BYTES: usize = 64 * 1024 * 1024;

fn readback_size(width: i32, height: i32) -> Result<usize, u32> {
    let width = usize::try_from(width).map_err(|_| glow::INVALID_VALUE)?;
    let height = usize::try_from(height).map_err(|_| glow::INVALID_VALUE)?;
    let bytes = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or(glow::OUT_OF_MEMORY)?;
    if bytes > MAX_READBACK_BYTES {
        return Err(glow::OUT_OF_MEMORY);
    }
    Ok(bytes)
}

fn default_pack(gl: &glow::Context) -> bool {
    // The facade does not expose pixelStorei or pixel-pack buffers. Verify the
    // assumptions before passing a Rust slice to ANGLE's synchronous readback.
    [
        (glow::PIXEL_PACK_BUFFER_BINDING, 0),
        (glow::PACK_ALIGNMENT, 4),
        (glow::PACK_ROW_LENGTH, 0),
        (glow::PACK_SKIP_PIXELS, 0),
        (glow::PACK_SKIP_ROWS, 0),
    ]
    .into_iter()
    .all(|(name, expected)| unsafe { gl.get_parameter_i32(name) } == expected)
}

#[op2(fast)]
pub fn op_gl_read_pixels(
    state: &mut OpState,
    context: u32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    format: u32,
    ty: u32,
    #[buffer] output: &mut [u8],
) -> Result<u32, JsErrorBox> {
    if format != glow::RGBA || ty != glow::UNSIGNED_BYTE {
        return Ok(glow::INVALID_ENUM);
    }
    let required = match readback_size(width, height) {
        Ok(required) => required,
        Err(error) => return Ok(error),
    };
    if output.len() < required {
        return Ok(glow::INVALID_OPERATION);
    }

    let owner = state
        .borrow_mut::<State>()
        .contexts
        .get_mut(&context)
        .ok_or_else(|| JsErrorBox::type_error("Unknown or disposed ANGLE context"))?;
    owner
        .make_current()
        .map_err(|error| JsErrorBox::generic(error.to_string()))?;
    if !default_pack(&owner.gl) {
        return Ok(glow::INVALID_OPERATION);
    }

    // The checked byte length covers every addressed pixel with default pack
    // state. GL clips coordinates outside the framebuffer as specified.
    unsafe {
        owner.gl.read_pixels(
            x,
            y,
            width,
            height,
            format,
            ty,
            glow::PixelPackData::Slice(Some(&mut output[..required])),
        );
    }
    // Do not drain ANGLE's error queue: getError preserves ordering with errors
    // produced by other context operations.
    Ok(glow::NO_ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_rgba8_extents_and_rejects_negative_or_huge_reads() {
        assert_eq!(readback_size(1, 1), Ok(4));
        assert_eq!(readback_size(3, 2), Ok(24));
        assert_eq!(readback_size(0, 12), Ok(0));
        assert_eq!(readback_size(4096, 4096), Ok(MAX_READBACK_BYTES));
        assert_eq!(readback_size(4096, 4096 + 1), Err(glow::OUT_OF_MEMORY));
        assert_eq!(readback_size(-1, 1), Err(glow::INVALID_VALUE));
        assert_eq!(readback_size(1, -1), Err(glow::INVALID_VALUE));
        assert_eq!(readback_size(i32::MAX, i32::MAX), Err(glow::OUT_OF_MEMORY));
    }
}
