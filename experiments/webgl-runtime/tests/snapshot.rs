//! Hardware-only evidence for the ANGLE → Metal → wgpu snapshot boundary.
//! CPU readback is confined to assertions, never used as image transport.
#![cfg(all(target_os = "macos", feature = "metal-snapshot"))]

use deno_core::{ExtensionFileSource, JsRuntime, RuntimeOptions};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};
use threejs_native_webgl_runtime::{
    snapshot,
    snapshot_consumer::{AlphaConversion, GpuSnapshot},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
deno_core::extension!(snapshot_fixture);

const FIXTURE: &str = r#"
import { core } from 'ext:core/mod.js';
const ops=core.ops;
globalThis.contextId=ops.op_angle_create(8,6);
globalThis.paint=(width,height,phase,premultiplied=false)=>{
  ops.op_gl_enable(contextId,0x0c11);
  // Three valid premultiplied colors and one deliberately dirty transparent
  // texel distinguish unpremultiplication from preservation and zero division.
  const colors=premultiplied
    ? [[128/255,64/255,32/255,128/255],[0,64/255,0,64/255],[0,0,192/255,192/255],[1,.5,.25,0]]
    : [[1,0,0,1],[0,1,0,.5],[0,0,1,.25],[1,.5,0,.75]];
  for(let quadrant=0;quadrant<4;quadrant++) {
    ops.op_gl_scissor(contextId,(quadrant%2)*width/2,Math.floor(quadrant/2)*height/2,width/2,height/2);
    ops.op_gl_clear_color(contextId,...colors[(quadrant+phase)%4]);
    ops.op_gl_clear(contextId,0x4000);
  }
  // Keep scissor enabled so publication must preserve and override it safely.
  ops.op_gl_viewport(contextId,1,2,3,4);
  ops.op_gl_scissor(contextId,2,1,4,3);
};
globalThis.glState=()=>JSON.stringify([0x0ba2,0x0c10,0x0c11,0x0c22].map(p=>ops.op_gl_get_parameter(contextId,p)));
globalThis.poison=()=>ops.op_gl_enable(contextId,0xffffffff);
globalThis.checkError=()=>{
  if(ops.op_gl_get_error(contextId)!==0x500 || ops.op_gl_get_error(contextId)!==0) throw Error('Snapshot consumed or changed pending GL error');
};
globalThis.resize=(w,h)=>ops.op_angle_resize(contextId,w,h);
globalThis.dispose=()=>ops.op_angle_dispose(contextId);
"#;

fn evaluate(runtime: &mut JsRuntime, source: impl Into<String>) -> Result<serde_json::Value> {
    let value = runtime.execute_script("snapshot:assertion", source.into())?;
    deno_core::scope!(scope, runtime);
    let value = deno_core::v8::Local::new(scope, value);
    Ok(deno_core::serde_v8::from_v8(scope, value)?)
}

struct Capture {
    buffer: wgpu::Buffer,
    width: u32,
    row: u32,
}

// Submission only: no mapping, polling or CPU completion wait here.
fn capture(device: &wgpu::Device, queue: &wgpu::Queue, texture: &wgpu::Texture) -> Capture {
    let size = texture.size();
    let row = (size.width * 4).div_ceil(256) * 256;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Snapshot assertion only"),
        size: u64::from(row) * u64::from(size.height),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(row),
                rows_per_image: Some(size.height),
            },
        },
        size,
    );
    queue.submit([encoder.finish()]);
    Capture {
        buffer,
        width: size.width,
        row,
    }
}

fn read_captures(device: &wgpu::Device, captures: &[Capture]) -> Result<Vec<Vec<u8>>> {
    let mut receivers = Vec::new();
    for capture in captures {
        let (sender, receiver) = mpsc::channel();
        capture
            .buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });
        receivers.push(receiver);
    }
    // All frame copies have been submitted before this single completion wait.
    device.poll(wgpu::PollType::Wait {
        submission_index: None,
        timeout: Some(Duration::from_secs(10)),
    })?;
    let mut frames = Vec::new();
    for (capture, receiver) in captures.iter().zip(receivers) {
        receiver.recv_timeout(Duration::from_secs(5))??;
        let mapped = capture.buffer.slice(..).get_mapped_range();
        frames.push(
            mapped
                .chunks(capture.row as usize)
                .flat_map(|line| line[..capture.width as usize * 4].iter().copied())
                .collect(),
        );
        drop(mapped);
        capture.buffer.unmap();
    }
    Ok(frames)
}

fn assert_pattern(
    bytes: &[u8],
    width: u32,
    height: u32,
    phase: usize,
    alpha_conversion: AlphaConversion,
) {
    let colors: [[u8; 4]; 4] = match alpha_conversion {
        AlphaConversion::Preserve => [
            [255, 0, 0, 255],
            [0, 255, 0, 128],
            [0, 0, 255, 64],
            [255, 128, 0, 191],
        ],
        AlphaConversion::Premultiply => [
            [255, 0, 0, 255],
            [0, 128, 0, 128],
            [0, 0, 64, 64],
            [191, 96, 0, 191],
        ],
        AlphaConversion::Unpremultiply => [
            [255, 128, 64, 128],
            [0, 255, 0, 64],
            [0, 0, 255, 192],
            [0, 0, 0, 0],
        ],
    };
    assert_eq!(bytes.len(), width as usize * height as usize * 4);
    for y in 0..height {
        for x in 0..width {
            // Output is top-left; GL scissor coordinates are bottom-left.
            let quadrant = usize::from(x >= width / 2) + 2 * usize::from(y < height / 2);
            let expected = colors[(quadrant + phase) % 4];
            let offset = ((y * width + x) * 4) as usize;
            let tolerance = if expected[3] == 0 { 0 } else { 1 };
            for channel in 0..4 {
                assert!(
                    bytes[offset + channel].abs_diff(expected[channel]) <= tolerance,
                    "pixel ({x},{y}) channel {channel}: actual={} expected={}",
                    bytes[offset + channel],
                    expected[channel]
                );
            }
        }
    }
}

