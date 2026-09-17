//! The native surface uses the same registry as every JavaScript GPU object.

use std::{any::Any, cell::RefCell, rc::Rc, sync::Arc};

use deno_core::{OpState, cppgc, op2, v8};
use deno_error::JsErrorBox;
use deno_webgpu::{
    Instance,
    adapter::{GPUAdapter, GPUPowerPreference, GPURequestAdapterOptions},
    canvas::{ContextData, GPUCanvasContext, SurfaceData},
    texture::GPUTexture,
    wgpu_core, wgpu_types,
};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};

use crate::{Runtime, RuntimeError, native_backend, new_instance};

mod acquisition;
mod deferred;
use acquisition::{AcquiredFrame, status_outcome};
use deferred::DeferredFrame;

/// Only a submitted native surface image counts as a displayed frame.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FrameOutcome {
    NoFrame,
    Presented,
    Retry,
}

/// A surface prepared on the OS window thread, before any JS realm exists.
/// Transfer this value to the runtime thread; never transfer a raw window handle
/// or a V8 object. The window owner remains retained through surface disposal.
pub struct WindowSurface {
    native: Option<(Instance, wgpu_core::id::SurfaceId)>,
    owner: Arc<dyn Any + Send + Sync>,
    width: u32,
    height: u32,
    scale: f64,
}

impl WindowSurface {
    pub fn new<W: HasDisplayHandle + HasWindowHandle + Send + Sync + 'static>(
        window: Arc<W>,
        width: u32,
        height: u32,
        scale: f64,
    ) -> Result<Self, RuntimeError> {
        let instance = new_instance();
        let display = window.display_handle().map_err(surface_error)?;
        let handle = window.window_handle().map_err(surface_error)?;
        // SAFETY: handles are obtained and the platform surface is created on
        // the OS event thread. The retained window outlives surface_drop, also
        // when initialization fails before a worker consumes this value.
        let id = unsafe {
            instance.instance_create_surface(Some(display.as_raw()), handle.as_raw(), None)
        }
        .map_err(surface_error)?;
        Ok(Self {
            native: Some((instance, id)),
            owner: window,
            width,
            height,
            scale,
        })
    }

    /// Construct the isolate inside its owning current-thread async runtime.
    /// GPU surface ownership transfers exactly once into Deno's SurfaceData.
    pub fn into_runtime(mut self) -> Result<Runtime, RuntimeError> {
        let (instance, id) = self.native.take().expect("surface is consumed once");
        let bindings = SurfaceBindings::new(SurfaceData {
            instance: instance.clone(),
            id,
            width: self.width.max(1),
            height: self.height.max(1),
        });
        let mut runtime =
            Runtime::construct(instance, Some(bindings), Some(Box::new(self.owner.clone())));
        runtime.resize_window(self.width, self.height, self.scale)?;
        Ok(runtime)
    }
}

impl Drop for WindowSurface {
    fn drop(&mut self) {
        if let Some((instance, id)) = self.native.take() {
            instance.surface_drop(id);
        }
    }
}

pub(crate) type SharedSurface = Rc<RefCell<SurfaceBindings>>;

pub(crate) struct SurfaceBindings {
    pub data: Rc<RefCell<SurfaceData>>,
    pub context: Option<v8::Global<v8::Object>>,
    pub dispatch_frame: Option<v8::Global<v8::Function>>,
    pub resize: Option<v8::Global<v8::Function>>,
    pub frame_pending: bool,
    pub presented_frames: u64,
    acquired: Option<AcquiredFrame>,
    reconfigure: bool,
    deferred: Option<DeferredFrame>,
    copy_destination_configured: bool,
}

impl SurfaceBindings {
    fn new(data: SurfaceData) -> SharedSurface {
        Rc::new(RefCell::new(Self {
            data: Rc::new(RefCell::new(data)),
            context: None,
            dispatch_frame: None,
            resize: None,
            frame_pending: false,
            presented_frames: 0,
            acquired: None,
            reconfigure: false,
            deferred: None,
            copy_destination_configured: false,
        }))
    }

    pub fn needs_redraw(&self, scope: &mut v8::PinScope<'_, '_>) -> bool {
        self.frame_pending
            || self.deferred.is_some()
            || self.context.as_ref().is_some_and(|context| {
                let context = v8::Local::new(scope, context);
                cppgc::try_unwrap_cppgc_object::<GPUCanvasContext>(scope, context.into())
                    .is_some_and(|context| context.current_texture.borrow().is_some())
            })
    }

    pub fn has_deferred_frame(&self) -> bool {
        self.deferred.is_some() || self.acquired == Some(AcquiredFrame::Discarded)
    }

