use std::time::Instant;

use crate::{Result, dom_bridge, host, package_resources, window_options::MeasurementOptions};

pub async fn run(started: Instant, options: MeasurementOptions) -> Result<()> {
    use blitz_traits::shell::{ColorScheme, Viewport};
    let mut font_ctx = blitz_dom::build_single_font_ctx(&options.font);
    if font_ctx.collection.family_names().next().is_none() {
        return Err("supplied font did not register a usable font family".into());
    }
    let resources = package_resources::PackageResources::new(
        package_resources::PACKAGE_BASE_URL,
        options.resources,
    )?;
    let document = options.document.into_dom(blitz_dom::DocumentConfig {
        font_ctx: Some(font_ctx),
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
    let report = dom_bridge::with_document(&mut runtime, |doc| -> Result<_> {
        resources.drain(doc)?;
        doc.load_web_fonts()?;
        let mut delivery = resources.finish_initial_load(doc)?;
        let fonts = doc.check_web_fonts()?;
        delivery.font_registration_verified = true;
        Ok(
            serde_json::json!({"packagedResources":delivery, "webFonts":{
                "requested":fonts.requested, "registered":fonts.registered,
                "pending":fonts.pending, "decodedBytes":fonts.decoded_bytes
            }}),
        )
    })?;
    println!("{report}");
    runtime.execute_script("probe:behavior", std::fs::read_to_string(options.behavior)?)?;
    check_resources(&mut runtime, &resources)?;
    let initial: serde_json::Value =
        host::evaluate(&mut runtime, "uiProbe.snapshot()".into()).await?;
    check_resources(&mut runtime, &resources)?;
    let initialization_ns = started.elapsed().as_nanos();
    let verification: Option<serde_json::Value> = if options.verify {
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
    check_resources(&mut runtime, &resources)?;
    println!(
        "{}",
        serde_json::json!({"layoutMeasurement":true,"dynamicHtml":cfg!(feature="dynamic-html"),
        "initializationNanoseconds":initialization_ns,"initial":initial,"verification":verification,
        "gpuDeviceRequested":false,"metric":"main entry through IR, font, realm initialization and first layout snapshot"})
    );
    Ok(())
}

fn check_resources(
    runtime: &mut deno_core::JsRuntime,
    resources: &package_resources::PackageResources,
) -> Result<()> {
    dom_bridge::with_document(runtime, |doc| -> Result<()> {
        resources.drain(doc)?;
        doc.check_web_fonts()?;
        Ok(())
    })
}
