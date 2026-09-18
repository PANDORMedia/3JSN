//! Package/IR preflight tests intentionally provide no usable DOM constructor.

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

mod dom_bridge {
    #[cfg(feature = "dynamic-html")]
    pub fn extension(_: &str, _: blitz_dom::DocumentConfig) -> deno_core::Extension {
        panic!("package argument/preflight processing must not initialize a DOM realm")
    }

    pub fn extension_with_document(_: blitz_dom::BaseDocument) -> deno_core::Extension {
        panic!("package argument/preflight processing must not initialize a DOM realm")
    }
}

#[cfg(feature = "dynamic-html")]
#[allow(dead_code, reason = "CPU tests do not enter the interpreted DOM host.")]
mod interpreted_window_options {
    include!("../../dom-canvas/src/window_options.rs");
}

#[allow(
    dead_code,
    reason = "CPU preflight tests do not enter the window or DOM host."
)]
mod window_options {
    include!("../src/window_options.rs");

    #[cfg(test)]
    mod tests {
        include!("support/package_options.rs");
    }
}
