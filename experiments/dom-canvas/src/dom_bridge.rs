include!("canvas_bridge.rs");

use blitz_dom::DocumentConfig;
use blitz_html::{DocumentHtmlParser, HtmlDocument};

pub fn extension(html: &str, config: DocumentConfig) -> deno_core::Extension {
    extension_with_document(HtmlDocument::from_html(html, config).into_inner())
}

pub fn extension_with_document(document: BaseDocument) -> deno_core::Extension {
    extension_with_document_and_parser(
        document,
        Some(DocumentHtmlParser::parse_inner_html_into_mutator),
    )
}
