use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

/// Thread-safe cancellation for a realm that may be stuck in synchronous JS.
/// It cannot interrupt a blocked native driver or arbitrary foreign-code call.
#[derive(Clone)]
pub struct RuntimeInterrupt {
    handle: deno_core::v8::IsolateHandle,
    requested: Arc<AtomicBool>,
}

impl RuntimeInterrupt {
    pub(crate) fn new(handle: deno_core::v8::IsolateHandle) -> Self {
        Self {
            handle,
            requested: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Request termination; returns false if the isolate has already been disposed.
    /// This runtime is consumed after cancellation and cannot be resumed.
    pub fn terminate(&self) -> bool {
        self.requested.store(true, Ordering::Release);
        self.handle.terminate_execution()
    }

    pub(crate) fn is_requested(&self) -> bool {
        self.requested.load(Ordering::Acquire)
    }
}
