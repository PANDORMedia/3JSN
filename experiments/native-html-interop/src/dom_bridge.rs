include!("../../html-v8/src/main.rs");

pub fn extension(html: &str, config: DocumentConfig) -> deno_core::Extension {
    let document = HtmlDocument::from_html(html, config).into_inner();
    let mut extension = html_v8_probe::init(DomState {
        document,
        started: Instant::now(),
        messages: vec![],
        html_fragment_parser: Some(DocumentHtmlParser::parse_inner_html_into_mutator),
    });
    extension.esm_files = vec![deno_core::ExtensionFileSource::new(
        "ext:html_v8_probe/bindings.js",
        deno_core::ascii_str_include!("bindings.js"),
    )]
    .into();
    extension
}

pub fn with_document<T>(runtime: &mut JsRuntime, apply: impl FnOnce(&mut BaseDocument) -> T) -> T {
    let state = runtime.op_state();
    let mut state = state.borrow_mut();
    apply(&mut state.borrow_mut::<DomState>().document)
}

pub fn take_messages(runtime: &mut JsRuntime) -> Vec<Value> {
    std::mem::take(
        &mut runtime
            .op_state()
            .borrow_mut()
            .borrow_mut::<DomState>()
            .messages,
    )
}
