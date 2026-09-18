use std::{
    ffi::{CStr, CString, c_char, c_void},
    marker::PhantomData,
    path::Path,
    ptr::NonNull,
    rc::Rc,
};

unsafe extern "C" {
    fn angle_display_create(path: *const c_char) -> *mut c_void;
    fn angle_display_destroy(display: *mut c_void);
    fn angle_context_create(display: *mut c_void, width: u32, height: u32) -> *mut c_void;
    fn angle_context_destroy(context: *mut c_void);
    fn angle_context_make_current(context: *mut c_void) -> i32;
    fn angle_context_resize(context: *mut c_void, width: u32, height: u32) -> i32;
    fn angle_get_proc(display: *mut c_void, name: *const c_char) -> *const c_void;
    fn angle_error() -> *const c_char;
}

pub(super) fn error() -> String {
    // Native errors are thread-local, NUL-terminated and copied before another call.
    unsafe { CStr::from_ptr(angle_error()) }
        .to_string_lossy()
        .into_owned()
}

pub struct Display {
    raw: NonNull<c_void>,
    _thread: PhantomData<Rc<()>>,
}

impl Display {
    pub fn new(path: &Path) -> Result<Rc<Self>, String> {
        let path = CString::new(path.to_str().ok_or("ANGLE path must be UTF-8")?)
            .map_err(|e| e.to_string())?;
        // The native display copies the path and owns its EGL/module lease.
        let raw = NonNull::new(unsafe { angle_display_create(path.as_ptr()) }).ok_or_else(error)?;
        Ok(Rc::new(Self {
            raw,
            _thread: PhantomData,
        }))
    }
}

impl Drop for Display {
    fn drop(&mut self) {
        // Rc and the thread marker prevent transfer; the raw owner is unique.
        unsafe { angle_display_destroy(self.raw.as_ptr()) };
        let message = error();
        if !message.is_empty() {
            eprintln!("ANGLE display teardown failed; native owner retained: {message}");
        }
    }
}

pub(super) struct ContextOwner {
    raw: Option<NonNull<c_void>>,
    _display: Rc<Display>,
}

pub struct Context {
    pub gl: glow::Context,
    native: Rc<ContextOwner>,
    size: (u32, u32),
}

impl Context {
    pub fn new(display: Rc<Display>, width: u32, height: u32) -> Result<Self, String> {
        // Every context retains its display and is accessed only on the owner thread.
        let raw =
            NonNull::new(unsafe { angle_context_create(display.raw.as_ptr(), width, height) })
                .ok_or_else(error)?;
        let native = ContextOwner {
            raw: Some(raw),
            _display: display,
        };
        if unsafe { angle_context_make_current(native.raw.expect("live context").as_ptr()) } != 1 {
            return Err(error());
        }
        // ANGLE supplies the GLES function table while this context is current.
        let gl = unsafe {
            glow::Context::from_loader_function(|name| {
                let name = CString::new(name).expect("static GLES function name");
                angle_get_proc(native._display.raw.as_ptr(), name.as_ptr())
            })
        };
        Ok(Self {
            gl,
            native: Rc::new(native),
            size: (width, height),
        })
    }

    pub fn make_current(&self) -> Result<(), String> {
        if unsafe { angle_context_make_current(self.native.raw()?) } == 1 {
            Ok(())
        } else {
            Err(error())
        }
    }

    pub fn close(&mut self) -> Result<(), String> {
        Rc::get_mut(&mut self.native)
            .ok_or("Cannot close a context with live snapshots")?
            .close()
    }

    pub fn snapshot(&self) -> Result<crate::Snapshot, String> {
        crate::Snapshot::new(self.native.clone(), self.size)
    }

    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), String> {
        if unsafe { angle_context_resize(self.native.raw()?, width, height) } == 1 {
            self.size = (width, height);
            Ok(())
        } else {
            Err(error())
        }
    }
}

impl ContextOwner {
    pub(super) fn raw(&self) -> Result<*mut c_void, String> {
        self.raw
            .map(NonNull::as_ptr)
            .ok_or_else(|| "Context is closed".into())
    }

