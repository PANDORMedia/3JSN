use std::{
    future::Future,
    path::PathBuf,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
    time::Duration,
};

use blitz_dom::DocumentConfig;
use blitz_traits::shell::{ColorScheme, Viewport};
use deno_core::{JsRuntime, OpState, op2, v8};
use tokio::sync::watch;
use winit::event_loop::EventLoopProxy;

use crate::{
    Result, dom_bridge, host,
    package_resources::{PACKAGE_BASE_URL, PackageResources},
    window_input::Input,
    window_options::DocumentInput,
    window_scene::WindowScene,
};

#[derive(Clone, Copy, PartialEq)]
pub struct HostState {
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub visible: bool,
    pub redraw: u64,
    pub present: u64,
    pub close: bool,
}

impl HostState {
    fn drawable(self) -> bool {
        self.visible && self.width > 0 && self.height > 0 && !self.close
    }
}

#[derive(Debug)]
pub enum HostEvent {
    Ready {
        canvas_api: &'static str,
        shared_queue: bool,
    },
    Prepared(u64),
    Presented(u64),
    Stopped(std::result::Result<(u64, u64), String>),
}

pub type Interrupt = Arc<Mutex<Option<v8::IsolateHandle>>>;

struct Callbacks {
    viewport: [f64; 3],
    pending: bool,
    frame: Option<v8::Global<v8::Function>>,
    resize: Option<v8::Global<v8::Function>>,
    input: Option<v8::Global<v8::Function>>,
}

#[op2]
fn op_dom_window_bind(
    state: &mut OpState,
    #[scoped] frame: v8::Global<v8::Function>,
    #[scoped] resize: v8::Global<v8::Function>,
    #[scoped] input: v8::Global<v8::Function>,
) {
    let callbacks = state.borrow_mut::<Callbacks>();
    callbacks.frame = Some(frame);
    callbacks.resize = Some(resize);
    callbacks.input = Some(input);
}

#[op2]
#[serde]
fn op_dom_window_viewport(state: &mut OpState) -> Vec<f64> {
    state.borrow::<Callbacks>().viewport.to_vec()
}

#[op2(fast)]
fn op_dom_window_pending(state: &mut OpState, pending: bool) {
    state.borrow_mut::<Callbacks>().pending = pending;
}

deno_core::extension!(dom_window,
    ops = [op_dom_window_bind, op_dom_window_viewport, op_dom_window_pending],
    options = { viewport: [f64; 3] },
    state = |state, options| state.put(Callbacks { viewport: options.viewport, pending: false,
        frame: None, resize: None, input: None }),
);

fn extension(state: HostState) -> deno_core::Extension {
    let mut extension = dom_window::init([state.width.into(), state.height.into(), state.scale]);
    extension.esm_files = vec![
        deno_core::ExtensionFileSource::new(
            "ext:dom_window/animation.js",
            deno_core::ascii_str_include!("../../../crates/runtime/src/animation.js"),
        ),
        deno_core::ExtensionFileSource::new(
            "ext:dom_window/window.js",
            deno_core::ascii_str_include!("window.js"),
        ),
    ]
    .into();
    extension.esm_entry_point = Some("ext:dom_window/window.js");
    extension
}

fn call(
    runtime: &mut JsRuntime,
    callback: &v8::Global<v8::Function>,
    args: &[v8::Global<v8::Value>],
) -> Result<()> {
    let call = runtime.call_with_args(callback, args);
    let mut call = std::pin::pin!(call);
    match call.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(result) => {
            result?;
            Ok(())
        }
        Poll::Pending => Err("internal window callback returned a promise".into()),
    }
}

