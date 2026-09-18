//! The public animated demo exercised without a window or presentation surface.
use super::*;

deno_core::extension!(demo_scheduler, deps = [webgl_dom_backend]);

fn scheduler() -> deno_core::Extension {
    let mut extension = demo_scheduler::init();
    extension.esm_files = vec![
        deno_core::ExtensionFileSource::new(
            "ext:demo_scheduler/animation.js",
            deno_core::ascii_str_include!("../../../../crates/runtime/src/animation.js"),
        ),
        deno_core::ExtensionFileSource::new(
            "ext:demo_scheduler/scheduler.js",
            deno_core::ascii_str_include!("demo_scheduler.js"),
        ),
    ]
    .into();
    extension.esm_entry_point = Some("ext:demo_scheduler/scheduler.js");
    extension
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "Requires Metal, pinned ANGLE, compiled public demo and font; no window is created"]
async fn animated_three_demo_offscreen() -> Result<()> {
    let manifest = std::env::var_os("THREEJS_NATIVE_DEMO_PACKAGE");
    let (font, ui, libraries, module, script) = if let Some(manifest) = &manifest {
        use threejs_native_package::{
            HtmlParserMode, NATIVE_WEBGL_CAPABILITY, Profile, load_for_with_capabilities,
        };
        let mode = if cfg!(feature = "dynamic-html") {
            HtmlParserMode::Preserved
        } else {
            HtmlParserMode::Restricted
        };
        let app = load_for_with_capabilities(
            Path::new(manifest),
            Profile::CompiledDomWindow(mode),
            &[NATIVE_WEBGL_CAPABILITY],
        )?;
        ensure(
            app.resources.is_none(),
            "this packaged fixture does not exercise webfonts",
        )?;
        (
            app.font.ok_or("package font missing")?,
            app.compiled_ui.ok_or("package UI missing")?.bytes,
            app.native_webgl.ok_or("package ANGLE missing")?,
            Some(app.entry),
            None,
        )
    } else {
        let font = std::fs::read(std::env::var("THREEJS_NATIVE_COMPOSITION_FONT")?)?;
        let ui = std::fs::read(std::env::var("THREEJS_NATIVE_DEMO_UI")?)?;
        let script = std::fs::read_to_string(std::env::var("THREEJS_NATIVE_DEMO_SCRIPT")?)?;
        let package = std::path::PathBuf::from(std::env::var("THREEJS_NATIVE_ANGLE_PACKAGE")?);
        (
            font,
            ui,
            package.join("deps/darwin/dylib"),
            None,
            Some(script),
        )
    };
    let config = DocumentConfig {
        font_ctx: Some(blitz_dom::build_single_font_ctx(&font)),
        viewport: Some(Viewport::new(960, 640, 1.0, ColorScheme::Light)),
        ..Default::default()
    };
    #[cfg(feature = "dynamic-html")]
    let loaded = threejs_compiled_ui_experiment::load_json(&ui, config)?;
    #[cfg(not(feature = "dynamic-html"))]
    let loaded = threejs_compiled_ui_experiment::load_json_restricted(&ui, config)?;
    let mut runtime = host::create_with_dom_extension(
        dom_bridge::extension_with_document(loaded.document),
        vec![
            threejs_native_webgl_runtime::runtime_extension(&libraries)?,
            webgl_backend::extension(),
            scheduler(),
        ],
        threejs_native_js_sources::embed_extension_sources,
    );
    // Startup assertions also pass through the same explicit teardown path.
    let mut painter: Option<painter::Painter> = None;
    let mut registration = None;
    let mut generation = None;
    let outcome = async {
        if let Some(module) = &module {
            host::load(&mut runtime, module).await?;
        } else {
            runtime.execute_script("demo:unchanged-bundle", script.ok_or("demo script missing")?)?;
        }
        let mut canvas = webgl_backend::find(&mut runtime, "scene")?.ok_or("demo canvas missing")?;
        let initial_node = canvas.node_key().to_owned();
        let initial_context = canvas.context_id();
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::METAL,
            flags: wgpu::InstanceFlags::VALIDATION,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let mut lease = threejs_native_webgl_runtime::snapshot(&mut runtime, canvas.context_id())?;
        let bridge = metal::MetalBridge::with_native_device_offscreen(&instance, lease.device_raw())?;
        lease.close()?;
        ensure(!bridge.shared_deno_queue(), "demo acquired a Deno queue")?;
        painter = Some(painter::Painter::new(bridge)?);
        let painter = painter.as_mut().ok_or("demo painter missing")?;
        let output = painter.bridge.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Public demo offscreen assertion output"),
            size: wgpu::Extent3d { width: 960, height: 640, depth_or_array_layers: 1 },
            mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let mut transitions = Vec::new();
        for frame in 1..=60 {
            runtime.execute_script("demo:frame", "__demoFrame()")?;
            let current = webgl_backend::find(&mut runtime, "scene")?.ok_or("demo canvas disappeared")?;
            if current.node_key() != canvas.node_key() {
                ensure(frame == 36, "demo replaced canvas at an unexpected frame")?;
                ensure(current.context_id() != initial_context, "replacement reused native context")?;
                canvas.retire()?;
                canvas = current;
            }
            let previous = generation.clone();
            let report = compose_any(&mut runtime, painter, &canvas, &output, &mut registration, &mut generation)?;
            ensure(report["canvases"][0]["contentSize"] == serde_json::json!({"width":904.0,"height":400.0}), "demo CSS canvas size changed")?;
            if previous != generation {
                transitions.push(frame);
                if let (Some(old), Some(new)) = (&previous, &generation) {
                    if frame == 36 {
                        ensure(new.0 != old.0 && new.0 != initial_node, "replacement retained native node identity")?;
                    } else {
                        ensure(new.0 == old.0 && new.1 > old.1, "bitmap reset did not advance native generation")?;
                    }
                }
            }
        }
        ensure(transitions == [1, 12, 24, 36], "unexpected native snapshot generation transitions")?;
        let checkpoints: Vec<serde_json::Value> = host::evaluate(&mut runtime, "__demoCheckpoints".into()).await?;
        ensure(checkpoints.len() == 5, "demo did not emit five checkpoints")?;
        for (index, (phase, frame)) in [("First frame",1), ("Bitmap resized",12), ("Same-width reset",24), ("Canvas replaced",36), ("Lifecycle complete",60)].into_iter().enumerate() {
            let item = &checkpoints[index];
            ensure(item["phase"] == phase && item["frame"] == frame, "demo checkpoint sequence changed")?;
            ensure(item["contextIdentity"] == true && item["connected"] == true && item["contextLost"] == false, "demo context contract failed")?;
            let scale = if index == 0 { 1.0 } else { 1.25 };
            ensure(item["bitmap"] == serde_json::json!({"width":(904.0_f64*scale).round() as u32,"height":(400.0_f64*scale).round() as u32}), "demo bitmap dimensions changed")?;
            ensure(item["generation"] == if index < 3 { 1 } else { 2 }, "demo generation report changed")?;
            if index >= 3 { ensure(item["replacementContextDistinct"] == true, "replacement did not report distinct context")?; }
        }
        if let Some(path) = std::env::var_os("THREEJS_NATIVE_DEMO_CAPTURE") {
            window_capture::save(&painter.bridge, &output, Path::new(&path))?;
        }
        runtime.execute_script("demo:pagehide", "dispatchEvent(new Event('pagehide'))")?;
        ensure(host::evaluate::<bool>(&mut runtime, "__demoStopped()".into()).await?, "pagehide left animation scheduled")?;
        Ok::<_, Box<dyn Error>>(())
    }.await;
    let cleanup = (|| -> Result<()> {
        if let Some(painter) = painter.as_mut() {
            painter.drain()?;
            if let Some(image) = registration.take() {
                painter.unregister_canvas(image)?;
            }
            painter.check_errors()?;
        }
        webgl_backend::release_all(&mut runtime)?;
        dom_bridge::release(&mut runtime);
        threejs_native_webgl_runtime::release_all(&mut runtime)?;
        Ok(())
    })();
    if let Err(error) = cleanup {
        std::mem::forget(painter);
        std::mem::forget(runtime);
        return Err(format!("demo cleanup failed: {error}; assertions: {outcome:?}").into());
    }
    outcome?;
    println!(
        "{}",
        serde_json::json!({"webglDemoOffscreen": {
            "packagedInputs":manifest.is_some(),"frames":60,"checkpoints":5,"snapshotGenerations":4,"canvasContexts":2,
            "cleanup":"passed","surfacePresentation":false,"cpuFrameTransport":false,
        "htmlParser": if cfg!(feature = "dynamic-html") { "preserved" } else { "omitted" }
        }})
    );
    Ok(())
}
