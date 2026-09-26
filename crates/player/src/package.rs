//! Player-specific capability advertisement; package verification is shared.

use serde::Serialize;
pub use threejs_native_package::load;
use threejs_native_package::{PACKAGE_ASSETS_CAPABILITY, PROFILE, target};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Description {
    schema_version: u32,
    player_version: &'static str,
    package_versions: [u32; 1],
    profiles: [&'static str; 1],
    capabilities: [&'static str; 1],
    target: &'static str,
    backend: &'static str,
    v8: &'static str,
}

pub fn description() -> Description {
    Description {
        schema_version: 1,
        player_version: env!("CARGO_PKG_VERSION"),
        package_versions: [1],
        profiles: [PROFILE],
        capabilities: [PACKAGE_ASSETS_CAPABILITY],
        target: target(),
        backend: threejs_native_runtime::backend_name(),
        v8: threejs_native_runtime::engine_version(),
    }
}
