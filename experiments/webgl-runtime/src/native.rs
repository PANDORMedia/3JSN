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

fn error() -> String {
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

struct ContextOwner {
    raw: Option<NonNull<c_void>>,
    _display: Rc<Display>,
}

pub struct Context {
    pub gl: glow::Context,
    native: ContextOwner,
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
        Ok(Self { gl, native })
    }

    pub fn make_current(&self) -> Result<(), String> {
        if unsafe { angle_context_make_current(self.native.raw.expect("live context").as_ptr()) }
            == 1
        {
            Ok(())
        } else {
            Err(error())
        }
    }

    pub fn close(&mut self) -> Result<(), String> {
        self.native.close()
    }

    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), String> {
        if unsafe {
            angle_context_resize(
                self.native.raw.expect("live context").as_ptr(),
                width,
                height,
            )
        } == 1
        {
            Ok(())
        } else {
            Err(error())
        }
    }
}

impl ContextOwner {
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
