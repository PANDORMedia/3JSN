use std::{error::Error, path::Path, time::Instant};

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
#[path = "../../dom-canvas/src/window_app.rs"]
mod window_app;
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
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.as_slice() == ["--describe"] {
        println!(
            "{}",
            serde_json::json!({"experiment":"compiled-ui-runtime", "target":threejs_native_package::target(),
            "dynamicHtml":cfg!(feature="dynamic-html"), "packageProfiles":[], "backend":"Metal"})
        );
        return Ok(());
    }
    if let [flag, ui, font, behavior, rest @ ..] = args.as_slice()
        && flag == "--measure-layout"
    {
        let verify = match rest {
            [] => false,
            [flag] if flag == "--verify" => true,
            _ => return Err(window_options::USAGE.into()),
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()?;
        return runtime.block_on(measure_layout(
            started,
            Path::new(ui),
            Path::new(font),
            Path::new(behavior),
            verify,
        ));
    }
    window_app::run(window_options::window(&args)?)
}

async fn measure_layout(
    started: Instant,
    ui: &Path,
    font: &Path,
    behavior: &Path,
    verify: bool,
) -> Result<()> {
    use blitz_traits::shell::{ColorScheme, Viewport};
    let resources =
        package_resources::PackageResources::new(package_resources::PACKAGE_BASE_URL, vec![])?;
    let document = window_options::input(ui)?.into_dom(blitz_dom::DocumentConfig {
        font_ctx: Some(blitz_dom::build_single_font_ctx(&std::fs::read(font)?)),
        viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
        defer_font_loads: true,
        base_url: Some(resources.base_url().into()),
        net_provider: Some(resources.clone()),
        ..Default::default()
    })?;
    let mut runtime = host::create_with_dom_extension(
        document,
        vec![],
        threejs_native_js_sources::embed_extension_sources,
    );
    dom_bridge::with_document(&mut runtime, |doc| -> Result<()> {
        resources.drain(doc)?;
        doc.load_web_fonts()?;
        resources.finish_initial_load(doc)?;
        doc.check_web_fonts()?;
        Ok(())
    })?;
    runtime.execute_script("probe:behavior", std::fs::read_to_string(behavior)?)?;
    let initial: serde_json::Value =
        host::evaluate(&mut runtime, "uiProbe.snapshot()".into()).await?;
    let initialization_ns = started.elapsed().as_nanos();
    let verification: Option<serde_json::Value> = if verify {
        Some(
            host::evaluate(
                &mut runtime,
                format!("uiProbe.verify({})", cfg!(feature = "dynamic-html")),
            )
            .await?,
        )
    } else {
        None
    };
    println!(
        "{}",
        serde_json::json!({"layoutMeasurement":true,"dynamicHtml":cfg!(feature="dynamic-html"),
        "initializationNanoseconds":initialization_ns,"initial":initial,"verification":verification,
        "gpuDeviceRequested":false,"metric":"main entry through IR, font, realm initialization and first layout snapshot"})
    );
    Ok(())
}
