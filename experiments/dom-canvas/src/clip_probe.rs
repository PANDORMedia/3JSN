use std::{error::Error, fs, io::BufWriter, path::Path};

use blitz_dom::DocumentConfig;
use blitz_traits::shell::{ColorScheme, Viewport};
use serde::Deserialize;
use serde_json::{Value, json};

#[allow(
    dead_code,
    reason = "Reuse the existing DOM realm without its canvas scenarios."
)]
mod dom_bridge;
#[allow(
    dead_code,
    reason = "Reuse bounded readback and hashing, not fixed-size caption checks."
)]
mod evidence;
#[allow(
    dead_code,
    reason = "Reuse the native realm and device helpers, not texture import."
)]
#[path = "../../native-html-interop/src/host.rs"]
mod host;
#[allow(
    dead_code,
    reason = "Reuse the verified same-device/queue bridge, not reverse texture import."
)]
#[path = "../../native-html-interop/src/metal.rs"]
mod metal;
#[allow(
    dead_code,
    reason = "Use the same painter for ordinary HTML without canvas registrations."
)]
mod painter;

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const CSS_WIDTH: u32 = 448;
const CSS_HEIGHT: u32 = 256;

#[derive(Deserialize)]
struct Case {
    name: String,
    #[serde(default = "default_scale")]
    scale: f32,
    #[serde(default, rename = "subjectColor", deserialize_with = "subject_color")]
    subject_color: Option<[u8; 4]>,
}

fn subject_color<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<[u8; 4]>, D::Error> {
    let channels = <[f64; 4]>::deserialize(deserializer)?;
    if !channels.iter().all(|channel| {
        channel.is_finite() && (0.0..=255.0).contains(channel) && channel.fract() == 0.0
    }) {
        return Err(serde::de::Error::custom(
            "subjectColor must contain four integer RGBA channels in 0..255",
        ));
    }
    Ok(Some(channels.map(|channel| channel as u8)))
}

fn default_scale() -> f32 {
    1.0
}

fn check(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}

fn dimensions(case: &Case, max_dimension: u32) -> Result<(u32, u32)> {
    let width = f64::from(CSS_WIDTH) * f64::from(case.scale);
    let height = f64::from(CSS_HEIGHT) * f64::from(case.scale);
    check(
        !case.name.is_empty()
            && case.scale.is_finite()
            && case.scale > 0.0
            && [width, height].iter().all(|size| {
                *size >= 1.0 && *size <= f64::from(max_dimension) && size.fract() == 0.0
            }),
        "case requires a name and a positive scale yielding integral supported output dimensions",
    )?;
    Ok((width as u32, height as u32))
}

