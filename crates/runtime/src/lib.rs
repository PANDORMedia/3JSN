//! Embedded JavaScript and WebGPU execution. The caller owns the OS event loop.

use std::{any::Any, path::Path, rc::Rc, sync::Arc};

use deno_core::{FsModuleLoader, JsRuntime, RuntimeOptions};
use deno_webgpu::{wgpu_core, wgpu_types};

mod embedded;
mod interactive;
mod interrupt;
mod surface;
pub use interactive::InteractiveRuntime;
pub use interrupt::RuntimeInterrupt;
use surface::*;
pub use surface::{FrameOutcome, WindowSurface};

deno_core::extension!(
    threejs_native_bootstrap,
    deps = [deno_webidl, deno_web, deno_webgpu],
    ops = [op_native_has_surface, op_native_bind_callbacks, op_native_frame_pending,
        op_native_keep_alive, op_native_request_adapter, op_native_canvas_context,
        op_native_resize, op_native_discard, op_native_current_texture],
    esm_entry_point = "ext:threejs_native_bootstrap/bootstrap.js",
    esm = [dir "src", "bootstrap.js", "window.js", "animation.js"],
    options = { instance: deno_webgpu::Instance, surface: Option<SharedSurface> },
    state = |state, options| {
        state.put(options.instance);
        state.put(options.surface);
    },
);

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("cannot resolve module {path}: {message}")]
    ModulePath { path: String, message: String },
    #[error("JavaScript {phase} failed: {message}")]
    JavaScript {
        phase: &'static str,
        message: String,
    },
    #[error("native GPU surface failed: {0}")]
    Surface(String),
    #[error("JavaScript execution cancelled")]
    Cancelled,
    #[error("invalid runtime execution mode: {0}")]
    ExecutionMode(&'static str),
}

/// A single-threaded JS isolate and its GPU registry.
///
/// Create, poll and drop this value inside one current-thread Tokio runtime.
/// Local modules are trusted application code, not a sandbox; they are loaded
/// from disk without network imports. Runtime extension sources are embedded.
pub struct Runtime {
    // Drop order matters: isolate resources, then surface, then native handles.
    js: JsRuntime,
    surface: Option<SharedSurface>,
    _window_owner: Option<Box<dyn Any>>,
    interrupt: RuntimeInterrupt,
}

/// V8 version actually linked into this executable.
pub fn engine_version() -> &'static str {
    deno_core::v8::V8::get_version()
}

/// The sole native graphics backend selected for this target.
pub fn backend_name() -> &'static str {
    if cfg!(target_vendor = "apple") {
        "metal"
    } else if cfg!(windows) {
        "dx12"
    } else {
        "vulkan"
    }
}

impl Runtime {
    pub fn new() -> Self {
        Self::construct(new_instance(), None, None)
    }

    fn construct(
        instance: deno_webgpu::Instance,
        surface: Option<SharedSurface>,
        window_owner: Option<Box<dyn Any>>,
    ) -> Self {
        let mut extensions = vec![
            deno_webidl::deno_webidl::init(),
            deno_web::deno_web::init(
                Arc::new(deno_web::BlobStore::default()),
                None,
                false,
                deno_web::InMemoryBroadcastChannel::default(),
            ),
            deno_webgpu::deno_webgpu::init(),
            threejs_native_bootstrap::init(instance, surface.clone()),
        ];
        extensions
            .iter_mut()
            .for_each(embedded::embed_extension_sources);
        let mut js = JsRuntime::new(RuntimeOptions {
            module_loader: Some(Rc::new(FsModuleLoader)),
            extensions,
            ..Default::default()
        });
        let interrupt = RuntimeInterrupt::new(js.v8_isolate().thread_safe_handle());
        Self {
            js,
            surface,
            _window_owner: window_owner,
            interrupt,
        }
    }

    pub fn interrupt_handle(&self) -> RuntimeInterrupt {
        self.interrupt.clone()
    }

    fn javascript_error(&self, phase: &'static str, error: impl std::fmt::Display) -> RuntimeError {
        if self.interrupt.is_requested() {
            RuntimeError::Cancelled
        } else {
            RuntimeError::JavaScript {
                phase,
                message: error.to_string(),
            }
        }
    }

    /// Evaluate one local module, drain its referenced work, then dispose the realm.
    /// JS failures retain their stack/source locations. Consuming the runtime
    /// prevents reuse after a failed evaluation or a second main-module bootstrap.
    pub async fn execute_module(mut self, path: &Path) -> Result<(), RuntimeError> {
        if self.surface.is_some() {
            return Err(RuntimeError::ExecutionMode(
                "use into_interactive for a window runtime",
            ));
        }
        let id = self.load_module(path).await?;
        let evaluation = self.js.mod_evaluate(id);
        self.js
            .run_event_loop(Default::default())
            .await
            .map_err(|error| self.javascript_error("event loop", error))?;
        evaluation
            .await
            .map_err(|error| self.javascript_error("module evaluation", error))
    }

    async fn load_module(&mut self, path: &Path) -> Result<deno_core::ModuleId, RuntimeError> {
        if self.interrupt.is_requested() {
            return Err(RuntimeError::Cancelled);
        }
        let absolute = std::fs::canonicalize(path).map_err(|error| RuntimeError::ModulePath {
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
        let specifier = deno_core::ModuleSpecifier::from_file_path(&absolute).map_err(|_| {
            RuntimeError::ModulePath {
                path: absolute.display().to_string(),
                message: "expected an absolute file path".into(),
            }
        })?;
        self.js
            .load_main_es_module(&specifier)
            .await
            .map_err(|error| self.javascript_error("module loading", error))
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        if let Some(surface) = &self.surface {
            // Persistent V8 handles must be released while their isolate lives.
            surface.borrow_mut().clear_handles();
        }
    }
}

impl Default for Runtime {
    fn default() -> Self {
        Self::new()
    }
}

fn native_backend() -> wgpu_types::Backends {
    if cfg!(target_vendor = "apple") {
        wgpu_types::Backends::METAL
    } else if cfg!(windows) {
        wgpu_types::Backends::DX12
    } else {
        wgpu_types::Backends::VULKAN
    }
}

fn new_instance() -> deno_webgpu::Instance {
    Arc::new(wgpu_core::global::Global::new(
        "3jsn",
        wgpu_types::InstanceDescriptor {
            backends: native_backend(),
            ..wgpu_types::InstanceDescriptor::new_without_display_handle()
        },
        None,
    ))
}
