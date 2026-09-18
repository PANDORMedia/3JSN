use std::{error::Error, fs};

use deno_core::{serde_v8, v8};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[cfg(test)]
mod geometry_tests;

#[allow(
    dead_code,
    reason = "Reuse the authoritative DOM ops without the prior executable scenarios."
)]
#[path = "dom_diagnostic_host.rs"]
mod dom;

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 3 {
        return Err("usage: geometry-probe <html> <geometry.js> <report.json>".into());
    }
    let html = fs::read_to_string(&args[0])?;
    let script = fs::read_to_string(&args[1])?;
    let mut runtime = dom::create(&html, blitz_dom::DocumentConfig::default());
    runtime.execute_script("probe:geometry-fixture", script.clone())?;
    let result = runtime.execute_script("probe:geometry-result", "domGeometry.run()")?;
    let report: Value = {
        deno_core::scope!(scope, &mut runtime);
        let result = v8::Local::new(scope, result);
        serde_v8::from_v8(scope, result)?
    };
    let output = json!({
        "kind": "native-dom-geometry", "gpuRequested": false,
        "v8": deno_core::v8::V8::get_version(), "result": report,
        "inputs": {
            "htmlSha256": format!("{:x}", Sha256::digest(html.as_bytes())),
            "scriptSha256": format!("{:x}", Sha256::digest(script.as_bytes())),
        },
        "limits": ["No painting, GPU, window or performance test.",
            "Existing bounded DOM wrapper; DOMRect prototype and getClientRects JS bindings are not certified."]
    });
    fs::write(
        &args[2],
        format!("{}\n", serde_json::to_string_pretty(&output)?),
    )?;
    println!("{}", serde_json::to_string_pretty(&output)?);
    if report["status"] != "passed" {
        return Err("DOM_GEOMETRY_CHECKS_FAILED; report saved".into());
    }
    Ok(())
}
