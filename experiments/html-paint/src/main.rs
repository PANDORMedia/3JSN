use std::{
    error::Error,
    fs,
    io::BufWriter,
    num::NonZeroUsize,
    path::Path,
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};

use anyrender_vello::VelloScenePainter;
use blitz_dom::DocumentConfig;
use blitz_traits::shell::{ColorScheme, Viewport};
use deno_core::JsRuntime;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[allow(
    dead_code,
    reason = "Reuse the prior DOM adapter, excluding its standalone entry point."
)]
mod dom_bridge;

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const HTML: &str = include_str!("../fixture.html");
const ORIGINAL_FIXTURE: &str = include_str!("../../../docs/investigations/html-dom/fixture.js");
const MUTATION: &str = include_str!("../mutate.js");
const WIDTH: u32 = 384;
const HEIGHT: u32 = 192;

fn check(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

struct Painter {
    device: wgpu::Device,
    queue: wgpu::Queue,
    renderer: vello::Renderer,
    validation: Arc<Mutex<Vec<String>>>,
}

impl Painter {
    fn new() -> Result<(Self, Value)> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::METAL,
            flags: wgpu::InstanceFlags::VALIDATION,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            force_fallback_adapter: false,
            ..Default::default()
        }))?;
        let info = adapter.get_info();
        check(
            info.backend == wgpu::Backend::Metal,
            "Expected a Metal adapter",
        )?;
        check(
            info.device_type != wgpu::DeviceType::Cpu,
            "Software adapter rejected",
        )?;
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                label: Some("3JSN isolated HTML paint"),
                ..Default::default()
            }))?;
        let validation = Arc::new(Mutex::new(Vec::new()));
        let errors = validation.clone();
        device.on_uncaptured_error(Arc::new(move |error: wgpu::Error| {
            errors.lock().unwrap().push(error.to_string());
        }));
        let renderer = vello::Renderer::new(
            &device,
            vello::RendererOptions {
                use_cpu: false,
                antialiasing_support: vello::AaSupport::area_only(),
                num_init_threads: NonZeroUsize::new(1),
                pipeline_cache: None,
            },
        )?;
        Ok((
            Self {
                device,
                queue,
                renderer,
                validation,
            },
            json!({
                "name":info.name, "backend":format!("{:?}", info.backend),
                "deviceType":format!("{:?}", info.device_type),
                "wgpuValidation":true, "velloUseCpu":false,
            }),
        ))
    }

    fn render(&mut self, scene: &vello::Scene, width: u32, height: u32) -> Result<Vec<u8>> {
        let extent = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("HTML paint output"),
            size: extent,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        self.renderer.render_to_texture(
            &self.device,
            &self.queue,
            scene,
            &view,
            &vello::RenderParams {
                base_color: vello::peniko::Color::TRANSPARENT,
                width,
                height,
                antialiasing_method: vello::AaConfig::Area,
            },
        )?;
        let row_bytes = (width * 4).div_ceil(256) * 256;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("HTML assertion readback"),
            size: u64::from(row_bytes) * u64::from(height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row_bytes),
                    rows_per_image: Some(height),
                },
            },
            extent,
        );
        self.queue.submit([encoder.finish()]);
        let (sender, receiver) = mpsc::channel();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });
        self.device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(15)),
        })?;
        receiver.recv_timeout(Duration::from_secs(5))??;
        let bytes = buffer.slice(..).get_mapped_range();
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        for row in bytes.chunks_exact(row_bytes as usize) {
            pixels.extend_from_slice(&row[..(width * 4) as usize]);
        }
        drop(bytes);
        buffer.unmap();
        buffer.destroy();
        texture.destroy();
        check(
            self.validation.lock().unwrap().is_empty(),
            "GPU validation error during HTML paint",
        )?;
        Ok(pixels)
    }
}

struct Capture {
    report: Value,
    pixels: Vec<u8>,
}