#[test]
#[ignore = "Requires ANGLE_LIBRARY_DIR, macOS Metal hardware and matching ANGLE/wgpu MTLDevice"]
fn native_snapshot_orientation_alpha_state_and_lifetime() -> Result<()> {
    let executor = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()?;
    let _entered = executor.enter();
    let libraries = PathBuf::from(std::env::var("ANGLE_LIBRARY_DIR")?);
    let mut fixture = snapshot_fixture::init();
    fixture.esm_files = vec![ExtensionFileSource::new_computed(
        "ext:snapshot_fixture/fixture.js",
        Arc::from(FIXTURE),
    )]
    .into();
    fixture.esm_entry_point = Some("ext:snapshot_fixture/fixture.js");
    let mut runtime = JsRuntime::new(RuntimeOptions {
        extensions: vec![
            threejs_native_webgl_runtime::probe_extension(&libraries)?,
            fixture,
        ],
        ..Default::default()
    });
    let id = evaluate(&mut runtime, "contextId")?
        .as_u64()
        .ok_or("Missing context ID")? as u32;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::METAL,
        flags: wgpu::InstanceFlags::VALIDATION,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter =
        executor.block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))?;
    assert_eq!(adapter.get_info().backend, wgpu::Backend::Metal);
    let (device, queue) =
        executor.block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))?;
    let validation = Arc::new(Mutex::new(Vec::new()));
    let errors = validation.clone();
    device.on_uncaptured_error(Arc::new(move |error: wgpu::Error| {
        errors.lock().unwrap().push(error.to_string())
    }));

    for (generation, (width, height, alpha_conversion)) in [
        (8, 6, AlphaConversion::Preserve),
        (12, 10, AlphaConversion::Premultiply),
        (16, 14, AlphaConversion::Unpremultiply),
    ]
    .into_iter()
    .enumerate()
    {
        if generation != 0 {
            evaluate(&mut runtime, format!("resize({width},{height}); null"))?;
        }
        // Creating the lease must not consume an unrelated GLES error, nor
        // require a clear that would hide initialization of a fresh pbuffer.
        evaluate(&mut runtime, "poison(); null")?;
        let lease = snapshot(&mut runtime, id)?;
        evaluate(&mut runtime, "checkError(); null")?;
        assert_eq!(lease.size(), (width, height));
        assert!(!lease.device_raw().is_null() && !lease.texture_raw().is_null());
        let mut consumer = GpuSnapshot::new(lease, &device, &queue, alpha_conversion)?;
        assert!(consumer.texture().is_err());
        // This thread exclusively controls the queue; there are no outstanding encoders.
        let mut token = unsafe { consumer.update()? };
        assert!(token > 0);
        assert!(
            read_captures(&device, &[capture(&device, &queue, consumer.texture()?)])?[0]
                .iter()
                .all(|byte| *byte == 0),
            "New robust pbuffer must be initialized"
        );
        for action in ["resize(16,16)", "dispose()"] {
            let value = evaluate(
                &mut runtime,
                format!(
                    "(()=>{{try{{{action};return false}}catch(error){{return /snapshot/i.test(String(error))}}}})()"
                ),
            )?;
            assert_eq!(value, true, "Live lease must reject {action}");
        }
        let mut captures = Vec::new();
        let mut pending_writes = Vec::new();
        let premultiplied_input = alpha_conversion == AlphaConversion::Unpremultiply;
        for phase in 0..8 {
            evaluate(
                &mut runtime,
                format!("paint({width},{height},{phase},{premultiplied_input}); null"),
            )?;
            let before = evaluate(&mut runtime, "glState()")?;
            evaluate(&mut runtime, "poison(); null")?;
            // Exercise deferred queue writes before the raw Metal handoff. The
            // consumer must flush these before placing the producer wait.
            let pending = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Pending write control"),
                size: 4,
                usage: wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            queue.write_buffer(&pending, 0, &[1, 2, 3, 4]);
            let next = unsafe { consumer.update()? };
            assert!(next > token);
            token = next;
            assert_eq!(evaluate(&mut runtime, "glState()")?, before);
            evaluate(&mut runtime, "checkError(); null")?;
            captures.push(capture(&device, &queue, consumer.texture()?));
            pending_writes.push(pending);
        }
        for (phase, bytes) in read_captures(&device, &captures)?.iter().enumerate() {
            assert_pattern(bytes, width, height, phase, alpha_conversion);
        }
        consumer.close()?;
        assert!(consumer.texture().is_err());
        assert!(unsafe { consumer.update() }.is_err());
        consumer.close()?;
    }
    evaluate(&mut runtime, "dispose(); null")?;
    assert!(snapshot(&mut runtime, id).is_err());
    threejs_native_webgl_runtime::release_all(&mut runtime)?;
    assert!(
        validation.lock().unwrap().is_empty(),
        "wgpu errors: {:?}",
        validation.lock().unwrap()
    );
    Ok(())
}
