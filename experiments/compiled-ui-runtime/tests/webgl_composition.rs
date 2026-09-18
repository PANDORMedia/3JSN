//! Offscreen GPU evidence for the real DOM WebGL canvas and HTML compositor.
//! Readback is confined to pixel assertions, never used as canvas transport.
#![cfg(all(target_os = "macos", feature = "native-webgl"))]

use std::{error::Error, path::Path, sync::mpsc, time::Duration};

use blitz_dom::{BaseDocument, DocumentConfig, LocalName, QualName, ns};
use blitz_traits::shell::{ColorScheme, Viewport};
use deno_core::JsRuntime;
use vello::peniko::ImageData;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[allow(
    dead_code,
    reason = "Shared DOM module also exposes WebGPU compositor helpers."
)]
#[path = "../src/dom_bridge.rs"]
mod dom_bridge;
#[allow(
    dead_code,
    reason = "Reuse the production realm setup without its module/device helpers."
)]
#[path = "../../native-html-interop/src/host_core.rs"]
mod host;
#[allow(
    dead_code,
    reason = "This test uses only the independent offscreen Metal owner."
)]
#[path = "../../native-html-interop/src/metal.rs"]
mod metal;
#[path = "../../dom-canvas/src/painter.rs"]
mod painter;
#[path = "../src/webgl_backend.rs"]
mod webgl_backend;
#[path = "../../dom-canvas/src/window_capture.rs"]
mod window_capture;

const WIDTH: u32 = 100;
const HEIGHT: u32 = 80;
const FIXTURE: &str = r#"
document.documentElement.style.cssText = 'margin:0;width:100px;height:80px;background:rgb(0,0,255)';
document.body.style.cssText = 'margin:0;width:100px;height:80px;position:relative';
globalThis.makeCanvas = () => {
  const canvas = document.createElement('canvas');
  canvas.id = 'scene';
  canvas.width = 40;
  canvas.height = 40;
  canvas.style.cssText = 'position:absolute;left:10px;top:10px;width:40px;height:40px';
  return canvas;
};
globalThis.scene = makeCanvas();
document.body.appendChild(scene);
globalThis.gl = scene.getContext('webgl2');
if (!gl || gl.canvas !== scene || !gl.getContextAttributes().premultipliedAlpha) {
  throw Error('Missing real premultiplied DOM WebGL canvas');
}
if (scene.getContext('webgpu') !== null) throw Error('Canvas mode ownership changed');
globalThis.overlay = document.createElement('div');
overlay.style.cssText = 'position:absolute;z-index:1;left:30px;top:20px;width:40px;height:30px;background:rgba(255,255,255,.5)';
document.body.appendChild(overlay);
globalThis.paintCanvas = () => {
  gl.clearColor(.5, 0, 0, .5);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (gl.getError() !== gl.NO_ERROR) throw Error('WebGL fixture generated an error');
};
paintCanvas();
"#;

fn ensure(value: bool, message: &str) -> Result<()> {
    if value { Ok(()) } else { Err(message.into()) }
}

fn document(font: &[u8]) -> Result<BaseDocument> {
    let mut font_ctx = blitz_dom::build_single_font_ctx(font);
    ensure(
        font_ctx.collection.family_names().next().is_some(),
        "composition font has no usable family",
    )?;
    let mut document = BaseDocument::new(DocumentConfig {
        font_ctx: Some(font_ctx),
        viewport: Some(Viewport::new(WIDTH, HEIGHT, 1.0, ColorScheme::Light)),
        ..Default::default()
    });
    let root = document.root_node().id;
    {
        let mut dom = document.mutate();
        let element = |name: &str| QualName::new(None, ns!(html), LocalName::from(name));
        let html = dom.create_element(element("html"), vec![]);
        let head = dom.create_element(element("head"), vec![]);
        let body = dom.create_element(element("body"), vec![]);
        dom.append_children(html, &[head, body]);
        dom.append_children(root, &[html]);
    }
    Ok(document)
}

fn runtime(document: BaseDocument, libraries: Option<&Path>) -> Result<JsRuntime> {
    let extensions = if let Some(libraries) = libraries {
        vec![
            threejs_native_webgl_runtime::runtime_extension(libraries)?,
            webgl_backend::extension(),
        ]
    } else {
        vec![]
    };
    Ok(host::create_with_dom_extension(
        dom_bridge::extension_with_document(document),
        extensions,
        threejs_native_js_sources::embed_extension_sources,
    ))
}

