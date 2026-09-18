use std::{ffi::c_void, ptr::NonNull, rc::Rc};

use crate::native::{ContextOwner, error};

unsafe extern "C" {
    fn angle_snapshot_create(context: *mut c_void) -> *mut c_void;
    fn angle_snapshot_destroy(snapshot: *mut c_void) -> i32;
    fn angle_snapshot_device(snapshot: *mut c_void) -> *mut c_void;
    fn angle_snapshot_texture(snapshot: *mut c_void) -> *mut c_void;
    fn angle_snapshot_publish(snapshot: *mut c_void) -> u64;
    fn angle_snapshot_queue_wait(snapshot: *mut c_void, queue: *mut c_void, token: u64) -> i32;
    fn angle_snapshot_queue_signal(snapshot: *mut c_void, queue: *mut c_void, token: u64) -> i32;
    fn angle_snapshot_drain(snapshot: *mut c_void, timeout_ns: u64) -> i32;
}

/// Owner-thread lease of initialized Metal storage exported from an ANGLE canvas.
/// The context cannot close or resize until this lease closes successfully.
pub struct Snapshot {
    raw: Option<NonNull<c_void>>,
    parent: Option<Rc<ContextOwner>>,
    size: (u32, u32),
}

impl Snapshot {
    pub(crate) fn new(parent: Rc<ContextOwner>, size: (u32, u32)) -> Result<Self, String> {
        // The retained parent is live and Rc prevents cross-thread access.
        let raw =
            NonNull::new(unsafe { angle_snapshot_create(parent.raw()?) }).ok_or_else(error)?;
        Ok(Self {
            raw: Some(raw),
            parent: Some(parent),
            size,
        })
    }

    fn raw(&self) -> Result<*mut c_void, String> {
        self.raw
            .map(NonNull::as_ptr)
            .ok_or_else(|| "Snapshot is closed".into())
    }

    pub fn size(&self) -> (u32, u32) {
        self.size
    }

    /// Borrowed Metal device; null after close. Do not release this reference.
    pub fn device_raw(&self) -> *mut c_void {
        self.raw.map_or(std::ptr::null_mut(), |raw| unsafe {
            angle_snapshot_device(raw.as_ptr())
        })
    }

    /// Borrowed initialized RGBA8 Metal texture; null after close.
    /// Importers must retain it independently and obey the queue handoff protocol.
    pub fn texture_raw(&self) -> *mut c_void {
        self.raw.map_or(std::ptr::null_mut(), |raw| unsafe {
            angle_snapshot_texture(raw.as_ptr())
        })
    }

    pub fn publish(&mut self) -> Result<u64, String> {
        let token = unsafe { angle_snapshot_publish(self.raw()?) };
        if token == 0 { Err(error()) } else { Ok(token) }
    }

    /// # Safety
    /// `queue` must be a live Metal command queue. Serialize queue submissions,
    /// flush pending writes, and create consumer encoders only after this wait.
    pub unsafe fn queue_wait(&mut self, queue: *mut c_void, token: u64) -> Result<(), String> {
        checked(unsafe { angle_snapshot_queue_wait(self.raw()?, queue, token) })
    }

    /// # Safety
    /// Use the same live queue and token as queue_wait. Submit every source-texture
    /// reader before signaling, with no concurrent submissions or later readers.
    pub unsafe fn queue_signal(&mut self, queue: *mut c_void, token: u64) -> Result<(), String> {
        checked(unsafe { angle_snapshot_queue_signal(self.raw()?, queue, token) })
    }

    /// Bounded completion wait. Failure retains the lease for a later retry.
    pub fn drain(&mut self, timeout_ns: u64) -> Result<(), String> {
        checked(unsafe { angle_snapshot_drain(self.raw()?, timeout_ns) })
    }

    pub fn close(&mut self) -> Result<(), String> {
        if let Some(raw) = self.raw {
            checked(unsafe { angle_snapshot_destroy(raw.as_ptr()) })?;
            self.raw = None;
            self.parent = None;
        }
        Ok(())
    }
}

fn checked(result: i32) -> Result<(), String> {
    if result == 1 { Ok(()) } else { Err(error()) }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        if let Err(message) = self.close() {
            // Unknown GPU completion cannot justify releasing the parent context.
            if let Some(parent) = self.parent.take() {
                std::mem::forget(parent);
            }
            eprintln!("ANGLE snapshot teardown failed; native lease retained: {message}");
        }
    }
}
