use std::{error::Error, fs};

use blitz_dom::DocumentConfig;
use blitz_html::{DocumentHtmlParser, HtmlDocument};
use deno_core::{JsRuntime, RuntimeOptions};

include!("dom_ops.rs");

deno_core::extension!(
    html_v8_probe,
    ops = [op_dom_read, op_dom_mutate, op_observe],
    esm_entry_point = "ext:html_v8_probe/bindings.js",
    esm = [dir "src", "bindings.js"],
    options = { dom: DomState },
    state = |state, options| state.put(options.dom),
);

fn main() -> Result<(), Box<dyn Error>> {
    let files: Vec<_> = std::env::args().skip(1).collect();
    if files.len() != 2 {
        return Err("usage: html-v8-probe <original-fixture.js> <behavior.js>".into());
    }
    let doc = HtmlDocument::from_html(
        "<!doctype html><html><body><div id='root'></div></body></html>",
        DocumentConfig::default(),
    )
    .into_inner();
    let mut runtime = JsRuntime::new(RuntimeOptions {
        extensions: vec![html_v8_probe::init(DomState {
            document: doc,
            started: Instant::now(),
            messages: vec![],
            html_fragment_parser: Some(DocumentHtmlParser::parse_inner_html_into_mutator),
        })],
        ..Default::default()
    });
    for file in &files {
        let name = fs::canonicalize(file)?.to_string_lossy().into_owned();
        runtime.execute_script(name, fs::read_to_string(file)?)?;
    }
    runtime.execute_script(
        "probe:manual-frames",
        "__advanceProbeFrame(100); __advanceProbeFrame(116.6666666667);",
    )?;
    let messages = std::mem::take(
        &mut runtime
            .op_state()
            .borrow_mut()
            .borrow_mut::<DomState>()
            .messages,
    );
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
        if observed[key] != true {
            return Err(format!("Failed original fixture observation: {key}").into());
        }
    }
    if observed["geometry"] != json!([120, 240])
        || observed["eventOrder"] != json!(["capture", "target", "bubble"])
    {
        return Err("Original layout/event observations disagree with browser baseline".into());
    }
    let behavior = messages
        .iter()
        .find_map(|value| value.get("behavior"))
        .ok_or("Missing behavioral checks")?;
    if !behavior
        .as_object()
        .is_some_and(|checks| checks.len() == 15 && checks.values().all(|value| value == true))
    {
        return Err(format!("Behavior check failed: {behavior}").into());
    }
    if messages.iter().find_map(|value| value.get("frames")) != Some(&json!([100, 116.6666666667]))
    {
        return Err("Manually driven RAF observations disagree with host timestamps".into());
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "fixture":"v8-blitz-dom", "result":"pass-for-declared-probe-subset",
            "blitzRevision":"9d92719b37c801b8b41c81b799a2a474db8b3936",
            "denoCore":"0.412.0", "v8":deno_core::v8::V8::get_version(),
            "messages":messages,
            "limits":["No GPU, HTML painting or window integration.","Synthetic DOM events only; native input and default actions are not implemented.","Wrappers and detached nodes retained until document destruction; no per-node garbage collection.","Manually driven RAF timestamps are a test hook, not display scheduling.","Only fixture-required DOM methods and prototypes are implemented."]
        }))?
    );
    Ok(())
}
