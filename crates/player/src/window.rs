use std::{
    future::{Future, poll_fn},
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
    sync::Arc,
    task::Poll,
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use threejs_native_runtime::{
    FrameOutcome, InteractiveRuntime, RuntimeError, RuntimeInterrupt, WindowSurface,
};
use tokio::sync::watch;
use winit::{
    application::ApplicationHandler,
    dpi::LogicalSize,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy},
    window::{Window, WindowId},
};

enum HostEvent {
    Ready(RuntimeInterrupt),
    RequestRedraw,
    Prepared(u64),
    Presented(u64),
    Stopped(Result<u64, WorkerError>),
}

enum WorkerError {
    Cancelled,
    Failed(String),
}

impl From<RuntimeError> for WorkerError {
    fn from(error: RuntimeError) -> Self {
        match error {
            RuntimeError::Cancelled => Self::Cancelled,
            error => Self::Failed(error.to_string()),
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
struct Viewport {
    width: u32,
    height: u32,
    scale: f64,
}

#[derive(Clone, Copy, PartialEq)]
struct HostState {
    viewport: Viewport,
    visible: bool,
    redraw: u64,
    present: u64,
    close: bool,
}

impl HostState {
    fn drawable(self) -> bool {
        self.visible && self.viewport.width > 0 && self.viewport.height > 0 && !self.close
    }
}

pub fn run(module: PathBuf, frame_limit: Option<u64>) -> Result<(), String> {
    let event_loop = EventLoop::<HostEvent>::with_user_event()
        .build()
        .map_err(|error| error.to_string())?;
    let mut app = PlayerWindow {
        window: None,
        worker: None,
        state: None,
        interrupt: None,
        proxy: event_loop.create_proxy(),
        module,
        frame_limit,
        presented_frames: 0,
        error: None,
        deadline: frame_limit.map(|_| Instant::now() + Duration::from_secs(30)),
        occluded: cfg!(target_os = "macos"),
        suspended: false,
        stopped: false,
        closing: false,
    };
    let loop_result = event_loop.run_app(&mut app);
    if let Some(interrupt) = &app.interrupt {
        interrupt.terminate();
    }
    if let Some(state) = &app.state {
        state.send_modify(|state| state.close = true);
    }
    // Normal exit follows Stopped, after the worker has disposed V8 and the
    // surface. The main owner is deliberately kept until the join completes.
    if let Some(worker) = app.worker.take() {
        worker
            .join()
            .map_err(|_| "native runtime worker panicked during shutdown".to_owned())?;
    }
    app.window.take();
    loop_result.map_err(|error| error.to_string())?;
    if let Some(error) = app.error {
        return Err(error);
    }
    if !app.stopped {
        return Err("native event loop stopped before runtime shutdown completed".into());
    }
    if frame_limit.is_some_and(|limit| app.presented_frames < limit) {
        return Err(format!(
            "native window closed after {} frames before the requested frame budget was reached",
            app.presented_frames
        ));
    }
    println!(
        "{{\"nativeWindow\":true,\"backend\":\"{}\",\"presentedFrames\":{}}}",
        threejs_native_runtime::backend_name(),
        app.presented_frames
    );
    Ok(())
}

struct PlayerWindow {
    window: Option<Arc<Window>>,
    worker: Option<JoinHandle<()>>,
    state: Option<watch::Sender<HostState>>,
    interrupt: Option<RuntimeInterrupt>,
    proxy: EventLoopProxy<HostEvent>,
    module: PathBuf,
    frame_limit: Option<u64>,
    presented_frames: u64,
    error: Option<String>,
    deadline: Option<Instant>,
    occluded: bool,
    suspended: bool,
    stopped: bool,
    closing: bool,
}

impl PlayerWindow {
    fn drawable(&self) -> bool {
        self.state
            .as_ref()
            .is_some_and(|state| state.borrow().drawable())
    }

    fn close(&mut self, event_loop: &ActiveEventLoop, error: Option<String>) {
        if self.error.is_none() {
            self.error = error;
        }
        self.closing = true;
        self.deadline = None;
        if let Some(interrupt) = &self.interrupt {
            interrupt.terminate();
        }
        if let Some(state) = &self.state {
            state.send_modify(|state| state.close = true);
        } else {
            event_loop.exit();
        }
    }

    fn update_viewport(&self) {
        let (Some(window), Some(state)) = (&self.window, &self.state) else {
            return;
        };
        let size = window.inner_size();
        let viewport = Viewport {
            width: size.width,
            height: size.height,
            scale: window.scale_factor(),
        };
        let visible = !self.occluded && !self.suspended;
        state.send_if_modified(|state| {
            if state.viewport == viewport && state.visible == visible {
                return false;
            }
            state.viewport = viewport;
            state.visible = visible;
            true
        });
    }
}

impl ApplicationHandler<HostEvent> for PlayerWindow {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.suspended = false;
        if self.window.is_some() {
            self.update_viewport();
            return;
        }
        if self.closing {
            return;
        }
        let window = match event_loop.create_window(
            Window::default_attributes()
                .with_title("3JSN Native — WebGPU integration")
                .with_inner_size(LogicalSize::new(960, 600)),
        ) {
            Ok(window) => Arc::new(window),
            Err(error) => {
                self.close(event_loop, Some(error.to_string()));
                return;
            }
        };
        let size = window.inner_size();
        let viewport = Viewport {
            width: size.width,
            height: size.height,
            scale: window.scale_factor(),
        };
        let surface =
            match WindowSurface::new(window.clone(), size.width, size.height, viewport.scale) {
                Ok(surface) => surface,
                Err(error) => {
                    self.close(event_loop, Some(error.to_string()));
                    return;
                }
            };
        let initial = HostState {
            viewport,
            visible: !self.occluded,
            redraw: 0,
            present: 0,
            close: false,
        };
        let (state, receiver) = watch::channel(initial);
        let proxy = self.proxy.clone();
        let module = self.module.clone();
        let frame_limit = self.frame_limit;
        // The worker never invokes winit methods. Surface preparation and all
        // Window calls stay on this thread, so asynchronous shutdown cannot
        // deadlock waiting for a main-thread Window dispatch.
        let worker = thread::Builder::new()
            .name("3jsn-runtime".into())
            .spawn(move || {
                let result = catch_unwind(AssertUnwindSafe(|| {
                    let reactor = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|error| {
                            WorkerError::Failed(format!("cannot start runtime reactor: {error}"))
                        })?;
                    reactor.block_on(run_worker(
                        surface,
                        viewport,
                        module,
                        frame_limit,
                        receiver,
                        &proxy,
                    ))
                }))
                .unwrap_or_else(|panic| {
                    let message = panic
                        .downcast_ref::<String>()
                        .map(String::as_str)
                        .or_else(|| panic.downcast_ref::<&str>().copied())
                        .unwrap_or("unknown panic");
                    Err(WorkerError::Failed(format!(
                        "native runtime worker panicked: {message}"
                    )))
                });
                let _ = proxy.send_event(HostEvent::Stopped(result));
            });
        match worker {
            Ok(worker) => {
                self.window = Some(window);
                self.state = Some(state);
                self.worker = Some(worker);
            }
            Err(error) => self.close(
                event_loop,
                Some(format!("cannot spawn runtime worker: {error}")),
            ),
        }
    }

    fn suspended(&mut self, _: &ActiveEventLoop) {
        self.suspended = true;
        self.update_viewport();
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: HostEvent) {
        match event {
            HostEvent::Ready(interrupt) => {
                if self.closing {
                    interrupt.terminate();
                }
                self.interrupt = Some(interrupt);
            }
            HostEvent::RequestRedraw => {
                if self.drawable()
                    && let Some(window) = &self.window
                {
                    window.request_redraw();
                }
            }
            HostEvent::Prepared(sequence) => {
                if self.drawable()
                    && let (Some(window), Some(state)) = (&self.window, &self.state)
                {
                    window.pre_present_notify();
                    state.send_modify(|state| state.present = sequence);
                }
            }
            HostEvent::Presented(frames) => self.presented_frames = frames,
            HostEvent::Stopped(result) => {
                self.stopped = true;
                match result {
                    Ok(frames) => self.presented_frames = frames,
                    Err(WorkerError::Cancelled) if self.closing => {}
                    Err(WorkerError::Cancelled) => {
                        self.error
                            .get_or_insert("native runtime was cancelled unexpectedly".into());
                    }
                    Err(WorkerError::Failed(error)) => {
                        self.error.get_or_insert(error);
                    }
                }
                event_loop.exit();
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        if self.window.as_ref().is_none_or(|window| window.id() != id) {
            return;
        }
        match event {
            WindowEvent::CloseRequested => self.close(event_loop, None),
            WindowEvent::Occluded(occluded) => {
                self.occluded = occluded;
                self.update_viewport();
            }
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                self.update_viewport()
            }
            WindowEvent::RedrawRequested => {
                if let Some(state) = &self.state {
                    state.send_if_modified(|state| {
                        if !state.drawable() {
                            return false;
                        }
                        state.redraw = state.redraw.wrapping_add(1);
                        true
                    });
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            self.close(
                event_loop,
                Some("native frame validation exceeded its 30-second deadline".into()),
            );
        }
        event_loop.set_control_flow(
            self.deadline
                .map_or(ControlFlow::Wait, ControlFlow::WaitUntil),
        );
    }

    fn exiting(&mut self, _: &ActiveEventLoop) {
        if let Some(interrupt) = &self.interrupt {
            interrupt.terminate();
        }
        if let Some(state) = &self.state {
            state.send_modify(|state| state.close = true);
        }
    }
}

async fn run_worker(
    surface: WindowSurface,
    initial_viewport: Viewport,
    module: PathBuf,
    frame_limit: Option<u64>,
    mut receiver: watch::Receiver<HostState>,
    proxy: &EventLoopProxy<HostEvent>,
) -> Result<u64, WorkerError> {
    let runtime = surface.into_runtime().map_err(WorkerError::from)?;
    proxy
        .send_event(HostEvent::Ready(runtime.interrupt_handle()))
        .map_err(|_| WorkerError::Failed("native event loop closed".into()))?;
    let mut current = *receiver.borrow_and_update();
    if current.close {
        return Ok(0);
    }
    let initialization = runtime.into_interactive(&module);
    tokio::pin!(initialization);
    let mut runtime = loop {
        tokio::select! {
            result = &mut initialization => break result.map_err(WorkerError::from)?,
            changed = receiver.changed() => {
                if changed.is_err() || receiver.borrow_and_update().close { return Ok(0); }
            }
        }
    };
    current = *receiver.borrow_and_update();
    if !current.close
        && current.viewport != initial_viewport
        && current.viewport.width > 0
        && current.viewport.height > 0
    {
        runtime
            .resize(
                current.viewport.width,
                current.viewport.height,
                current.viewport.scale,
            )
            .map_err(WorkerError::from)?;
    }
    let result = drive_runtime(&mut runtime, frame_limit, &mut receiver, proxy, current).await;
    let cleanup = runtime.discard_frame().map_err(WorkerError::from);
    match (result, cleanup) {
        (_, Err(error)) | (Err(error), Ok(())) => Err(error),
        (Ok(()), Ok(())) => Ok(runtime.presented_frames()),
    }
}

async fn drive_runtime(
    runtime: &mut InteractiveRuntime,
    frame_limit: Option<u64>,
    receiver: &mut watch::Receiver<HostState>,
    proxy: &EventLoopProxy<HostEvent>,
    mut current: HostState,
) -> Result<(), WorkerError> {
    let mut viewport = current.viewport;
    let mut visible = current.drawable();
    let mut consumed_redraw = 0;
    let mut prepared = None;
    let mut redraw_requested = false;
    let mut retry_delay = None;
    loop {
        if current.close {
            return Ok(());
        }
        if viewport != current.viewport {
            viewport = current.viewport;
            if viewport.width > 0 && viewport.height > 0 {
                runtime
                    .resize(viewport.width, viewport.height, viewport.scale)
                    .map_err(WorkerError::from)?;
            } else {
                runtime.discard_frame().map_err(WorkerError::from)?;
            }
            prepared = None;
            redraw_requested = false;
            retry_delay = None;
        }
        if visible != current.drawable() {
            visible = current.drawable();
            redraw_requested = false;
            retry_delay = None;
            if !visible {
                runtime.discard_frame().map_err(WorkerError::from)?;
                prepared = None;
            }
        }
        if prepared.is_some_and(|sequence| current.present == sequence) && current.drawable() {
            let outcome = runtime.present().map_err(WorkerError::from)?;
            prepared = None;
            match outcome {
                FrameOutcome::Presented => {
                    let frames = runtime.presented_frames();
                    proxy
                        .send_event(HostEvent::Presented(frames))
                        .map_err(|_| WorkerError::Failed("native event loop closed".into()))?;
                    if frame_limit.is_some_and(|limit| frames >= limit) {
                        return Ok(());
                    }
                }
                FrameOutcome::Retry => {
                    // Pace only the next presentation attempt. Deno keeps
                    // servicing timers and IO while the rendered image waits.
                    retry_delay = Some(Box::pin(tokio::time::sleep(Duration::from_millis(16))));
                    redraw_requested = false;
                }
                FrameOutcome::NoFrame => {}
            }
        }
        if consumed_redraw != current.redraw {
            consumed_redraw = current.redraw;
            redraw_requested = false;
            if current.drawable() && prepared.is_none() && retry_delay.is_none() {
                // A deferred image belongs to a completed application frame;
                // retry presentation without advancing its animation callbacks.
                if !runtime.has_deferred_frame() {
                    runtime.dispatch_frame().map_err(WorkerError::from)?;
                }
                poll_fn(|cx| Poll::Ready(runtime.poll(cx)))
                    .await
                    .map_err(WorkerError::from)?;
                prepared = Some(current.redraw);
                proxy
                    .send_event(HostEvent::Prepared(current.redraw))
                    .map_err(|_| WorkerError::Failed("native event loop closed".into()))?;
            }
        }

        // Both the watch receiver and Deno register this task's Tokio waker.
        // The current-thread reactor parks until input, timers or IO are ready;
        // no idle polling timer or cross-thread V8 access is needed.
        let connected = {
            let changed = receiver.changed();
            tokio::pin!(changed);
            poll_fn(|cx| {
                if let Err(error) = runtime.poll(cx) {
                    return Poll::Ready(Err(WorkerError::from(error)));
                }
                if retry_delay
                    .as_mut()
                    .is_some_and(|delay| delay.as_mut().poll(cx).is_ready())
                {
                    retry_delay = None;
                }
                if current.drawable()
                    && prepared.is_none()
                    && !redraw_requested
                    && retry_delay.is_none()
                    && runtime.needs_redraw()
                {
                    if proxy.send_event(HostEvent::RequestRedraw).is_err() {
                        return Poll::Ready(Err(WorkerError::Failed(
                            "native event loop closed".into(),
                        )));
                    }
                    redraw_requested = true;
                }
                changed.as_mut().poll(cx).map(|result| Ok(result.is_ok()))
            })
            .await?
        };
        if !connected {
            return Ok(());
        }
        current = *receiver.borrow_and_update();
    }
}
