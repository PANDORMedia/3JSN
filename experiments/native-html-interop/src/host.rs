include!("host_core.rs");

use crate::dom_bridge;
use blitz_dom::DocumentConfig;

pub fn create(html: &str, config: DocumentConfig) -> JsRuntime {
    create_with_extensions(html, config, vec![])
}

pub fn create_with_extensions(
    html: &str,
    config: DocumentConfig,
    extensions: Vec<deno_core::Extension>,
) -> JsRuntime {
    create_with_prepared_extensions(html, config, extensions, |_| {})
}

pub fn create_with_prepared_extensions(
    html: &str,
    config: DocumentConfig,
    extensions: Vec<deno_core::Extension>,
    prepare: impl Fn(&mut deno_core::Extension),
) -> JsRuntime {
    create_with_dom_extension(dom_bridge::extension(html, config), extensions, prepare)
}
