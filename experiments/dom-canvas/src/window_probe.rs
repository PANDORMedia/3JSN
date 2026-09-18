use std::{
    error::Error,
    sync::{Arc, Mutex},
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch};
use winit::{
    application::ApplicationHandler,
    dpi::LogicalSize,
    event::{ElementState, MouseButton, WindowEvent},
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy},
    keyboard::{Key, NamedKey},
    window::{Window, WindowId},
};

mod canvas_init;
mod canvas_texture;
#[allow(
    dead_code,
    reason = "Reuse DOM operations without the standalone probe entry point."
)]
mod dom_bridge;
#[allow(
    dead_code,
    reason = "Share realm initialization with the offscreen integration probes."
)]
#[path = "../../native-html-interop/src/host.rs"]
mod host;
#[allow(
    dead_code,
    reason = "The window uses only the canvas-to-compositor bridge direction."
)]
#[path = "../../native-html-interop/src/metal.rs"]
mod metal;
mod painter;
mod window_options;
mod window_runtime;
mod window_scene;

use window_options::{Command, Options};
use window_runtime::{HostEvent, HostState, Input, Interrupt, Worker};
type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn main() -> std::process::ExitCode {
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("3JSN DOM player: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let options = match window_options::parse(&args, &std::env::current_exe()?)? {
        Command::Describe => {
            println!("{}", window_options::description());
            return Ok(());
        }
        Command::Verify(path) => {
            threejs_native_package::load_for(&path, threejs_native_package::Profile::DomWindow)?;
            println!("{{\"packageVerified\":true}}");
            return Ok(());
        }
        Command::Run(options) => options,
    };
    let event_loop = EventLoop::<HostEvent>::with_user_event().build()?;
    let mut app = App {
        proxy: event_loop.create_proxy(),
        deadline: options
            .frames
            .map(|_| Instant::now() + Duration::from_secs(90)),
        options: Some(options),
        window: None,
        worker: None,
        state: None,
        input: None,
        interrupt: Arc::new(Mutex::new(None)),
        pointer: None,
        limit: None,
        presented: 0,
        snapshots: 0,
        stopped: false,
        error: None,
    };
    let result = event_loop.run_app(&mut app);
    app.stop(None);
    if let Some(worker) = app.worker.take() {
        worker.join().map_err(|_| "DOM window worker panicked")?;
    }
    app.window.take();
    result?;
    if let Some(error) = app.error {
        return Err(error.into());
    }
    if !app.stopped {
        return Err("event loop exited before worker teardown".into());
    }
    if app.limit.is_some_and(|limit| app.presented < limit) {
        return Err("window closed before requested frame count".into());
    }
    println!(
        "{}",
        serde_json::json!({"nativeDomWindow":true,"backend":"Metal","presentedFrames":app.presented,
        "canvasSnapshots":app.snapshots,"cpuImageTransport":false,"nativeDeviceIdentityChecked":true,"nativeQueueIdentityChecked":true})
    );
    Ok(())
}

struct App {
    options: Option<Options>,
    proxy: EventLoopProxy<HostEvent>,
    window: Option<Arc<Window>>,
    worker: Option<JoinHandle<()>>,
    state: Option<watch::Sender<HostState>>,
    input: Option<mpsc::Sender<Input>>,
    interrupt: Interrupt,
    pointer: Option<(f64, f64)>,
    limit: Option<u64>,
    presented: u64,
    snapshots: u64,
    deadline: Option<Instant>,
    stopped: bool,
    error: Option<String>,
}

impl App {
    fn stop(&mut self, error: Option<String>) {
        if self.error.is_none() {
            self.error = error;
        }
        self.deadline = None;
        if let Some(state) = &self.state {
            state.send_modify(|state| state.close = true);
        }
        if let Some(interrupt) = self.interrupt.lock().unwrap().as_ref() {
            interrupt.terminate_execution();
        }
    }

    fn input(&mut self, kind: &'static str, key: String, button: i32) {
        if self
            .state
            .as_ref()
            .is_some_and(|state| state.borrow().close)
        {
            return;
        }
        let (x, y) = self.pointer.unwrap_or_default();
        if let Some(sender) = &self.input
            && let Err(mpsc::error::TrySendError::Full(_)) = sender.try_send(Input {
                kind,
                x,
                y,
                button,
                key,
            })
        {
            self.stop(Some("native DOM input queue is full".into()));
        }
        // A closed receiver is followed by Stopped, which carries the worker's
        // result. Do not replace that cause with a secondary channel error.
    }

    fn viewport(&mut self) {
        self.input("pointerreset", String::new(), 0);
        self.pointer = None;
        if let (Some(window), Some(state)) = (&self.window, &self.state) {
            let size = window.inner_size();
            state.send_modify(|state| {
                state.width = size.width;
                state.height = size.height;
                state.scale = window.scale_factor();
            });
            window.request_redraw();
        }
    }