fn resize(runtime: &mut JsRuntime, state: HostState) -> Result<()> {
    dom_bridge::with_document(runtime, |doc| {
        doc.set_viewport(Viewport::new(
            state.width,
            state.height,
            state.scale as f32,
            ColorScheme::Dark,
        ));
    });
    let callback = runtime
        .op_state()
        .borrow()
        .borrow::<Callbacks>()
        .resize
        .clone()
        .ok_or("missing resize callback")?;
    let args = {
        deno_core::scope!(scope, runtime);
        [state.width.into(), state.height.into(), state.scale].map(|value| {
            let value: v8::Local<v8::Value> = v8::Number::new(scope, value).into();
            v8::Global::new(scope, value)
        })
    };
    call(runtime, &callback, &args)
}

fn dispatch_input(
    runtime: &mut JsRuntime,
    input: Input,
    started: std::time::Instant,
) -> Result<()> {
    let target = if input.kind.starts_with("mouse") || input.kind == "click" {
        dom_bridge::with_document(runtime, |doc| {
            doc.resolve(started.elapsed().as_secs_f64());
            doc.element_from_point(input.x as f32, input.y as f32)
                .map(|node| node.as_u64().to_string())
                .unwrap_or_default()
        })
    } else {
        String::new()
    };
    // No document or OpState borrow crosses application dispatch: handlers can
    // synchronously mutate the same DOM and request fresh layout.
    let callback = runtime
        .op_state()
        .borrow()
        .borrow::<Callbacks>()
        .input
        .clone()
        .ok_or("missing input callback")?;
    let args = {
        deno_core::scope!(scope, runtime);
        let kind = v8::String::new(scope, input.kind).ok_or("input kind allocation failed")?;
        let x = v8::Number::new(scope, input.x);
        let y = v8::Number::new(scope, input.y);
        let button = v8::Number::new(scope, f64::from(input.button));
        let key = v8::String::new(scope, &input.key).ok_or("input key allocation failed")?;
        let target = v8::String::new(scope, &target).ok_or("input target allocation failed")?;
        let code = v8::String::new(scope, &input.code).ok_or("input code allocation failed")?;
        let repeat = v8::Boolean::new(scope, input.repeat);
        let shift = v8::Boolean::new(scope, input.modifiers.shift);
        let control = v8::Boolean::new(scope, input.modifiers.control);
        let alt = v8::Boolean::new(scope, input.modifiers.alt);
        let meta = v8::Boolean::new(scope, input.modifiers.meta);
        [
            kind.into(),
            x.into(),
            y.into(),
            button.into(),
            key.into(),
            target.into(),
            code.into(),
            repeat.into(),
            shift.into(),
            control.into(),
            alt.into(),
            meta.into(),
        ]
        .map(|value: v8::Local<v8::Value>| v8::Global::new(scope, value))
    };
    call(runtime, &callback, &args)
}

pub struct Worker {
    pub native_webgl: Option<std::path::PathBuf>,
    pub frames: Option<u64>,
    pub resources: Option<Vec<threejs_native_package::Resource>>,
    pub document: DocumentInput,
    pub module: PathBuf,
    pub font: Vec<u8>,
    pub instance: wgpu::Instance,
    pub surface: wgpu::Surface<'static>,
    pub state: watch::Receiver<HostState>,
    pub input: threejs_native_input_queue::Receiver<Input>,
    pub proxy: EventLoopProxy<HostEvent>,
    pub interrupt: Interrupt,
}

async fn closed(mut state: watch::Receiver<HostState>) {
    while !state.borrow_and_update().close {
        if state.changed().await.is_err() {
            break;
        }
    }
}

fn check_resources(runtime: &mut JsRuntime, provider: &PackageResources) -> Result<()> {
    dom_bridge::with_document(runtime, |doc| -> Result<()> {
        provider.drain(doc)?;
        doc.check_web_fonts()?;
        Ok(())
    })
}

