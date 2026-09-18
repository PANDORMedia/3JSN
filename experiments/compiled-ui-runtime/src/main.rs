use std::{error::Error, time::Instant};

#[path = "../../dom-canvas/src/canvas_init.rs"]
mod canvas_init;
#[path = "../../dom-canvas/src/canvas_texture.rs"]
mod canvas_texture;
#[allow(
    dead_code,
    reason = "Share native canvas operations with the interpreted player."
)]
mod dom_bridge;
#[allow(
    dead_code,
    reason = "Share native realm and GPU initialization with the interpreted player."
)]
#[path = "../../native-html-interop/src/host_core.rs"]
mod host;
mod measure;
#[allow(
    dead_code,
    reason = "The window uses only canvas-to-compositor transport."
)]
#[path = "../../native-html-interop/src/metal.rs"]
mod metal;
#[path = "../../dom-canvas/src/package_resources.rs"]
mod package_resources;
#[path = "../../dom-canvas/src/painter.rs"]
mod painter;
#[cfg(feature = "native-webgl")]
mod webgl_backend;
#[path = "../../dom-canvas/src/window_app.rs"]
mod window_app;
#[path = "../../dom-canvas/src/window_capture.rs"]
mod window_capture;
#[path = "../../dom-canvas/src/window_input.rs"]
mod window_input;
mod window_options;
#[path = "../../dom-canvas/src/window_runtime.rs"]
mod window_runtime;
#[path = "../../dom-canvas/src/window_scene.rs"]
mod window_scene;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn main() -> std::process::ExitCode {
    let started = Instant::now();
    match run(started) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("3JSN compiled UI experiment: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn run(started: Instant) -> Result<()> {
    use window_options::Command;

    let args: Vec<_> = std::env::args_os().skip(1).collect();
    match window_options::parse(&args, &std::env::current_exe()?)? {
        Command::Describe => {
            println!("{}", window_options::description());
            Ok(())
        }
        Command::Verified => {
            println!("{{\"packageVerified\":true}}");
            Ok(())
        }
        Command::Run(options) => window_app::run(options),
        Command::Measure(options) => tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()?
            .block_on(measure::run(started, options)),
    }
}
