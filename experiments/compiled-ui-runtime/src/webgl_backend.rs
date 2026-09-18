//! Optional DOM canvas registration. The native-window compositor is integrated separately.

deno_core::extension!(webgl_dom_backend, deps = [dom_canvas, angle_probe]);

pub fn extension() -> deno_core::Extension {
    let mut extension = webgl_dom_backend::init();
    extension.esm_files = vec![deno_core::ExtensionFileSource::new(
        "ext:webgl_dom_backend/webgl-canvas.js",
        deno_core::ascii_str_include!("webgl-canvas.js"),
    )]
    .into();
    extension.esm_entry_point = Some("ext:webgl_dom_backend/webgl-canvas.js");
    extension
}
