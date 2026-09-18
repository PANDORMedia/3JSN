use std::{fs::File, io::Read, path::Path};

use crate::{MAX_FONT_BYTES, Manifest, PackageError, invalid, io_error};

/// Read an explicitly supplied developer font with the fallback font size bound.
/// This does not verify a manifest hash or decode the font. Packaged callers must
/// use `Application::font`, which retains the bytes checked by `load_for`.
pub fn read_font(path: &Path) -> Result<Vec<u8>, PackageError> {
    read_bytes(
        File::open(path).map_err(|error| io_error(path, error))?,
        path,
    )
}

pub(super) fn read_bytes(file: File, path: &Path) -> Result<Vec<u8>, PackageError> {
    let mut bytes = Vec::new();
    file.take(MAX_FONT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error(path, error))?;
    if bytes.len() as u64 > MAX_FONT_BYTES {
        return Err(invalid("fallback font exceeds 16 MiB"));
    }
    Ok(bytes)
}

pub(super) fn validate(manifest: &Manifest) -> Result<(), PackageError> {
    if manifest
        .files
        .iter()
        .any(|file| manifest.font.as_ref() == Some(&file.path) && file.bytes > MAX_FONT_BYTES)
    {
        return Err(invalid("fallback font exceeds 16 MiB"));
    }
    Ok(())
}
