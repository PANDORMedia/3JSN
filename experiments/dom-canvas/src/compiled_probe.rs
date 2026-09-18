use std::{error::Error, fs, io::Read};

use blitz_dom::DocumentConfig;
use blitz_traits::shell::{ColorScheme, Viewport};
use serde_json::{Value, json};

#[allow(
    dead_code,
    reason = "Use the existing authoritative DOM bindings in a construction comparison."
)]
#[path = "dom_diagnostic_host.rs"]
mod dom;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 5 || (args[0] != "--html" && args[0] != "--ui") {
        return Err("usage: compiled-ui-probe <--html|--ui> <input> <behavior.js> <font.woff2> <report.json>".into());
    }
    let mut input = Vec::new();
    fs::File::open(&args[1])?
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut input)?;
    if input.len() > 16 * 1024 * 1024 {
        return Err("UI input exceeds 16 MiB".into());
    }
    let config = DocumentConfig {
        viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
        font_ctx: Some(blitz_dom::build_single_font_ctx(&fs::read(&args[3])?)),
        ..Default::default()
    };
    let (mut runtime, loading) = if args[0] == "--ui" {
        let loaded = threejs_compiled_ui_experiment::load_json(&input, config)?;
        (
            dom::create_with_document(loaded.document),
            json!(loaded.report),
        )
    } else {
        (
            dom::create(std::str::from_utf8(&input)?, config),
            json!({"initialDocumentHtmlParserUsed":true}),
        )
    };
    runtime.execute_script("probe:ui-behavior", fs::read_to_string(&args[2])?)?;
    let initial: Value = dom::evaluate(&mut runtime, "uiFixture.snapshot()".into()).await?;
    let mutated: Value = dom::evaluate(&mut runtime, "uiFixture.mutate()".into()).await?;
    dom::with_document(&mut runtime, |document| {
        document.set_viewport(Viewport::new(520, 420, 1.0, ColorScheme::Light));
    });
    let resized: Value = dom::evaluate(&mut runtime, "uiFixture.snapshot()".into()).await?;
    let report = json!({"loading":loading,"initial":initial,"mutated":mutated,"resized":resized,
        "gpuRequested":false,"htmlParserLinked":true});
    fs::write(&args[4], serde_json::to_vec_pretty(&report)?)?;
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}
