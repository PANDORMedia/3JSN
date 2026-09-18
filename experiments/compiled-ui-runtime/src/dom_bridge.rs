include!("../../dom-canvas/src/canvas_bridge.rs");

pub fn extension_with_document(document: BaseDocument) -> deno_core::Extension {
    #[cfg(feature = "dynamic-html")]
    let parser: Option<HtmlFragmentParser> =
        Some(blitz_html::DocumentHtmlParser::parse_inner_html_into_mutator);
    #[cfg(not(feature = "dynamic-html"))]
    let parser = None;
    #[allow(unused_mut)]
    let mut extension = extension_with_document_and_parser(document, parser);
    #[cfg(not(feature = "dynamic-html"))]
    {
        let mut files = extension.esm_files.to_vec();
        files.push(deno_core::ExtensionFileSource::new(
            "ext:compiled_ui_runtime/restricted.js",
            deno_core::ascii_str_include!("restricted.js"),
        ));
        extension.esm_files = files.into();
        extension.esm_entry_point = Some("ext:compiled_ui_runtime/restricted.js");
    }
    extension
}
