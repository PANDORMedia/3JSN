use blitz_dom::DocumentConfig;
use blitz_traits::shell::{ColorScheme, Viewport};
use serde_json::{Value, json};
use std::{error::Error, fs, path::Path};

mod canvas_texture;
#[allow(
    dead_code,
    reason = "Reuse DOM ops while replacing the standalone probe entry point."
)]
mod dom_bridge;
mod evidence;
#[allow(
    dead_code,
    reason = "Reuse the verified realm/bootstrap helpers; reverse texture import is not used here."
)]
#[path = "../../native-html-interop/src/host.rs"]
mod host;
#[allow(
    dead_code,
    reason = "Reuse the verified same-device/queue bridge; its reverse direction is not used here."
)]
#[path = "../../native-html-interop/src/metal.rs"]
mod metal;
mod painter;
mod scenario;

type Result<T> = std::result::Result<T, Box<dyn Error>>;
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
        return Err("usage: dom-canvas <font> <bundled-app> <output-directory>".into());
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
        include_str!("../fixture.html"),
        DocumentConfig {
            font_ctx: Some(blitz_dom::build_single_font_ctx(&font)),
            viewport: Some(Viewport::new(448, 256, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    );
    let mut session = None;
    let mut app_loaded = false;
    let outcome: Result<Value> = async {
        host::load(&mut runtime, Path::new(&args[1])).await?;
        app_loaded = true;
        let contract: Value = host::evaluate(&mut runtime, "probe.contract()".into()).await?;
        let info: Value = host::evaluate(&mut runtime, "probe.info".into()).await?;
        let bridge = host::with_device(&mut runtime, |device| {
            metal::MetalBridge::new(device.instance.clone(), device.id, device.queue)
        })?;
        session = Some(scenario::Session::new(painter::Painter::new(bridge)?)?);
        let paint = scenario::run(&mut runtime, session.as_mut().unwrap(), output).await?;
        let status = if paint["clipping"]["passed"] == true && paint["stackingMutation"]["passed"] == true { "pass" } else { "partial" };
        Ok(json!({"status":status, "fixture":"dom-canvas-native-metal", "device":info,
            "contract":contract, "paint":paint, "v8":deno_core::v8::V8::get_version(),
            "fontSha256":evidence::sha256(&font), "cpuImageTransport":false,
            "nativeDeviceIdentityChecked":true,"nativeQueueIdentityChecked":true,
            "limits":["Metal-only offscreen experiment; no native presentation or performance claim.",
            "Pinned Deno canvas patch and bounded DOM adapter; not full browser conformance.",
            "Unsafe native export requires a trusted submitted full clear; arbitrary uninitialized canvas export remains unresolved.",
            "Each changed frame uses a GPU snapshot copy, alpha conversion and Vello atlas copy; not zero-copy.",
            "Canvas borders, padding, transforms, generic frame scheduling and color-space conversion are outside this test."]}))
    }
    .await;
    let mut cleanup_errors = Vec::new();
    if let Some(mut owner) = session {
        // Both registries must finish before DOM roots, snapshots or atlas
        // registrations are released, including after a failed assertion.
        if let Err(error) = owner.painter.bridge.drain() {
            std::mem::forget(owner);
            std::mem::forget(runtime);
            return Err(format!("probe result: {outcome:?}; GPU cleanup failed: {error}").into());
        }
        let finish = host::evaluate::<()>(&mut runtime, "probe.finish()".into()).await;
        if let Err(error) = owner.painter.bridge.drain() {
            std::mem::forget(owner);
            std::mem::forget(runtime);
            return Err(
                format!("probe result: {outcome:?}; final GPU cleanup failed: {error}").into(),
            );
        }
        if let Err(error) = owner.release() {
            cleanup_errors.push(error.to_string());
        }
        if let Err(error) = finish {
            cleanup_errors.push(error.to_string());
        }
    }
    dom_bridge::release(&mut runtime);
    if app_loaded {
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
    check(
        report["status"] == "pass",
        "DOM_PAINT_GATES_FAILED; report saved; shared GPU cleanup completed",
    )?;
    Ok(())
}