    pub fn present(
        &mut self,
        scope: &mut v8::PinScope<'_, '_>,
    ) -> Result<FrameOutcome, RuntimeError> {
        let Some(context) = &self.context else {
            return Ok(FrameOutcome::NoFrame);
        };
        let context = v8::Local::new(scope, context);
        let context = cppgc::try_unwrap_cppgc_object::<GPUCanvasContext>(scope, context.into())
            .expect("only GPUCanvasContext is retained");
        let Some(texture) = context.current_texture.borrow_mut().take() else {
            return self.present_deferred(&context);
        };
        // A newer timer/IO render supersedes the single pending image.
        self.deferred = None;
        let texture = v8::Local::new(scope, texture);
        let texture = cppgc::try_unwrap_cppgc_object::<GPUTexture>(scope, texture.into())
            .expect("the canvas owns a GPUTexture");
        let data = self.data.borrow();
        let result = match self.acquired.take() {
            Some(AcquiredFrame::Surface) => Some(data.instance.surface_present(data.id)),
            Some(AcquiredFrame::Discarded) => {
                let pending = DeferredFrame::capture(&texture);
                texture.instance.texture_destroy(texture.id);
                self.deferred = pending?;
                return Ok(if self.deferred.is_some() {
                    FrameOutcome::Retry
                } else {
                    FrameOutcome::NoFrame
                });
            }
            None => return Err(surface_error("canvas texture has no acquisition owner")),
        };
        // A canvas texture expires after presentation even when JS retains it.
        // Releasing only our V8 handle would leave that observable texture live.
        texture.instance.texture_destroy(texture.id);
        let Some(result) = result else {
            return Ok(FrameOutcome::Retry);
        };
        let status = match result {
            Ok(status) => status,
            Err(wgpu_core::present::SurfaceError::TextureDestroyed) => {
                return Ok(FrameOutcome::NoFrame);
            }
            Err(error) => return Err(surface_error(error)),
        };
        let outcome = status_outcome(&status).map_err(surface_error)?;
        self.reconfigure |= matches!(
            status,
            wgpu_types::SurfaceStatus::Lost | wgpu_types::SurfaceStatus::Outdated
        );
        if outcome == FrameOutcome::Presented {
            self.presented_frames += 1;
        }
        Ok(outcome)
    }

    pub fn clear_handles(&mut self) {
        self.context.take();
        self.dispatch_frame.take();
        self.resize.take();
    }

    pub(crate) fn discard(&mut self, scope: &mut v8::PinScope<'_, '_>) -> Result<(), JsErrorBox> {
        self.discard_current(scope, true)
    }

    fn invalidate(&mut self, scope: &mut v8::PinScope<'_, '_>) -> Result<(), JsErrorBox> {
        self.deferred = None;
        self.copy_destination_configured = false;
        self.discard_current(scope, false)
    }

    fn discard_current(
        &mut self,
        scope: &mut v8::PinScope<'_, '_>,
        preserve_fallback: bool,
    ) -> Result<(), JsErrorBox> {
        let Some(context) = &self.context else {
            return Ok(());
        };
        let local = v8::Local::new(scope, context);
        let context = cppgc::try_unwrap_cppgc_object::<GPUCanvasContext>(scope, local.into())
            .expect("only GPUCanvasContext is retained");
        if context.current_texture.borrow().is_some() {
            let data = self.data.borrow();
            // Destroy alone does not drain wgpu's acquired surface slot. Drain
            // before Deno's resize/configure can destroy or replace the texture.
            if self.acquired == Some(AcquiredFrame::Surface) {
                match data.instance.surface_texture_discard(data.id) {
                    Ok(()) | Err(wgpu_core::present::SurfaceError::TextureDestroyed) => {}
                    Err(error) => return Err(JsErrorBox::generic(error.to_string())),
                }
            }
            if let Some(texture) = context.current_texture.borrow_mut().take() {
                let local = v8::Local::new(scope, texture);
                let texture = cppgc::try_unwrap_cppgc_object::<GPUTexture>(scope, local.into())
                    .expect("the canvas owns a GPUTexture");
                let pending =
                    if preserve_fallback && self.acquired == Some(AcquiredFrame::Discarded) {
                        Some(DeferredFrame::capture(&texture))
                    } else {
                        None
                    };
                texture.instance.texture_destroy(texture.id);
                self.acquired = None;
                if let Some(pending) = pending {
                    self.deferred =
                        pending.map_err(|error| JsErrorBox::generic(error.to_string()))?;
                }
            }
            self.acquired = None;
        }
        Ok(())
    }
}

fn surface_error(error: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::Surface(error.to_string())
}

fn surface(state: &OpState) -> Result<SharedSurface, JsErrorBox> {
    state
        .borrow::<Option<SharedSurface>>()
        .clone()
        .ok_or_else(|| JsErrorBox::type_error("this runtime has no native window"))
}

#[op2(fast)]
pub(crate) fn op_native_has_surface(state: &OpState) -> bool {
    state.borrow::<Option<SharedSurface>>().is_some()
}