    fn start(&mut self, event_loop: &ActiveEventLoop) -> Result<()> {
        let options = self.options.take().ok_or("window already started")?;
        self.limit = options.frames;
        let window = Arc::new(
            event_loop.create_window(
                Window::default_attributes()
                    .with_title("3JSN · HTML + Three.js · Native Metal")
                    .with_inner_size(LogicalSize::new(960.0, 640.0)),
            )?,
        );
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::METAL,
            flags: wgpu::InstanceFlags::VALIDATION,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        // The surface keeps an Arc to its main-thread-created window until the
        // worker has released every acquired image and disposed its JS realm.
        let surface = instance.create_surface(window.clone())?;
        let size = window.inner_size();
        let (state, receiver) = watch::channel(HostState {
            width: size.width.max(1),
            height: size.height.max(1),
            scale: window.scale_factor(),
            visible: true,
            redraw: 0,
            present: 0,
            close: false,
        });
        let (input, events) = mpsc::channel(128);
        let proxy = self.proxy.clone();
        let worker = Worker {
            html: options.html,
            module: options.module,
            font: options.font,
            instance,
            surface,
            state: receiver,
            input: events,
            proxy: proxy.clone(),
            interrupt: self.interrupt.clone(),
        };
        self.worker = Some(std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_time()
                    .build()
                    .map_err(|error| error.to_string())?
                    .block_on(window_runtime::run(worker))
            }))
            .unwrap_or_else(|_| Err("DOM window worker panicked".into()));
            let _ = proxy.send_event(HostEvent::Stopped(result));
        }));
        self.window = Some(window);
        self.state = Some(state);
        self.input = Some(input);
        Ok(())
    }
}

impl ApplicationHandler<HostEvent> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_none() {
            if let Err(error) = self.start(event_loop) {
                self.error = Some(error.to_string());
                event_loop.exit();
            }
        } else if let Some(state) = &self.state {
            state.send_modify(|state| state.visible = true);
            self.viewport();
        }
    }

    fn suspended(&mut self, _event_loop: &ActiveEventLoop) {
        if let Some(state) = &self.state {
            state.send_modify(|state| state.visible = false);
        }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: HostEvent) {
        match event {
            HostEvent::Ready => {
                if let Some(window) = &self.window {
                    window.request_redraw();
                }
            }
            HostEvent::Prepared(id) => {
                if let (Some(window), Some(state)) = (&self.window, &self.state) {
                    window.pre_present_notify();
                    state.send_modify(|state| state.present = id);
                }
            }
            HostEvent::Presented(frames) => {
                self.presented = frames;
                if self.limit.is_some_and(|limit| frames >= limit) {
                    self.stop(None);
                } else if let Some(window) = &self.window {
                    window.request_redraw();
                }
            }
            HostEvent::Stopped(result) => {
                self.stopped = true;
                match result {
                    Ok((frames, snapshots)) => {
                        self.presented = self.presented.max(frames);
                        self.snapshots = snapshots;
                    }
                    Err(error) => {
                        if self.error.is_none() {
                            self.error = Some(error);
                        }
                    }
                }
                event_loop.exit();
            }
        }
    }

    fn window_event(&mut self, _event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => self.stop(None),
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => self.viewport(),
            WindowEvent::Occluded(occluded) => {
                if let Some(state) = &self.state {
                    state.send_modify(|state| state.visible = !occluded);
                }
                if !occluded && let Some(window) = &self.window {
                    window.request_redraw();
                }
            }
            WindowEvent::RedrawRequested => {
                if let Some(state) = &self.state {
                    state.send_modify(|state| state.redraw = state.redraw.wrapping_add(1));
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                if let Some(window) = &self.window {
                    self.pointer = Some((
                        position.x / window.scale_factor(),
                        position.y / window.scale_factor(),
                    ));
                }
                self.input("mousemove", String::new(), 0);
            }
            WindowEvent::CursorLeft { .. } => {
                self.input("pointerreset", String::new(), 0);
                self.pointer = None;
            }
            WindowEvent::MouseInput {
                state,
                button: MouseButton::Left,
                ..
            } if self.pointer.is_some() => {
                if state == ElementState::Pressed {
                    self.input("mousedown", String::new(), 0);
                } else {
                    self.input("mouseup", String::new(), 0);
                }
            }
            WindowEvent::KeyboardInput {
                event,
                is_synthetic: false,
                ..
            } => {
                let key = match event.logical_key {
                    Key::Character(key) => Some(key.to_string()),
                    Key::Named(NamedKey::Space) => Some(" ".into()),
                    _ => None,
                };
                if let Some(key) = key {
                    self.input(
                        if event.state == ElementState::Pressed {
                            "keydown"
                        } else {
                            "keyup"
                        },
                        key,
                        0,
                    );
                }
            }
            WindowEvent::Focused(focused) => {
                self.input(if focused { "focus" } else { "blur" }, String::new(), 0);
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            self.stop(Some("DOM window frame budget timed out".into()));
        }
        event_loop.set_control_flow(
            self.deadline
                .map_or(ControlFlow::Wait, ControlFlow::WaitUntil),
        );
    }
}
