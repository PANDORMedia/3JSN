use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_metal::MTLTexture;
use std::{
    ffi::{CStr, CString, c_char, c_void},
    path::Path,
    ptr::NonNull,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
#[repr(C)]
struct Bridge {
    _opaque: [u8; 0],
}
unsafe extern "C" {
    fn bridge_error() -> *const c_char;
    fn bridge_create(path: *const c_char, width: u32, height: u32) -> *mut Bridge;
    fn bridge_device(bridge: *mut Bridge) -> *mut c_void;
    fn bridge_texture(bridge: *mut Bridge) -> *mut c_void;
    fn bridge_renderer(bridge: *mut Bridge) -> *const c_char;
    fn bridge_version(bridge: *mut Bridge) -> *const c_char;
    fn bridge_render(bridge: *mut Bridge, frame: u32) -> i32;
    fn bridge_queue_event(bridge: *mut Bridge, queue: *mut c_void, frame: u32, wait: bool) -> i32;
    fn bridge_finish(bridge: *mut Bridge, frames: u32) -> i32;
    fn bridge_destroy(bridge: *mut Bridge);
}

pub struct Native {
    raw: NonNull<Bridge>,
}
fn error() -> Box<dyn std::error::Error> {
    // The bridge retains this thread-local, NUL-terminated error until its next operation.
    unsafe { CStr::from_ptr(bridge_error()) }
        .to_string_lossy()
        .into_owned()
        .into()
}
fn checked(ok: i32) -> Result<()> {
    if ok == 1 { Ok(()) } else { Err(error()) }
}
impl Native {
    pub fn new(path: &Path, width: u32, height: u32) -> Result<Self> {
        let path = CString::new(path.to_str().ok_or("ANGLE path must be UTF-8")?)?;
        // The bridge copies path-dependent state and owns every returned native resource.
        let raw = NonNull::new(unsafe { bridge_create(path.as_ptr(), width, height) })
            .ok_or_else(error)?;
        Ok(Self { raw })
    }
    pub fn device(&self) -> *const c_void {
        // Borrowed identity only; Native retains the device for this call's lifetime.
        unsafe { bridge_device(self.raw.as_ptr()).cast_const() }
    }
    pub fn texture(&self) -> Retained<ProtocolObject<dyn MTLTexture>> {
        // The bridge creates an MTLTexture and retains it; retain adds Rust's separate ownership.
        unsafe {
            Retained::retain(bridge_texture(self.raw.as_ptr()).cast()).expect("bridge texture")
        }
    }
    pub fn renderer(&self) -> String {
        // The strings are stable until Native is dropped, and copied before returning.
        unsafe { CStr::from_ptr(bridge_renderer(self.raw.as_ptr())) }
            .to_string_lossy()
            .into_owned()
    }
    pub fn version(&self) -> String {
        // The bridge owns this NUL-terminated string until Native is dropped.
        unsafe { CStr::from_ptr(bridge_version(self.raw.as_ptr())) }
            .to_string_lossy()
            .into_owned()
    }
    pub fn render(&mut self, frame: u32) -> Result<()> {
        // Single-threaded caller serializes EGL access and monotonically advances frame events.
        checked(unsafe { bridge_render(self.raw.as_ptr(), frame) })
    }
    pub fn queue_event(&mut self, queue: &wgpu::Queue, frame: u32, wait: bool) -> Result<()> {
        // Neither this method nor the bridge destroys the borrowed HAL queue. No concurrent
        // submission or unsubmitted wgpu command buffer is permitted at either handoff boundary.
        let hal =
            unsafe { queue.as_hal::<wgpu_hal::api::Metal>() }.ok_or("Expected Metal queue")?;
        let raw = hal.as_raw() as *const _ as *mut c_void;
        checked(unsafe { bridge_queue_event(self.raw.as_ptr(), raw, frame, wait) })
    }
    pub fn finish(&mut self, frames: u32) -> Result<()> {
        // Called after all queue submissions; waits only to validate and safely release resources.
        checked(unsafe { bridge_finish(self.raw.as_ptr(), frames) })
    }
}
impl Drop for Native {
    fn drop(&mut self) {
        // Owning pointer is unique. The bridge waits for its last consumer signal before teardown.
        unsafe { bridge_destroy(self.raw.as_ptr()) };
    }
}