pub async fn run(mut worker: Worker) -> std::result::Result<(u64, u64), String> {
    let initial = *worker.state.borrow();
    let started = std::time::Instant::now();
    let mut font_ctx = blitz_dom::build_single_font_ctx(&worker.font);
    if font_ctx.collection.family_names().next().is_none() {
        return Err("supplied font did not register a usable font family".into());
    }
    let resources = worker
        .resources
        .take()
        .map(|assets| PackageResources::new(PACKAGE_BASE_URL, assets))
        .transpose()
        .map_err(|error| error.to_string())?;
    let config = DocumentConfig {
        defer_font_loads: resources.is_some(),
        base_url: resources
            .as_ref()
            .map(|provider| provider.base_url().into()),
        net_provider: resources
            .as_ref()
            .map(|provider| provider.clone() as Arc<dyn blitz_traits::net::NetProvider>),
        font_ctx: Some(font_ctx),
        viewport: Some(Viewport::new(
            initial.width,
            initial.height,
            initial.scale as f32,
            ColorScheme::Dark,
        )),
        ..Default::default()
    };
    let dom = worker
        .document
        .into_dom(config)
        .map_err(|error| error.to_string())?;
    if worker.native_webgl.is_some() && !cfg!(feature = "native-webgl") {
        return Err("ANGLE selection requires a native-webgl player".into());
    }
    #[allow(unused_mut)]
    let mut extensions = vec![extension(initial)];
    #[cfg(feature = "native-webgl")]
    let webgl_enabled = if let Some(directory) = &worker.native_webgl {
        extensions.push(threejs_native_webgl_runtime::runtime_extension(directory)?);
        extensions.push(crate::webgl_backend::extension());
        true
    } else {
        false
    };
    let mut runtime = host::create_with_dom_extension(
        dom,
        extensions,
        threejs_native_js_sources::embed_extension_sources,
    );
    *worker.interrupt.lock().unwrap() = Some(runtime.v8_isolate().thread_safe_handle());
    let mut scene = None;
    let mut presented = 0;
    let outcome: Result<(u64, u64)> = async {
        if let Some(provider) = &resources {
            let report = dom_bridge::with_document(&mut runtime, |doc| -> Result<_> {
                provider.drain(doc)?;
                doc.load_web_fonts()?;
                let mut delivery = provider.finish_initial_load(doc)?;
                let fonts = doc.check_web_fonts()?;
                delivery.font_registration_verified = true;
                Ok(
                    serde_json::json!({"packagedResources":delivery, "webFonts":{
                        "requested":fonts.requested, "registered":fonts.registered,
                        "pending":fonts.pending, "decodedBytes":fonts.decoded_bytes
                    }}),
                )
            })?;
            println!("{report}");
        }
        if worker.state.borrow().close {
            return Ok((0, 0));
        }
        tokio::select! {
            result = host::load(&mut runtime, &worker.module) => result?,
            _ = closed(worker.state.clone()) => return Ok((0, 0)),
        }
        // Three.js may configure its DOM canvas lazily on the first RAF. Run
        // that callback before discovering the canvas device for composition.
        let first_frame = runtime
            .op_state()
            .borrow()
            .borrow::<Callbacks>()
            .frame
            .clone()
            .ok_or("missing animation callback")?;
        call(&mut runtime, &first_frame, &[])?;
        if let Some(provider) = &resources {
            check_resources(&mut runtime, provider)?;
        }
        drop(first_frame);
        scene = Some(WindowScene::new(
            &mut runtime,
            &worker.instance,
            worker.surface,
            initial.width,
            initial.height,
        )?);
        let scene = scene.as_mut().unwrap();
        worker.proxy.send_event(HostEvent::Ready {
            canvas_api: scene.canvas_api(),
            shared_queue: scene.painter.bridge.shared_deno_queue(),
        })?;
        let mut viewport = (initial.width, initial.height, initial.scale);
        let mut redraw = 0;
        let mut sequence = 0;
        let mut pending: Option<(u64, wgpu::SurfaceTexture)> = None;
        let mut composed = false;
        let mut tick = tokio::time::interval(Duration::from_millis(8));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let current = *worker.state.borrow_and_update();
            if current.close {
                break;
            }
            if let Poll::Ready(Err(error)) =
                runtime.poll_event_loop(&mut Context::from_waker(Waker::noop()), Default::default())
            {
                return Err(error.into());
            }
            if let Some(provider) = &resources {
                check_resources(&mut runtime, provider)?;
            }
            if viewport != (current.width, current.height, current.scale) {
                pending = None;
                composed = false;
                viewport = (current.width, current.height, current.scale);
                if current.width > 0 && current.height > 0 {
                    scene.resize(current.width, current.height)?;
                    resize(&mut runtime, current)?;
                }
            }
            if !current.drawable() {
                pending = None;
                composed = false;
            }
            if pending
                .as_ref()
                .is_some_and(|(id, _)| *id == current.present)
            {
                let (_, frame) = pending.take().unwrap();
                frame.present();
                #[cfg(feature = "native-webgl")]
                scene.presented(&mut runtime)?;
                presented += 1;
                composed = false;
                worker.proxy.send_event(HostEvent::Presented(presented))?;
                // Finish on the worker before another callback can start. A
                // main-thread interrupt here can turn WebIDL calls into errors.
                if worker.frames.is_some_and(|limit| presented >= limit) {
                    break;
                }
            }
            for _ in 0..64 {
                let Ok(input) = worker.input.try_recv() else {
                    break;
                };
                dispatch_input(&mut runtime, input, started)?;
            }
            if worker.state.borrow().close {
                break;
            }
            if current.drawable() && pending.is_none() && (current.redraw != redraw || composed) {
                if !composed {
                    redraw = current.redraw;
                    let callback = {
                        let state = runtime.op_state();
                        let state = state.borrow();
                        let callbacks = state.borrow::<Callbacks>();
                        callbacks.pending.then(|| callbacks.frame.clone()).flatten()
                    };
                    if let Some(callback) = callback {
                        call(&mut runtime, &callback, &[])?;
                    }
                    if let Some(provider) = &resources {
                        check_resources(&mut runtime, provider)?;
                    }
                    scene.compose(&mut runtime)?;
                    composed = true;
                }
                if let Some(frame) = scene.acquire()? {
                    sequence += 1;
                    pending = Some((sequence, frame));
                    worker.proxy.send_event(HostEvent::Prepared(sequence))?;
                }
            }
            tokio::select! {
                _ = tick.tick() => {},
                result = worker.state.changed() => { if result.is_err() { break; } },
            }
        }
        drop(pending);
        if worker.frames.is_some_and(|limit| presented >= limit)
            && let Some(path) = std::env::var_os("THREEJS_NATIVE_CAPTURE_PNG")
        {
            // Explicit final-frame evidence only; presentation never consumes this readback.
            scene.capture(std::path::Path::new(&path))?;
        }
        Ok((presented, scene.snapshots))
    }
    .await;
    // Clear the shared interrupt before disposing the isolate. Holding its lock
    // makes termination and disposal mutually exclusive, including startup errors.
    *worker.interrupt.lock().unwrap() = None;
    runtime.v8_isolate().cancel_terminate_execution();
    let snapshots = scene.as_ref().map_or(0, |scene| scene.snapshots);
    let cleanup: Result<()> = (|| {
        if let Some(scene) = scene.as_mut() {
            scene.release()?;
        }
        #[cfg(feature = "native-webgl")]
        if webgl_enabled {
            crate::webgl_backend::release_all(&mut runtime)?;
            threejs_native_webgl_runtime::release_all(&mut runtime)?;
        }
        Ok(())
    })();
    if let Err(error) = cleanup {
        // A failed drain cannot establish safe alias teardown. Leak this failed
        // process generation rather than destroying resources still in GPU use.
        std::mem::forget(scene);
        std::mem::forget(runtime);
        return Err(format!(
            "GPU teardown did not complete: {error}; application result: {outcome:?}"
        ));
    }
    drop(scene);
    dom_bridge::release(&mut runtime);
    runtime.op_state().borrow_mut().take::<Callbacks>();
    drop(runtime);
    if worker.state.borrow().close
        && outcome
            .as_ref()
            .is_err_and(|e| e.to_string().contains("execution terminated"))
    {
        return Ok((presented, snapshots));
    }
    outcome.map_err(|error| error.to_string())
}
