use std::error::Error;

#[cfg(test)]
mod inline_font_width_tests;

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
mod package_resources;
mod painter;
mod window_app;
mod window_options;
mod window_runtime;
mod window_scene;

use window_options::Command;
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
    window_app::run(options)
}
