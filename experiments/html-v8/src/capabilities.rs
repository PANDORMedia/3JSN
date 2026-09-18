//! Shared capability checks for compiled construction and live DOM operations.

pub const HTML_NAMESPACE: &str = "http://www.w3.org/1999/xhtml";
pub const HTML_PARSER_UNAVAILABLE: &str =
    "dynamic HTML parsing is unavailable in this restricted artifact";

/// Takes a normalized, case-sensitive local name, as stored by the native DOM.
/// Pinned Blitz dispatches its iframe hook by local name even in foreign content.
pub fn element_html_parser_requirement(namespace: &str, local_name: &str) -> Option<&'static str> {
    if local_name != "iframe" {
        return None;
    }
    Some(if namespace == HTML_NAMESPACE {
        "HTML iframe requires a configured dynamic HTML parser"
    } else {
        "foreign iframe reaches the pinned native subdocument hook and requires an HTML parser"
    })
}