#[op2]
pub(crate) fn op_native_bind_callbacks(
    state: &mut OpState,
    #[scoped] dispatch: v8::Global<v8::Function>,
    #[scoped] resize: v8::Global<v8::Function>,
) -> Result<(), JsErrorBox> {
    let shared = surface(state)?;
    let mut surface = shared.borrow_mut();
    surface.dispatch_frame = Some(dispatch);
    surface.resize = Some(resize);
    Ok(())
}

#[op2(fast)]
pub(crate) fn op_native_frame_pending(state: &OpState, pending: bool) -> Result<(), JsErrorBox> {
    surface(state)?.borrow_mut().frame_pending = pending;
    Ok(())
}

#[op2]
pub(crate) async fn op_native_keep_alive() {
    // The OS window is referenced work, including while a module awaits a RAF.
    // Dropping the isolate cancels this future; it never starts a background task.
    std::future::pending::<()>().await;
}

#[op2]
#[cppgc]
pub(crate) fn op_native_request_adapter(
    state: &OpState,
    #[webidl] options: GPURequestAdapterOptions,
) -> Result<Option<GPUAdapter>, JsErrorBox> {
    // WebGPU permits satisfying a compatibility request with a core adapter.
    // This also preserves upstream Three.js's default adapter request.
    if !matches!(options.feature_level.as_str(), "core" | "compatibility") {
        return Ok(None);
    }
    let shared = surface(state)?;
    let bindings = shared.borrow();
    let data = bindings.data.borrow();
    let descriptor = wgpu_core::instance::RequestAdapterOptions {
        power_preference: match options.power_preference {
            Some(GPUPowerPreference::LowPower) => wgpu_types::PowerPreference::LowPower,
            Some(GPUPowerPreference::HighPerformance) => {
                wgpu_types::PowerPreference::HighPerformance
            }
            None => wgpu_types::PowerPreference::default(),
        },
        force_fallback_adapter: options.force_fallback_adapter,
        compatible_surface: Some(data.id),
    };
    let Ok(id) = data
        .instance
        .request_adapter(&descriptor, native_backend(), None)
    else {
        return Ok(None);
    };
    Ok(Some(GPUAdapter {
        instance: data.instance.clone(),
        id,
        features: cppgc::SameObject::new(),
        limits: cppgc::SameObject::new(),
        info: Rc::new(cppgc::SameObject::new()),
    }))
}

#[op2]
pub(crate) fn op_native_canvas_context<'s>(
    state: &OpState,
    scope: &mut v8::PinScope<'s, '_>,
    #[scoped] canvas: v8::Global<v8::Object>,
) -> Result<v8::Global<v8::Value>, JsErrorBox> {
    let shared = surface(state)?;
    let mut surface = shared.borrow_mut();
    if let Some(context) = &surface.context {
        let local: v8::Local<v8::Value> = v8::Local::new(scope, context).into();
        return Ok(v8::Global::new(scope, local));
    }
    let options = v8::undefined(scope).into();
    let context = deno_webgpu::canvas::create(
        None,
        canvas,
        ContextData::Surface(surface.data.clone()),
        scope,
        options,
        "native canvas",
        "getContext",
    )?;
    let local = v8::Local::new(scope, &context);
    let object = v8::Local::<v8::Object>::try_from(local)
        .map_err(|_| JsErrorBox::type_error("GPUCanvasContext was not an object"))?;
    surface.context = Some(v8::Global::new(scope, object));
    Ok(context)
}

#[op2(fast)]
pub(crate) fn op_native_resize(
    state: &OpState,
    scope: &mut v8::PinScope<'_, '_>,
    width: u32,
    height: u32,
) -> Result<(), JsErrorBox> {
    let shared = surface(state)?;
    let mut surface = shared.borrow_mut();
    surface.invalidate(scope)?;
    {
        let mut data = surface.data.borrow_mut();
        data.width = width.max(1);
        data.height = height.max(1);
    }
    if let Some(context) = &surface.context {
        let local = v8::Local::new(scope, context);
        let context = cppgc::try_unwrap_cppgc_object::<GPUCanvasContext>(scope, local.into())
            .expect("only GPUCanvasContext is retained");
        context.resize(scope);
    }
    surface.reconfigure = false;
    Ok(())
}

#[op2(fast)]
pub(crate) fn op_native_discard(
    state: &OpState,
    scope: &mut v8::PinScope<'_, '_>,
    context: v8::Local<v8::Value>,
) -> Result<(), JsErrorBox> {
    let shared = surface(state)?;
    let mut surface = shared.borrow_mut();
    if surface
        .context
        .as_ref()
        .is_some_and(|known| v8::Local::new(scope, known).strict_equals(context))
    {
        surface.invalidate(scope)?;
    }
    Ok(())
}

#[op2]
pub(crate) fn op_native_current_texture(
    state: &OpState,
    scope: &mut v8::PinScope<'_, '_>,
) -> Result<v8::Global<v8::Object>, JsErrorBox> {
    surface(state)?.borrow_mut().current_texture(scope)
}
