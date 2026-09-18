//! Actual DOM canvas + upstream Three integration; run explicitly on a Metal host.
use blitz_dom::{BaseDocument, LocalName, QualName, ns};
use deno_core::{JsRuntime, RuntimeOptions};
use std::{error::Error, path::PathBuf, sync::Arc};
type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[allow(
    dead_code,
    reason = "Shared DOM bridge also exposes compositor helpers outside this test."
)]
#[path = "../src/dom_bridge.rs"]
mod dom_bridge;
#[path = "../src/webgl_backend.rs"]
mod webgl_backend;

deno_core::extension!(
    webgl_dom_globals,
    deps = [deno_webidl, deno_web, deno_webgpu]
);
deno_core::extension!(webgl_dom_observation, deps = [webgl_dom_backend]);

#[tokio::test(flavor = "current_thread")]
#[ignore = "Requires native Metal, pinned ANGLE and a bundled public Three fixture"]
async fn webgl_dom_canvas() -> Result<()> {
    let package = PathBuf::from(std::env::var("THREEJS_NATIVE_ANGLE_PACKAGE")?);
    let script = std::fs::read_to_string(std::env::var("THREEJS_NATIVE_DOM_FIXTURE")?)?;
    let mut document = BaseDocument::new(Default::default());
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
    let mut globals = webgl_dom_globals::init();
    globals.esm_files = vec![deno_core::ExtensionFileSource::new(
        "ext:webgl_dom_globals/web-globals.js",
        deno_core::ascii_str_include!("../../../crates/runtime/src/web-globals.js"),
    )]
    .into();
    globals.esm_entry_point = Some("ext:webgl_dom_globals/web-globals.js");
    let mut observations = webgl_dom_observation::init();
    observations.esm_files = vec![deno_core::ExtensionFileSource::new(
        "ext:webgl_dom_observation/observe.js",
        deno_core::ascii_str_include!("webgl_dom_observe.js"),
    )]
    .into();
    observations.esm_entry_point = Some("ext:webgl_dom_observation/observe.js");
    let mut extensions = vec![
        deno_webidl::deno_webidl::init(),
        deno_web::deno_web::init(
            Arc::new(deno_web::BlobStore::default()),
            None,
            false,
            deno_web::InMemoryBroadcastChannel::default(),
        ),
        deno_webgpu::deno_webgpu::init(),
        globals,
        threejs_native_webgl_runtime::runtime_extension(&package.join("deps/darwin/dylib"))?,
        dom_bridge::extension_with_document(document),
        webgl_backend::extension(),
        observations,
    ];
    extensions
        .iter_mut()
        .for_each(threejs_native_js_sources::embed_extension_sources);
    let mut runtime = JsRuntime::new(RuntimeOptions {
        extensions,
        ..Default::default()
    });
    runtime.execute_script("fixture:standard-three-dom", script)?;
    runtime.execute_script("test:dom-webgl", include_str!("webgl_dom_checks.js"))?;
    dom_bridge::release(&mut runtime);
    threejs_native_webgl_runtime::release_all(&mut runtime)?;
    threejs_native_webgl_runtime::release_all(&mut runtime)?;
    Ok(())
}
