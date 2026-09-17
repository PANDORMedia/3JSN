use std::{error::Error, fs, path::Path};

use blitz_dom::DocumentConfig;
use blitz_traits::shell::{ColorScheme, Viewport};
use serde_json::{Value, json};

#[allow(
    dead_code,
    reason = "Reuse the prior DOM adapter, excluding its standalone entry point."
)]
mod dom_bridge;
mod evidence;
mod host;
mod metal;
mod painter;

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const HTML: &str = include_str!("../fixture.html");
const ORIGINAL: &str = include_str!("../../../docs/investigations/html-dom/fixture.js");

fn check(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 3 {
        return Err("usage: native-html-interop <font> <bundled-app> <output-directory>".into());
    }
    let font = fs::read(&args[0])?;
    check(
        evidence::sha256(&font)
            == "a75044e4dab293c1ac7f8eba9f20df03f183f41b9319054f43b955959981632a",
        "unexpected font input",
    )?;
    let output = Path::new(&args[2]);
    fs::create_dir_all(output)?;
    let mut runtime = host::create(
        HTML,
        DocumentConfig {
            font_ctx: Some(blitz_dom::build_single_font_ctx(&font)),
            viewport: Some(Viewport::new(384, 192, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    );
    runtime.execute_script("probe:original-dom", ORIGINAL)?;
    runtime.execute_script(
        "probe:original-frames",
        "__advanceProbeFrame(100); __advanceProbeFrame(116.6666666667);",
    )?;
    let observations = dom_bridge::take_messages(&mut runtime);
    let observed = observations
        .first()
        .ok_or("original fixture produced no observations")?;
    for key in [
        "identity",
        "mutation",
        "detachedIdentity",
        "classListSameObject",
        "inputPrototype",
    ] {
        check(
            observed[key] == true,
            &format!("original fixture failed: {key}"),
        )?;
    }
    check(
        observed["geometry"] == json!([120, 240]),
        "original geometry differs",
    )?;
    check(
        observed["eventOrder"] == json!(["capture", "target", "bubble"]),
        "original event order differs",
    )?;
    runtime.execute_script("probe:dom-events", include_str!("../events.js"))?;
    let event_observations = dom_bridge::take_messages(&mut runtime);
    host::load(&mut runtime, Path::new(&args[1])).await?;
    let device_info: Value = host::evaluate(&mut runtime, "probe.info".into()).await?;
    let bridge = host::with_device(&mut runtime, |device| {
        metal::MetalBridge::new(device.instance.clone(), device.id, device.queue)
    })?;
    let mut painter = painter::Painter::new(bridge)?;
    let mut generations: Vec<Value> = vec![];
    for (generation, (width, height)) in [(384, 192), (512, 256), (384, 192), (448, 224)]
        .into_iter()
        .enumerate()
    {
        let result = run_generation(
            &mut runtime,
            &mut painter,
            output,
            generation,
            width,
            height,
        )
        .await?;
        if generation == 2 {
            for capture in 0..2 {
                check(
                    result["captures"][capture]["pixels"]["rgbaSha256"]
                        == generations[0]["captures"][capture]["pixels"]["rgbaSha256"],
                    "returning to the original size did not reproduce all three image planes",
                )?;
            }
        }
        generations.push(result);
    }
    painter.bridge.drain()?;
    painter.check_errors()?;
    drop(painter);
    let errors: Value = host::evaluate(&mut runtime, "probe.errors".into()).await?;
    check(errors == json!([]), "Deno GPU errors at teardown")?;
    host::evaluate::<()>(&mut runtime, "probe.device.destroy()".into()).await?;
    drop(runtime);
    let report = json!({
        "status":"pass", "fixture":"same-realm-three-dom-shared-metal-queue",
        "device":device_info,"v8":deno_core::v8::V8::get_version(),
        "nativeDeviceIdentityChecked":true,"nativeQueueIdentityChecked":true,
        "wgpuValidation":true,"velloUseCpu":false,"cpuImageTransport":false,
        "frames":32,"generations":generations,"originalFixtureMessages":observations,"domEventMessages":event_observations,
        "inputs":{"htmlSha256":evidence::sha256(HTML.as_bytes()),"originalFixtureSha256":evidence::sha256(ORIGINAL.as_bytes()),"fontSha256":evidence::sha256(&font)},
        "validationErrors":errors,
        "limits":["Metal-only offscreen experiment; no native presentation, hardware input or timing claim.",
        "Two core registries retain the same native device and queue; resource IDs are never mixed.",
        "Initialization waits once per texture generation; final assertion readbacks twice per generation. No pixel upload/copy through CPU between rendering and composition.",
        "Bounded DOM/CSS adapter. No Window propagation, shadow DOM, full HTML conformance or CtF certification.",
        "Three.js shared scene is unchanged; fixture host supplies offscreen canvas and manual frame timestamps.",
        "Research executable requires source checkout; this does not validate standalone packaging."]
    });
    let serialized = serde_json::to_string_pretty(&report)?;
    fs::write(output.join("report.json"), &serialized)?;
    println!("{serialized}");
    Ok(())
}

async fn run_generation(
    runtime: &mut deno_core::JsRuntime,
    painter: &mut painter::Painter,
    output: &Path,
    generation: usize,
    width: u32,
    height: u32,
) -> Result<Value> {
    let descriptor = wgpu::TextureDescriptor {
        label: Some("shared initialized HTML texture"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    };
    let texture = painter.bridge.device.create_texture(&descriptor);
    let outcome: Result<Value> = async {
        painter.render(&vello::Scene::new(), &texture)?;
        painter.drain()?;
        let mut mismatched = descriptor.clone();
        mismatched.size.width += 1;
        // SAFETY: initialization completed above; descriptor validation must
        // reject this before an alias is registered. Clean any unexpected ID.
        match unsafe { painter.bridge.import_texture_to_deno(&texture, &mismatched) } {
            Ok(id) => {
                host::with_device(runtime, |device| { device.instance.texture_drop(id); Ok(()) })?;
                return Err("mismatched import descriptor was accepted".into());
            }
            Err(error) => check(error.to_string() == "import descriptor disagrees with wrapper texture", "wrong import rejection")?,
        }
        // SAFETY: a completed Vello clear initialized every pixel. The source is
        // retained through the final mapAsync, which follows all shared-queue
        // submissions. Each producer submits before the other registry is used.
        unsafe {
            host::expose_texture(runtime, &painter.bridge, &texture, &descriptor)?;
        }
        host::evaluate::<()>(
            runtime,
            format!("probe.beginGeneration({width}, {height})"),
        )
        .await?;
        let mut first: Option<Vec<u8>> = None;
        let mut captures = vec![];
        for frame in 0..8 {
            let green = frame >= 4;
            let color = if green {
                "rgba(32, 160, 96, 0.5)"
            } else {
                "rgba(200, 40, 60, 0.5)"
            };
            host::evaluate::<()>(runtime, format!(
                "document.getElementById('root').style.background = '{color}'; probe.renderGame({});",
                0.2 + frame as f64 * 0.15,
            )).await?;
            // Flush pending Deno writes before a producer from the other
            // registry submits to the same queue. This does not wait on the CPU.
            host::with_device(runtime, |device| {
                device
                    .instance
                    .queue_submit(device.queue, &[])
                    .map_err(|error| format!("Deno queue flush: {error:?}"))?;
                Ok(())
            })?;
            let layout = painter.paint(runtime, &texture)?;
            host::evaluate::<()>(runtime, "probe.compose()".into()).await?;
            if generation == 0 && frame == 1 && std::env::var_os("THREEJS_NATIVE_INTEROP_INJECT_FAILURE").is_some() {
                return Err("EXPECTED_FAILURE_AFTER_SUBMIT".into());
            }
            if frame == 3 || frame == 7 {
                let pixels: Vec<u8> =
                    host::evaluate(runtime, "probe.capture()".into()).await?;
                painter.check_errors()?;
                let report = evidence::verify(&pixels, width, height, green)?;
                check(
                    layout["root"]["width"] == 240.0 && layout["glyphs"] == 8,
                    "DOM paint geometry/text changed",
                )?;
                let file = format!("generation-{generation}-frame-{frame}.png");
                evidence::save(&output.join(&file), &pixels, width, height)?;
                let changed = if let Some(first) = &first {
                    let changed = evidence::changed_game_pixels(first, &pixels, width, height);
                    check(
                        changed > 1000,
                        "Three.js animation did not change the sampled texture",
                    )?;
                    Some(changed)
                } else {
                    first = Some(pixels);
                    None
                };
                captures.push(json!({"frame":frame,"file":file,"pixels":report,"layout":layout,"changedGamePixels":changed}));
            }
        }
        Ok(json!({"generation":generation,"width":width,"height":height,"frames":8,"captures":captures,"descriptorMismatchRejected":true}))
    }.await;
    // Shared aliases outlive the fallible body. Drain both registries on success
    // and error, before either owner can release the native resource.
    if let Err(error) = painter.bridge.drain() {
        // Completion is unknown. Preserve this native retain until process exit
        // rather than releasing a resource potentially used by the other core.
        std::mem::forget(texture);
        return Err(format!("generation result: {outcome:?}; GPU cleanup failed: {error}").into());
    }
    let cleanup = host::evaluate::<()>(runtime, "probe.endGeneration()".into()).await;
    if let Err(error) = painter.bridge.drain() {
        std::mem::forget(texture);
        return Err(
            format!("generation result: {outcome:?}; final GPU cleanup failed: {error}").into(),
        );
    }
    texture.destroy();
    cleanup?;
    painter.check_errors()?;
    let errors: Value = host::evaluate(runtime, "probe.errors".into()).await?;
    check(
        errors == json!([]),
        "Deno GPU errors during generation cleanup",
    )?;
    outcome.map_err(|error| format!("{error}; shared GPU cleanup completed").into())
}