fn save_png(path: &Path, pixels: &[u8], width: u32, height: u32) -> Result<()> {
    check(
        pixels.len() as u64 == u64::from(width) * u64::from(height) * 4,
        "readback size differs from the requested RGBA8 output",
    )?;
    let mut encoder = png::Encoder::new(BufWriter::new(fs::File::create(path)?), width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header()?.write_image_data(pixels)?;
    Ok(())
}

const BOOTSTRAP: &str = r#"
(async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Hardware GPU required');
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  globalThis.probe = { device, errors };
  return {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    device: adapter.info.device,
    description: adapter.info.description,
    isFallbackAdapter: adapter.info.isFallbackAdapter
  };
})()
"#;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 4 {
        return Err("usage: clip-probe <html-file> <script-file> <cases-json> <output-dir>".into());
    }
    let html = fs::read_to_string(&args[0])?;
    let script = fs::read_to_string(&args[1])?;
    let cases_bytes = fs::read(&args[2])?;
    let cases: Vec<Case> = serde_json::from_slice(&cases_bytes)?;
    check(!cases.is_empty(), "at least one clipping case is required")?;
    let output = Path::new(&args[3]);
    fs::create_dir_all(output)?;
    let mut runtime = host::create(
        &html,
        DocumentConfig {
            viewport: Some(Viewport::new(
                CSS_WIDTH,
                CSS_HEIGHT,
                1.0,
                ColorScheme::Light,
            )),
            ..Default::default()
        },
    );
    let mut painter = None;
    let mut target = None;
    let mut device_created = false;
    let outcome: Result<Value> = async {
        let device: Value = host::evaluate(&mut runtime, BOOTSTRAP.into()).await?;
        device_created = true;
        let bridge = host::with_device(&mut runtime, |device| {
            metal::MetalBridge::new(device.instance.clone(), device.id, device.queue)
        })?;
        painter = Some(painter::Painter::new(bridge)?);
        runtime.execute_script("probe:clip-fixture", script.clone())?;
        check(
            host::evaluate::<bool>(
                &mut runtime,
                "typeof globalThis.clipFixture?.prepare === 'function'".into(),
            )
            .await?,
            "script must provide global clipFixture.prepare(caseName)",
        )?;
        let owner = painter.as_mut().unwrap();
        let mut captures = Vec::with_capacity(cases.len());
        for (index, case) in cases.iter().enumerate() {
            let (width, height) = dimensions(case, owner.bridge.device.limits().max_texture_dimension_2d)?;
            host::evaluate::<()>(
                &mut runtime,
                format!(
                    "(async () => {{ await clipFixture.prepare({}); }})()",
                    serde_json::to_string(&case.name)?
                ),
            )
            .await?;
            target = Some(owner.bridge.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Ordinary HTML clipping evidence"),
                size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            }));
            let image = target.as_ref().unwrap();
            let (paint, layout) = dom_bridge::with_document(&mut runtime, |doc| -> Result<_> {
                doc.set_viewport(Viewport::new(width, height, case.scale, ColorScheme::Light));
                let paint = owner.paint(doc, image)?;
                let mut layout = serde_json::Map::new();
                // Read the layout that produced these pixels. The JS geometry
                // accessor resolves again and would change the evidence boundary.
                for id in ["outer", "middle", "subject"] {
                    let node = doc.get_element_by_id(id).ok_or_else(|| format!("missing #{id}"))?;
                    let rect = doc.get_client_bounding_rect(node).ok_or_else(|| format!("missing layout for #{id}"))?;
                    layout.insert(id.into(), json!({
                        "x":rect.x,"y":rect.y,"width":rect.width,"height":rect.height,
                        "top":rect.y,"left":rect.x,"right":rect.x+rect.width,"bottom":rect.y+rect.height
                    }));
                }
                Ok((paint, Value::Object(layout)))
            })?;
            let pixels = evidence::read(&owner.bridge, image)?;
            owner.bridge.drain()?;
            owner.check_errors()?;
            let gpu_errors: Value = host::evaluate(&mut runtime, "probe.errors".into()).await?;
            check(gpu_errors == json!([]), &format!("Deno GPU errors: {gpu_errors}"))?;
            let file = format!("{index:03}-case.png");
            save_png(&output.join(&file), &pixels, width, height)?;
            let mut capture = json!({
                "name":case.name,"scale":case.scale,"width":width,"height":height,
                "layout":layout,"paint":paint,"paintCalls":1,"gpuErrors":gpu_errors,
                "pixelSha256":evidence::sha256(&pixels),"file":file
            });
            if let Some(color) = case.subject_color {
                capture["subjectColor"] = json!(color);
            }
            captures.push(capture);
            target.take().unwrap().destroy();
        }
        Ok(json!({
            "status":"captured","fixture":"ordinary-html-clipping","backend":"Metal",
            "offscreen":true,"device":device,"v8":deno_core::v8::V8::get_version(),
            "cssViewport":{"width":CSS_WIDTH,"height":CSS_HEIGHT},"cases":captures,
            "inputs":{"htmlSha256":evidence::sha256(html.as_bytes()),
                "scriptSha256":evidence::sha256(script.as_bytes()),"casesSha256":evidence::sha256(&cases_bytes)},
            "nativeDeviceIdentityChecked":true,"nativeQueueIdentityChecked":true,
            "cpuReadbackPurpose":"verification PNGs only",
            "limits":["Metal-only offscreen captures; no visible presentation or performance claim.",
                "Browser comparison is a separate step; capture completion is not a compatibility pass.",
                "Ordinary box fixtures with no font or text requirements; bounded existing DOM adapter."]
        }))
    }.await;

    let mut cleanup_errors = Vec::new();
    if let Some(owner) = &painter {
        // Retain every owner on a failed drain: shared native aliases must not
        // be released while either registry may still be using them.
        if let Err(error) = owner.bridge.drain() {
            std::mem::forget(target);
            std::mem::forget(painter);
            std::mem::forget(runtime);
            return Err(format!("probe result: {outcome:?}; GPU cleanup failed: {error}").into());
        }
        if let Err(error) = owner.check_errors() {
            cleanup_errors.push(error.to_string());
        }
    }
    if let Some(image) = target.take() {
        image.destroy();
    }
    dom_bridge::release(&mut runtime);
    drop(painter);
    if device_created {
        match host::evaluate::<Value>(&mut runtime, "probe.errors".into()).await {
            Ok(errors) if errors == json!([]) => {}
            Ok(errors) => cleanup_errors.push(format!("Deno GPU errors at teardown: {errors}")),
            Err(error) => cleanup_errors.push(error.to_string()),
        }
        if let Err(error) =
            host::evaluate::<()>(&mut runtime, "probe.device.destroy()".into()).await
        {
            cleanup_errors.push(error.to_string());
        }
    }
    check(
        cleanup_errors.is_empty(),
        &format!("probe result: {outcome:?}; cleanup errors: {cleanup_errors:?}"),
    )?;
    let report = outcome.map_err(|error| format!("{error}; shared GPU cleanup completed"))?;
    let serialized = serde_json::to_string_pretty(&report)?;
    fs::write(output.join("report.json"), &serialized)?;
    println!("{serialized}");
    Ok(())
}
