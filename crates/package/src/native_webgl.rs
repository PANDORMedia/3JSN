use serde::Deserialize;

use super::{Manifest, PackageError, Profile, invalid};

pub const NATIVE_WEBGL_CAPABILITY: &str = "native-webgl-angle-metal-v1";
const DIRECTORY: &str = "app/native/angle";
const FILES: [(&str, u64); 3] = [
    ("app/native/angle/libEGL.dylib", 64 * 1024 * 1024),
    ("app/native/angle/libGLESv2.dylib", 64 * 1024 * 1024),
    ("app/native/angle/LICENSES", 4 * 1024 * 1024),
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Descriptor {
    backend: String,
    abi_version: u32,
    pub directory: String,
}

pub(super) fn present_descriptor<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Descriptor>, D::Error> {
    Descriptor::deserialize(deserializer).map(Some)
}

pub(super) fn validate(manifest: &Manifest, profile: Profile) -> Result<(), PackageError> {
    let required = manifest
        .requires
        .iter()
        .flatten()
        .filter(|name| name.as_str() == NATIVE_WEBGL_CAPABILITY)
        .count();
    let Some(descriptor) = &manifest.native_webgl else {
        if required != 0 {
            return Err(invalid("native WebGL capability requires its descriptor"));
        }
        return Ok(());
    };
    if required != 1 {
        return Err(invalid(
            "native WebGL requires exactly one native-webgl-angle-metal-v1 capability",
        ));
    }
    if !matches!(profile, Profile::CompiledDomWindow(_))
        || !matches!(manifest.target.as_str(), "macos-arm64" | "macos-x64")
    {
        return Err(invalid(
            "native WebGL requires a compiled DOM package for macOS arm64 or x64",
        ));
    }
    if descriptor.backend != "angle-metal"
        || descriptor.abi_version != 1
        || descriptor.directory != DIRECTORY
    {
        return Err(invalid(
            "native WebGL requires angle-metal ABI 1 at app/native/angle",
        ));
    }
    for (path, limit) in FILES {
        if manifest
            .resources
            .iter()
            .flatten()
            .any(|resource| resource.path == path)
        {
            return Err(invalid(format!(
                "native WebGL files cannot also be DOM resources: {path}"
            )));
        }
        let file = manifest
            .files
            .iter()
            .find(|file| file.path == path)
            .ok_or_else(|| invalid(format!("native WebGL file must be listed: {path}")))?;
        if file.bytes == 0 || file.bytes > limit {
            return Err(invalid(format!(
                "native WebGL file exceeds its nonzero byte limit: {path}"
            )));
        }
    }
    Ok(())
}

pub(super) fn file_limit(manifest: &Manifest, path: &str) -> Option<u64> {
    manifest.native_webgl.as_ref()?;
    FILES
        .iter()
        .find_map(|(name, limit)| (*name == path).then_some(*limit))
}