fn compose(
    runtime: &mut JsRuntime,
    painter: &mut painter::Painter,
    canvas: &webgl_backend::Canvas,
    output: &wgpu::Texture,
    registration: &mut Option<ImageData>,
    generation: &mut Option<(String, u64)>,
) -> Result<()> {
    // SAFETY: this test alone submits to the paired device/queue. No encoder
    // crosses the handoff; subsequent painter and assertion reads use this queue.
    let (texture, revision) =
        unsafe { canvas.update(runtime, &painter.bridge.device, &painter.bridge.queue)? };
    let current = (canvas.node_key().to_owned(), revision);
    if generation.as_ref() != Some(&current) {
        painter.drain()?;
        if let Some(previous) = registration.take() {
            painter.unregister_canvas(previous)?;
        }
        *registration = Some(dom_bridge::with_document(runtime, |document| {
            let node = document
                .get_element_by_id("scene")
                .ok_or("canvas disappeared")?;
            painter.register_canvas(document, node, texture)
        })?);
        *generation = Some(current);
    }
    painter.mark_canvas_dirty(registration.as_ref().ok_or("canvas was not registered")?)?;
    dom_bridge::expire(runtime);
    let report = dom_bridge::with_document(runtime, |document| painter.paint(document, output))?;
    ensure(
        report["canvases"]
            .as_array()
            .is_some_and(|items| items.len() == 1),
        "painter did not see exactly one connected canvas",
    )?;
    ensure(
        report["canvases"][0]["contentSize"] == serde_json::json!({"width":40.0,"height":40.0}),
        "canvas CSS dimensions changed",
    )?;
    Ok(())
}

fn read_pixels(painter: &painter::Painter, output: &wgpu::Texture) -> Result<Vec<u8>> {
    let device = &painter.bridge.device;
    let queue = &painter.bridge.queue;
    let row = (WIDTH * 4).div_ceil(256) * 256;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Composition assertion only"),
        size: u64::from(row) * u64::from(HEIGHT),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        output.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(row),
                rows_per_image: Some(HEIGHT),
            },
        },
        output.size(),
    );
    queue.submit([encoder.finish()]);
    let (sender, receiver) = mpsc::channel();
    buffer
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
    device.poll(wgpu::PollType::Wait {
        submission_index: None,
        timeout: Some(Duration::from_secs(10)),
    })?;
    receiver.recv_timeout(Duration::from_secs(5))??;
    let mapped = buffer.slice(..).get_mapped_range();
    let pixels = mapped
        .chunks(row as usize)
        .flat_map(|line| line[..WIDTH as usize * 4].iter().copied())
        .collect();
    drop(mapped);
    buffer.unmap();
    painter.check_errors()?;
    Ok(pixels)
}

