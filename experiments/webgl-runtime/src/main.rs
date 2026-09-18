use deno_core::{JsRuntime, RuntimeOptions};
use std::{error::Error, path::Path};

fn main() -> Result<(), Box<dyn Error>> {
    let executor = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()?;
    let _entered = executor.enter();
    let libraries = std::env::args()
        .nth(1)
        .ok_or("usage: threejs-native-webgl-runtime <ANGLE library directory>")?;
    let extension = threejs_native_webgl_runtime::probe_extension(Path::new(&libraries))?;
    let mut runtime = JsRuntime::new(RuntimeOptions {
        extensions: vec![extension],
        ..Default::default()
    });
    let result = if let Some(script) = std::env::args().nth(2) {
        runtime.execute_script("probe:upstream-renderer", std::fs::read_to_string(script)?)?;
        runtime.execute_script("probe:report", "globalThis.__rendererInitReport")?
    } else {
        runtime.execute_script("probe:angle-context-ownership", include_str!("../probe.js"))?
    };
    deno_core::scope!(scope, &mut runtime);
    let local = deno_core::v8::Local::new(scope, result);
    let report: serde_json::Value = deno_core::serde_v8::from_v8(scope, local)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
