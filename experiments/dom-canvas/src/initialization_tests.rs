use deno_core::JsRuntime;
use serde_json::{Value, json};

use crate::{
    Result, canvas_init, canvas_texture::CanvasImage, check, dom_bridge, evidence, host,
    metal::MetalBridge,
};

pub async fn run(runtime: &mut JsRuntime, bridge: &MetalBridge) -> Result<Value> {
    let mut cases = vec![];
    for name in [
        "untouched",
        "partial",
        "preserved",
        "discarded",
        "discard-then-partial",
        "unsupported-usage",
        "destroyed",
        "untouched-after-errors",
    ] {
        let metadata: Value =
            host::evaluate(runtime, format!("probe.initializationCase('{name}')")).await?;
        if matches!(name, "unsupported-usage" | "destroyed") {
            let rejection = match dom_bridge::with_texture(
                runtime,
                "scene",
                canvas_init::initialize_for_export,
            ) {
                Ok(()) => {
                    return Err(format!("invalid initialization case accepted: {name}").into());
                }
                Err(error) => error.to_string(),
            };
            if name == "unsupported-usage" {
                check(
                    rejection == "canvas export initialization requires RENDER_ATTACHMENT usage",
                    "wrong usage rejection",
                )?;
            } else {
                check(
                    rejection.starts_with("canvas initialization ")
                        && rejection.to_lowercase().contains("destroyed"),
                    "wrong destroyed-source rejection",
                )?;
            }
            cases.push(json!({"name":name,"rejected":true,"reason":rejection}));
            dom_bridge::expire(runtime);
            continue;
        }
        let mut image =
            dom_bridge::with_texture(runtime, "scene", |source| CanvasImage::new(bridge, source))?;
        let outcome: Result<Value> = (|| {
            dom_bridge::with_texture(runtime, "scene", |source| {
                // SAFETY: source is Deno-created and rooted; this thread alone
                // orders producer initialization and snapshot on the shared queue.
                unsafe { image.update(bridge, source, true) }
            })?;
            let pixels = evidence::read(bridge, &image.texture)?;
            let width = image.texture.width() as usize;
            for (index, pixel) in pixels.chunks_exact(4).enumerate() {
                let expected = if name == "preserved" {
                    [64, 128, 191, 255]
                } else if matches!(name, "partial" | "discard-then-partial")
                    && index == 11 * width + 17
                {
                    [255, 0, 0, 255]
                } else {
                    [0, 0, 0, 0]
                };
                check(
                    pixel == expected,
                    &format!("{name} pixel {index}: expected {expected:?}, got {pixel:?}"),
                )?;
            }
            Ok(
                json!({"name":name,"passed":true,"pixelsChecked":pixels.len()/4,"metadata":metadata,"rgbaSha256":evidence::sha256(&pixels)}),
            )
        })();
        if let Err(error) = bridge.drain() {
            std::mem::forget(image);
            return Err(
                format!("initialization result: {outcome:?}; GPU drain failed: {error}").into(),
            );
        }
        drop(image);
        dom_bridge::expire(runtime);
        cases.push(outcome?);
    }
    let snapshot_copy_bytes: usize = cases
        .iter()
        .filter_map(|case| case["pixelsChecked"].as_u64())
        .map(|pixels| pixels as usize * 4)
        .sum();
    Ok(
        json!({"method":"original-registry-load-store-pass","cases":cases,"snapshotCopyBytes":snapshot_copy_bytes,
        "cpuImageTransport":false,"jsUsageUnchanged":true}),
    )
}
