use std::{fs::File, io::Read, path::Path};

use serde::Deserialize;

use super::{Manifest, PackageError, invalid, io_error, validate_path};

pub const MAX_COMPILED_UI_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HtmlParserMode {
    Preserved,
    Restricted,
}

impl HtmlParserMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Preserved => "preserved",
            Self::Restricted => "restricted",
        }
    }
}

/// Verified transport bytes. The runtime validates the format, version and tree
/// before constructing its document; this crate does not interpret UI data.
#[derive(Debug)]
pub struct CompiledUi {
    pub format: String,
    pub version: u32,
    pub html_parser: HtmlParserMode,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Descriptor {
    pub path: String,
    pub format: String,
    pub version: u32,
    pub html_parser: HtmlParserMode,
}

pub(super) fn present_descriptor<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Descriptor>, D::Error> {
    Descriptor::deserialize(deserializer).map(Some)
}

pub(super) fn validate(manifest: &Manifest, mode: HtmlParserMode) -> Result<(), PackageError> {
    let ui = manifest
        .compiled_ui
        .as_ref()
        .expect("compiled profile has UI");
    let font = manifest.font.as_ref().expect("compiled profile has font");
    if ui.html_parser != mode {
        return Err(PackageError::Incompatible {
            required: format!("HTML parser mode {}", ui.html_parser.as_str()),
            actual: format!("HTML parser mode {}", mode.as_str()),
        });
    }
    if ui.format.is_empty()
        || ui.format.len() > 128
        || !ui.format.as_bytes()[0].is_ascii_alphanumeric()
        || !ui
            .format
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        || ui.version == 0
    {
        return Err(invalid(
            "compiled UI requires an ASCII format identifier of 1–128 bytes and a positive version",
        ));
    }
    for path in [&ui.path, font] {
        validate_path(path)?;
        if !manifest.files.iter().any(|file| &file.path == path) {
            return Err(invalid("compiled UI and font must be listed in files"));
        }
    }
    if !ui.path.ends_with(".json") || !font.ends_with(".woff2") {
        return Err(invalid(
            "compiled DOM package requires .json and .woff2 paths",
        ));
    }
    let roles = [&manifest.entry, &ui.path, font];
    let mut paths = std::collections::HashSet::new();
    if roles
        .into_iter()
        .any(|path| !paths.insert(path.to_lowercase()))
    {
        return Err(invalid(
            "compiled DOM entry, UI and font paths must be distinct",
        ));
    }
    let file = manifest
        .files
        .iter()
        .find(|file| file.path == ui.path)
        .unwrap();
    if file.bytes > MAX_COMPILED_UI_BYTES {
        return Err(invalid("compiled UI exceeds 16 MiB"));
    }
    Ok(())
}

pub(super) fn read_bytes(file: File, path: &Path) -> Result<Vec<u8>, PackageError> {
    let mut bytes = Vec::new();
    file.take(MAX_COMPILED_UI_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error(path, error))?;
    if bytes.len() as u64 > MAX_COMPILED_UI_BYTES {
        return Err(invalid("compiled UI exceeds 16 MiB"));
    }
    Ok(bytes)
}
