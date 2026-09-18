include!("../../html-v8/src/main.rs");

pub fn create(html: &str, config: DocumentConfig) -> JsRuntime {
    let mut extension = html_v8_probe::init(DomState {
        document: HtmlDocument::from_html(html, config).into_inner(),
        started: Instant::now(),
        messages: vec![],
    });
    extension.esm_files = vec![deno_core::ExtensionFileSource::new(
        "ext:html_v8_probe/bindings.js",
        deno_core::ascii_str_include!("../../html-v8/src/bindings.js"),
    )]
    .into();
    JsRuntime::new(RuntimeOptions {
        extensions: vec![extension],
        ..Default::default()
    })
}

pub fn with_document<T>(runtime: &mut JsRuntime, apply: impl FnOnce(&mut BaseDocument) -> T) -> T {
    let state = runtime.op_state();
    let mut state = state.borrow_mut();
    apply(&mut state.borrow_mut::<DomState>().document)
}

pub async fn evaluate<T: serde::de::DeserializeOwned>(
    runtime: &mut JsRuntime,
    source: String,
) -> Result<T, Box<dyn Error>> {
    let value = runtime.execute_script("probe:diagnostic", source)?;
    let result = runtime.resolve(value);
    let value = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        runtime.with_event_loop_promise(result, Default::default()),
    )
    .await??;
    deno_core::scope!(scope, runtime);
    let value = deno_core::v8::Local::new(scope, value);
    Ok(deno_core::serde_v8::from_v8(scope, value)?)
}