fn check_composition(
    painter: &painter::Painter,
    output: &wgpu::Texture,
    painted: bool,
) -> Result<()> {
    let bytes = read_pixels(painter, output)?;
    let canvas = if painted {
        [128, 0, 127, 255]
    } else {
        [0, 0, 255, 255]
    };
    let overlap = if painted {
        [191, 128, 191, 255]
    } else {
        [128, 128, 255, 255]
    };
    for (label, (left, top, right, bottom), expected) in [
        ("blue background", (2, 2, 8, 8), [0, 0, 255, 255]),
        ("canvas", (14, 14, 26, 44), canvas),
        ("HTML over canvas", (34, 24, 46, 46), overlap),
        ("HTML beyond canvas", (54, 24, 66, 46), [128, 128, 255, 255]),
    ] {
        for y in top..bottom {
            for x in left..right {
                let index = ((y * WIDTH + x) * 4) as usize;
                for channel in 0..4 {
                    if bytes[index + channel].abs_diff(expected[channel]) > 2 {
                        return Err(format!(
                            "{label} pixel ({x},{y}) channel {channel}: got {}, expected {}",
                            bytes[index + channel],
                            expected[channel]
                        )
                        .into());
                    }
                }
            }
        }
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "Requires macOS Metal, pinned ANGLE and a usable composition font"]
async fn dom_webgl_gpu_composition_and_generations() -> Result<()> {
    let package = std::path::PathBuf::from(std::env::var("THREEJS_NATIVE_ANGLE_PACKAGE")?);
    let font_path = std::env::var_os("THREEJS_NATIVE_COMPOSITION_FONT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "/System/Library/Fonts/Supplemental/Arial.ttf".into());
    let font = std::fs::read(&font_path)?;
    {
        let mut absent = runtime(document(&font)?, None)?;
        absent.execute_script("composition:absent", "const canvas=document.createElement('canvas'); canvas.id='scene'; document.body.appendChild(canvas); if(canvas.getContext('webgl2')!==null)throw Error('Uninstalled backend was exposed');")?;
        ensure(
            webgl_backend::find(&mut absent, "scene")?.is_none(),
            "absent backend was found",
        )?;
        dom_bridge::release(&mut absent);
    }
    let mut runtime = runtime(document(&font)?, Some(&package.join("deps/darwin/dylib")))?;
    runtime.execute_script("composition:fixture", FIXTURE)?;
    let canvas = webgl_backend::find(&mut runtime, "scene")?.ok_or("WebGL canvas was not found")?;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::METAL,
        flags: wgpu::InstanceFlags::VALIDATION,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let mut lease = threejs_native_webgl_runtime::snapshot(&mut runtime, canvas.context_id())?;
    let bridge = metal::MetalBridge::with_native_device_offscreen(&instance, lease.device_raw())?;
    lease.close()?;
    ensure(
        !bridge.shared_deno_queue(),
        "WebGL composition acquired a Deno queue",
    )?;
    let mut painter = painter::Painter::new(bridge)?;
    let output = painter
        .bridge
        .device
        .create_texture(&wgpu::TextureDescriptor {
            label: Some("Offscreen DOM WebGL composition"),
            size: wgpu::Extent3d {
                width: WIDTH,
                height: HEIGHT,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
    let mut registration = None;
    let mut generation = None;
    let outcome = (|| -> Result<()> {
        compose(
            &mut runtime,
            &mut painter,
            &canvas,
            &output,
            &mut registration,
            &mut generation,
        )?;
        check_composition(&painter, &output, true)?;
        let first = generation.clone().ok_or("initial generation missing")?;
        runtime.execute_script("composition:reset", "scene.width=scene.width; if(scene.getContext('webgl2')!==gl)throw Error('Reset replaced context');")?;
        compose(
            &mut runtime,
            &mut painter,
            &canvas,
            &output,
            &mut registration,
            &mut generation,
        )?;
        let reset = generation.clone().ok_or("reset generation missing")?;
        ensure(
            reset.0 == first.0 && reset.1 > first.1,
            "same-value reset did not retire its generation",
        )?;
        check_composition(&painter, &output, false)?;
        runtime.execute_script("composition:repaint", "paintCanvas()")?;
        compose(
            &mut runtime,
            &mut painter,
            &canvas,
            &output,
            &mut registration,
            &mut generation,
        )?;
        ensure(
            generation.as_ref() == Some(&reset),
            "ordinary repaint replaced its generation",
        )?;
        check_composition(&painter, &output, true)?;
        runtime.execute_script("composition:replace", "globalThis.oldScene=scene; globalThis.oldGl=gl; document.body.removeChild(scene); scene=makeCanvas(); document.body.insertBefore(scene,overlay); gl=scene.getContext('webgl2'); if(gl===oldGl || gl.canvas!==scene)throw Error('Replacement reused context'); paintCanvas();")?;
        let replacement =
            webgl_backend::find(&mut runtime, "scene")?.ok_or("replacement canvas missing")?;
        ensure(
            replacement.node_key() != canvas.node_key()
                && replacement.context_id() != canvas.context_id(),
            "replacement did not acquire new DOM and context identities",
        )?;
        canvas.retire()?;
        compose(
            &mut runtime,
            &mut painter,
            &replacement,
            &output,
            &mut registration,
            &mut generation,
        )?;
        check_composition(&painter, &output, true)?;
        if let Some(path) = std::env::var_os("THREEJS_NATIVE_COMPOSITION_CAPTURE") {
            window_capture::save(&painter.bridge, &output, Path::new(&path))?;
        }
        runtime.execute_script("composition:old-context", "oldScene.width=oldScene.width; if(oldGl.getError()!==oldGl.NO_ERROR || gl.getError()!==gl.NO_ERROR)throw Error('Generation cleanup changed GL errors');")?;
        Ok(())
    })();
    let cleanup = (|| -> Result<()> {
        painter.drain()?;
        if let Some(registration) = registration.take() {
            painter.unregister_canvas(registration)?;
        }
        webgl_backend::release_all(&mut runtime)?;
        painter.check_errors()?;
        dom_bridge::release(&mut runtime);
        threejs_native_webgl_runtime::release_all(&mut runtime)?;
        Ok(())
    })();
    if let Err(error) = cleanup {
        // Completion or native release is uncertain; preserve the complete owner
        // graph rather than turn a failing assertion into unsafe teardown.
        std::mem::forget(painter);
        std::mem::forget(runtime);
        return Err(format!("composition cleanup failed: {error}; assertions: {outcome:?}").into());
    }
    outcome
}
