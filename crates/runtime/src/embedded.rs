use std::borrow::Cow;

use deno_core::ExtensionFileSource;

pub(crate) fn bootstrap_sources() -> Cow<'static, [ExtensionFileSource]> {
    vec![
        ExtensionFileSource::new(
            "ext:threejs_native_bootstrap/bootstrap.js",
            deno_core::ascii_str_include!("bootstrap.js"),
        ),
        ExtensionFileSource::new(
            "ext:threejs_native_bootstrap/window.js",
            deno_core::ascii_str_include!("window.js"),
        ),
        ExtensionFileSource::new(
            "ext:threejs_native_bootstrap/animation.js",
            deno_core::ascii_str_include!("animation.js"),
        ),
        ExtensionFileSource::new(
            "ext:threejs_native_bootstrap/web-globals.js",
            deno_core::ascii_str_include!("web-globals.js"),
        ),
        ExtensionFileSource::new(
            "ext:threejs_native_bootstrap/image-copy.js",
            deno_core::ascii_str_include!("image-copy.js"),
        ),
        ExtensionFileSource::new(
            "ext:threejs_native_bootstrap/input.js",
            deno_core::ascii_str_include!("input.js"),
        ),
    ]
    .into()
}
