//! Embedded JavaScript and WebGPU execution. The caller owns the OS event loop.

use std::{path::Path, rc::Rc, sync::Arc};

use deno_core::{FsModuleLoader, JsRuntime, RuntimeOptions};
use deno_webgpu::{wgpu_core, wgpu_types};

deno_core::extension!(
    threejs_native_bootstrap,
    deps = [deno_webidl, deno_web, deno_webgpu],
    esm_entry_point = "ext:threejs_native_bootstrap/bootstrap.js",
    esm = [dir "src", "bootstrap.js"],
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
}

/// A single-threaded JS isolate and its GPU registry.
///
/// Keep this value on its creating thread. Local modules are trusted application
/// code, not a sandbox; they are loaded from disk without network imports.
pub struct Runtime {
    js: JsRuntime,
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
        let js = JsRuntime::new(RuntimeOptions {
            module_loader: Some(Rc::new(FsModuleLoader)),
            extensions: vec![
                deno_webidl::deno_webidl::init(),
                deno_web::deno_web::init(
                    Arc::new(deno_web::BlobStore::default()),
                    None,
                    false,
                    deno_web::InMemoryBroadcastChannel::default(),
                ),
                deno_webgpu::deno_webgpu::init(),
                threejs_native_bootstrap::init(),
            ],
            ..Default::default()
        });
        // Inject one native registry before any adapter request. A future window
        // surface must belong to this registry, not a separate wgpu::Device.
        let instance: deno_webgpu::Instance = Arc::new(wgpu_core::global::Global::new(
            "3jsn",
            wgpu_types::InstanceDescriptor {
                backends: native_backend(),
                ..wgpu_types::InstanceDescriptor::new_without_display_handle()
            },
            None,
        ));
        js.op_state().borrow_mut().put(instance);
        Self { js }
    }

    /// Evaluate one local module, drain its referenced work, then dispose the realm.
    /// JS failures retain their stack/source locations. Consuming the runtime
    /// prevents reuse after a failed evaluation or a second main-module bootstrap.
    pub async fn execute_module(mut self, path: &Path) -> Result<(), RuntimeError> {
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
        let id = self
            .js
            .load_main_es_module(&specifier)
            .await
            .map_err(|error| RuntimeError::JavaScript {
                phase: "module loading",
                message: error.to_string(),
            })?;
        let evaluation = self.js.mod_evaluate(id);
        self.js
            .run_event_loop(Default::default())
            .await
            .map_err(|error| RuntimeError::JavaScript {
                phase: "event loop",
                message: error.to_string(),
            })?;
        evaluation.await.map_err(|error| RuntimeError::JavaScript {
            phase: "module evaluation",
            message: error.to_string(),
        })
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