fn capture(
    runtime: &mut JsRuntime,
    painter: &mut Painter,
    name: &str,
    scale: u32,
    output: &Path,
) -> Result<Capture> {
    let width = WIDTH * scale;
    let height = HEIGHT * scale;
    let mut scene = vello::Scene::new();
    let geometry = dom_bridge::with_document(runtime, |doc| -> Result<Value> {
        doc.set_viewport(Viewport::new(
            width,
            height,
            scale as f32,
            ColorScheme::Light,
        ));
        doc.resolve(0.0);
        let mut geometry = serde_json::Map::new();
        for name in ["root", "button"] {
            let node = doc
                .get_element_by_id(name)
                .ok_or("Expected fixture element")?;
            let rect = doc
                .get_client_bounding_rect(node)
                .ok_or("Expected layout rectangle")?;
            geometry.insert(
                name.into(),
                json!({"x":rect.x,"y":rect.y,"width":rect.width,"height":rect.height}),
            );
        }
        blitz_paint::paint_scene(
            &mut VelloScenePainter::new(&mut scene),
            doc,
            scale as f64,
            width,
            height,
            0,
            0,
        );
        Ok(Value::Object(geometry))
    })?;
    let glyphs = scene.encoding().resources.glyphs.len();
    let glyph_runs = scene.encoding().resources.glyph_runs.len();
    let pixels = painter.render(&scene, width, height)?;
    let pixel = |x: u32, y: u32| -> &[u8] {
        let offset = ((y * width + x) * 4) as usize;
        &pixels[offset..offset + 4]
    };
    check(
        pixel(4 * scale, 4 * scale) == [255, 255, 255, 255],
        "White page background did not paint",
    )?;
    let white_text_pixels = (32 * scale..88 * scale)
        .flat_map(|y| {
            (32 * scale
                ..(geometry["button"]["x"].as_f64().unwrap()
                    + geometry["button"]["width"].as_f64().unwrap()) as u32
                    * scale)
                .map(move |x| (x, y))
        })
        .filter(|&(x, y)| pixel(x, y).iter().all(|channel| *channel > 235))
        .count();
    let root_sample = pixel(40 * scale, 130 * scale).to_vec();
    let expanded_sample = pixel(200 * scale, 130 * scale).to_vec();
    let file = format!("{name}.png");
    let mut encoder = png::Encoder::new(
        BufWriter::new(fs::File::create(output.join(&file))?),
        width,
        height,
    );
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header()?.write_image_data(&pixels)?;
    Ok(Capture {
        report: json!({
            "name":name,"file":file,"width":width,"height":height,"scale":scale,
            "geometry":geometry,"glyphs":glyphs,"glyphRuns":glyph_runs,
            "whiteTextPixels":white_text_pixels,"rootSample":root_sample,
            "expandedSample":expanded_sample,"rgbaSha256":sha256(&pixels),
        }),
        pixels,
    })
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err("usage: html-paint-probe <font-file> <output-directory>".into());
    }
    let font = fs::read(&args[0])?;
    let output = Path::new(&args[1]);
    fs::create_dir_all(output)?;
    let mut runtime = dom_bridge::create(
        HTML,
        DocumentConfig {
            font_ctx: Some(blitz_dom::build_single_font_ctx(&font)),
            viewport: Some(Viewport::new(WIDTH, HEIGHT, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    );
    let (mut painter, adapter) = Painter::new()?;
    let initial = capture(&mut runtime, &mut painter, "initial", 1, output)?;
    runtime.execute_script("probe:original-dom-fixture", ORIGINAL_FIXTURE)?;
    runtime.execute_script(
        "probe:manual-frames",
        "__advanceProbeFrame(100); __advanceProbeFrame(116.6666666667);",
    )?;
    let messages = dom_bridge::take_messages(&mut runtime);
    let observed = messages
        .first()
        .ok_or("Original fixture produced no observations")?;
    for key in [
        "identity",
        "mutation",
        "detachedIdentity",
        "classListSameObject",
        "inputPrototype",
    ] {
        check(
            observed[key] == true,
            &format!("Original fixture failed: {key}"),
        )?;
    }
    check(
        observed["geometry"] == json!([120, 240]),
        "Original synchronous geometry failed",
    )?;
    check(
        observed["eventOrder"] == json!(["capture", "target", "bubble"]),
        "Original event order failed",
    )?;
    let original = capture(&mut runtime, &mut painter, "after-original", 1, output)?;
    check(
        initial.report["geometry"]["root"]["width"].as_f64() == Some(120.0),
        "Initial root layout width differs",
    )?;
    check(
        original.report["geometry"]["root"]["width"].as_f64() == Some(240.0),
        "JS width mutation did not reach paint layout",
    )?;
    check(
        initial.report["expandedSample"] == json!([255, 255, 255, 255]),
        "Initial root unexpectedly covers expansion sample",
    )?;
    check(
        original.report["expandedSample"] == json!([200, 40, 60, 255]),
        "Expanded root did not paint its new area",
    )?;
    check(
        original.report["whiteTextPixels"].as_u64().unwrap() > 100
            && original.report["glyphs"] == 8,
        "Detached text did not produce glyph pixels",
    )?;
    runtime.execute_script("probe:paint-mutation", MUTATION)?;
    let mutated = capture(&mut runtime, &mut painter, "after-mutation", 1, output)?;
    check(
        mutated.report["rootSample"] == json!([32, 160, 96, 255]),
        "JS background mutation did not paint",
    )?;
    check(
        mutated.report["whiteTextPixels"].as_u64().unwrap() > 100,
        "Mutated text has no visible glyphs",
    )?;
    runtime.execute_script(
        "probe:clear-text",
        "document.getElementById('button').textContent = '';",
    )?;
    let empty = capture(&mut runtime, &mut painter, "without-text", 1, output)?;
    let text_changed_pixels = mutated
        .pixels
        .chunks_exact(4)
        .zip(empty.pixels.chunks_exact(4))
        .filter(|(a, b)| a != b)
        .count();
    check(
        empty.report["glyphs"] == 0 && empty.report["whiteTextPixels"] == 0,
        "Empty text still paints glyphs",
    )?;
    check(
        text_changed_pixels > 100,
        "Text-only mutation did not change pixels",
    )?;
    runtime.execute_script(
        "probe:restore-text",
        "document.getElementById('button').textContent = 'Native UI';",
    )?;
    let restored = capture(&mut runtime, &mut painter, "restored-text", 1, output)?;
    check(
        mutated.pixels == restored.pixels,
        "Restoring text did not reproduce its pixels",
    )?;
    let scaled = capture(&mut runtime, &mut painter, "scaled-2x", 2, output)?;
    check(
        scaled.report["geometry"]["root"]["width"].as_f64() == Some(240.0),
        "Logical width changed with scale",
    )?;
    check(
        scaled.report["rootSample"] == json!([32, 160, 96, 255]),
        "Scaled root did not paint at scaled coordinates",
    )?;
    check(
        scaled.report["whiteTextPixels"].as_u64().unwrap()
            > mutated.report["whiteTextPixels"].as_u64().unwrap(),
        "2x text did not rasterize at higher resolution",
    )?;
    let report = json!({
        "status":"pass","fixture":"same-realm-v8-blitz-vello-paint",
        "blitzRevision":"9d92719b37c801b8b41c81b799a2a474db8b3936",
        "versions":{"denoCore":"0.412.0","v8":deno_core::v8::V8::get_version(),"anyrenderVello":"0.14.0","vello":"0.10.0","wgpu":"29.0.4","wgpuCore":"29.0.4","wgpuTypes":"29.0.4"},
        "adapter":adapter,"originalFixtureMessages":messages,
        "inputs":{"htmlSha256":sha256(HTML.as_bytes()),"originalFixtureSha256":sha256(ORIGINAL_FIXTURE.as_bytes()),"mutationSha256":sha256(MUTATION.as_bytes()),"fontSha256":sha256(&font),"systemFonts":false},
        "textOnlyChangedPixels":text_changed_pixels,
        "frames":[initial.report,original.report,mutated.report,empty.report,restored.report,scaled.report],
        "validationErrors":painter.validation.lock().unwrap().clone(),
        "limits":["Offscreen Metal only; no native window or input.","One shared Rust DOM with the bounded V8 adapter, not complete DOM/CSS conformance.","Independent wgpu29.0.4 device; no Three.js/ANGLE canvas or runtime GPU registry sharing.","GPU readback is for assertions and PNG evidence, not a display transport.","One pinned font and simple opaque backgrounds/text; no filters, complex text, IME or accessibility certification.","Manual capture stages and RAF timestamps; no frame pacing or performance claim."]
    });
    let serialized = serde_json::to_string_pretty(&report)?;
    fs::write(output.join("report.json"), &serialized)?;
    println!("{serialized}");
    Ok(())
}