    fn close(&mut self) -> Result<(), String> {
        if let Some(raw) = self.raw {
            // Rejected native destruction retains the handle for an explicit retry.
            unsafe { angle_context_destroy(raw.as_ptr()) };
            let message = error();
            if !message.is_empty() {
                return Err(message);
            }
            self.raw = None;
        }
        Ok(())
    }
}

impl Drop for ContextOwner {
    fn drop(&mut self) {
        if let Err(message) = self.close() {
            eprintln!("ANGLE context teardown failed; native owner retained: {message}");
        }
    }
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;
    use glow::HasContext;

    #[test]
    #[ignore = "Requires ANGLE_LIBRARY_DIR and native Metal hardware"]
    fn snapshot_preserves_application_bindings_and_errors() -> Result<(), String> {
        let directory = std::env::var("ANGLE_LIBRARY_DIR").map_err(|e| e.to_string())?;
        let display = Display::new(Path::new(&directory))?;
        let mut context = Context::new(display, 8, 6)?;
        let gl = &context.gl;
        // These objects belong only to this live owner-thread context. Incomplete
        // application FBOs are intentional: export must read the default instead.
        unsafe {
            let read = gl.create_framebuffer()?;
            let draw = gl.create_framebuffer()?;
            let texture = gl.create_texture()?;
            gl.bind_framebuffer(glow::READ_FRAMEBUFFER, None);
            gl.read_buffer(glow::NONE);
            gl.draw_buffers(&[glow::NONE]);
            gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(read));
            gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(draw));
            gl.active_texture(glow::TEXTURE3);
            gl.bind_texture(glow::TEXTURE_2D, Some(texture));
            gl.enable(glow::SCISSOR_TEST);
            gl.scissor(1, 2, 3, 4);
            gl.color_mask(false, true, false, true);
            gl.clear_color(0.25, 0.5, 0.75, 1.0);
            assert_eq!(gl.get_error(), glow::NO_ERROR);
            gl.enable(u32::MAX);
            context.resize(10, 8)?;
            let gl = &context.gl;
            let mut lease = context.snapshot()?;
            let first = lease.publish()?;
            assert!(lease.publish().unwrap_err().contains("leased"));
            lease.drain(5_000_000_000)?;
            assert!(lease.publish()? > first);
            lease.drain(5_000_000_000)?;
            lease.close()?;
            assert_eq!(gl.get_error(), glow::INVALID_ENUM);
            assert_eq!(gl.get_error(), glow::NO_ERROR);
            assert_eq!(
                gl.get_parameter_i32(glow::READ_FRAMEBUFFER_BINDING) as u32,
                read.0.get()
            );
            assert_eq!(
                gl.get_parameter_i32(glow::DRAW_FRAMEBUFFER_BINDING) as u32,
                draw.0.get()
            );
            assert_eq!(
                gl.get_parameter_i32(glow::ACTIVE_TEXTURE) as u32,
                glow::TEXTURE3
            );
            assert_eq!(
                gl.get_parameter_i32(glow::TEXTURE_BINDING_2D) as u32,
                texture.0.get()
            );
            let mut color_mask = [0; 4];
            gl.get_parameter_i32_slice(glow::COLOR_WRITEMASK, &mut color_mask);
            assert_eq!(color_mask, [0, 1, 0, 1]);
            let mut clear_color = [0.0; 4];
            gl.get_parameter_f32_slice(glow::COLOR_CLEAR_VALUE, &mut clear_color);
            assert_eq!(clear_color, [0.25, 0.5, 0.75, 1.0]);
            assert!(gl.is_enabled(glow::SCISSOR_TEST));
            let mut scissor = [0; 4];
            gl.get_parameter_i32_slice(glow::SCISSOR_BOX, &mut scissor);
            assert_eq!(scissor, [1, 2, 3, 4]);
            gl.bind_framebuffer(glow::READ_FRAMEBUFFER, None);
            assert_eq!(gl.get_parameter_i32(glow::READ_BUFFER) as u32, glow::NONE);
            gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, None);
            assert_eq!(gl.get_parameter_i32(glow::DRAW_BUFFER0) as u32, glow::NONE);
            gl.delete_framebuffer(read);
            gl.delete_framebuffer(draw);
            gl.delete_texture(texture);
            assert_eq!(gl.get_error(), glow::NO_ERROR);
        }
        context.close()
    }
}
