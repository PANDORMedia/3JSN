//! Local package validation before the event loop starts. Hashes detect damaged
//! artifacts; unsigned manifests and trusted application code are not a sandbox.

use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
pub const PROFILE: &str = "native-window-v1";

#[derive(Debug, thiserror::Error)]
pub enum PackageError {
    #[error("package IO at {path}: {source}")]
    Io { path: PathBuf, source: io::Error },
    #[error("invalid application manifest: {0}")]
    Manifest(String),
    #[error("package requires {required}, but this player provides {actual}")]
    Incompatible { required: String, actual: String },
    #[error("package file failed integrity verification: {0}")]
    Integrity(String),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    profile: String,
    name: String,
    target: String,
    entry: String,
    files: Vec<PackageFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PackageFile {
    path: String,
    sha256: String,
    bytes: u64,
}

#[derive(Debug)]
pub struct Application {
    pub entry: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Description {
    schema_version: u32,
    player_version: &'static str,
    package_versions: [u32; 1],
    profiles: [&'static str; 1],
    target: &'static str,
    backend: &'static str,
    v8: &'static str,
}

pub fn target() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "macos-arm64",
        ("macos", "x86_64") => "macos-x64",
        ("windows", "x86_64") => "windows-x64",
        ("linux", "x86_64") => "linux-x64",
        _ => "unsupported",
    }
}

pub fn description() -> Description {
    Description {
        schema_version: 1,
        player_version: env!("CARGO_PKG_VERSION"),
        package_versions: [1],
        profiles: [PROFILE],
        target: target(),
        backend: threejs_native_runtime::backend_name(),
        v8: threejs_native_runtime::engine_version(),
    }
}

fn io_error(path: &Path, source: io::Error) -> PackageError {
    PackageError::Io {
        path: path.to_owned(),
        source,
    }
}

fn invalid(message: impl Into<String>) -> PackageError {
    PackageError::Manifest(message.into())
}

fn reserved_component(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or_default();
    matches!(stem, "con" | "prn" | "aux" | "nul")
        || ((stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn validate_path(path: &str) -> Result<(), PackageError> {
    if !path.starts_with("app/")
        || path.contains(['\\', ':', '*', '?', '<', '>', '|', '"'])
        || path.chars().any(char::is_control)
        || path.split('/').any(|part| {
            part.is_empty()
                || matches!(part, "." | "..")
                || part.ends_with(['.', ' '])
                || reserved_component(&part.to_ascii_lowercase())
        })
    {
        return Err(invalid(format!(
            "expected a portable path under app/: {path:?}"
        )));
    }
    Ok(())
}

fn validate_manifest(manifest: &Manifest) -> Result<(), PackageError> {
    if manifest.schema_version != 1 {
        return Err(invalid("expected schemaVersion 1"));
    }
    if manifest.profile != PROFILE {
        return Err(PackageError::Incompatible {
            required: manifest.profile.clone(),
            actual: PROFILE.into(),
        });
    }
    if target() == "unsupported" || manifest.target != target() {
        return Err(PackageError::Incompatible {
            required: manifest.target.clone(),
            actual: target().into(),
        });
    }
    if manifest.name.is_empty()
        || manifest.name.len() > 64
        || !manifest
            .name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || manifest.name.starts_with('-')
        || reserved_component(&manifest.name)
    {
        return Err(invalid(
            "name must be a portable lowercase application slug",
        ));
    }
    if manifest.files.is_empty() || manifest.files.len() > 4096 {
        return Err(invalid("files must contain between 1 and 4096 entries"));
    }
    validate_path(&manifest.entry)?;
    if !manifest.entry.ends_with(".mjs") {
        return Err(invalid("entry must be an ECMAScript .mjs module"));
    }
    let mut paths = HashSet::new();
    for file in &manifest.files {
        validate_path(&file.path)?;
        if !paths.insert(file.path.to_lowercase()) {
            return Err(invalid(format!("duplicate package path: {}", file.path)));
        }
        if file.sha256.len() != 64
            || !file
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid(format!("invalid SHA-256 for {}", file.path)));
        }
    }
    if !manifest
        .files
        .iter()
        .any(|file| file.path == manifest.entry)
    {
        return Err(invalid("entry must be listed in files"));
    }
    Ok(())
}

fn regular_file(root: &Path, relative: &str) -> Result<File, PackageError> {
    let mut path = root.to_owned();
    let mut components = relative.split('/').peekable();
    while let Some(component) = components.next() {
        path.push(component);
        let metadata = fs::symlink_metadata(&path).map_err(|e| io_error(&path, e))?;
        let correct_type = if components.peek().is_some() {
            metadata.is_dir()
        } else {
            metadata.is_file()
        };
        if metadata.file_type().is_symlink() || !correct_type {
            return Err(invalid(format!(
                "package paths must be regular files/directories: {relative}"
            )));
        }
    }
    File::open(&path).map_err(|e| io_error(&path, e))
}

/// Resolve package contents independently of the process working directory.
/// The package must stay quiescent between verification and module loading.
pub fn load(manifest_path: &Path) -> Result<Application, PackageError> {
    let parent = manifest_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let root = fs::canonicalize(parent).map_err(|e| io_error(parent, e))?;
    let name = manifest_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| invalid("invalid manifest filename"))?;
    let mut file = regular_file(&root, name)?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| io_error(manifest_path, e))?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(invalid("manifest exceeds 1 MiB"));
    }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| invalid(e.to_string()))?;
    validate_manifest(&manifest)?;
    for item in &manifest.files {
        let path = root.join(&item.path);
        let mut file = regular_file(&root, &item.path)?;
        let mut hasher = Sha256::new();
        let size = io::copy(&mut file, &mut hasher).map_err(|e| io_error(&path, e))?;
        if size != item.bytes || format!("{:x}", hasher.finalize()) != item.sha256 {
            return Err(PackageError::Integrity(item.path.clone()));
        }
    }
    Ok(Application {
        entry: root.join(manifest.entry),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let root = std::env::temp_dir().join(format!(
                "3jsn-package-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            fs::create_dir(root.join("app")).unwrap();
            fs::write(root.join("app/main.mjs"), b"export {};\n").unwrap();
            Self(fs::canonicalize(root).unwrap())
        }

        fn manifest(&self) -> Value {
            json!({
                "schemaVersion": 1, "profile": PROFILE, "name": "test-game",
                "target": target(), "entry": "app/main.mjs", "files": [{
                    "path": "app/main.mjs", "bytes": 11,
                    "sha256": format!("{:x}", Sha256::digest(b"export {};\n"))
                }]
            })
        }

        fn write(&self, manifest: &Value) -> PathBuf {
            let path = self.0.join("app.json");
            fs::write(&path, serde_json::to_vec(manifest).unwrap()).unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn package_relocates_without_resolving_against_the_working_directory() {
        let mut fixture = Fixture::new();
        let original = fixture.write(&fixture.manifest());
        assert_eq!(
            load(&original).unwrap().entry,
            fixture.0.join("app/main.mjs")
        );
        let moved = fixture.0.with_extension("relocated");
        fs::rename(&fixture.0, &moved).unwrap();
        fixture.0 = moved;
        assert_eq!(
            load(&fixture.0.join("app.json")).unwrap().entry,
            fixture.0.join("app/main.mjs")
        );
    }

    #[test]
    fn damaged_or_missing_payloads_fail_before_execution() {
        let fixture = Fixture::new();
        let path = fixture.write(&fixture.manifest());
        fs::write(fixture.0.join("app/main.mjs"), b"throw 123;\n").unwrap();
        assert!(matches!(load(&path), Err(PackageError::Integrity(_))));
        fs::remove_file(fixture.0.join("app/main.mjs")).unwrap();
        assert!(matches!(load(&path), Err(PackageError::Io { .. })));
    }

    #[test]
    fn incompatible_and_ambiguous_manifests_are_rejected() {
        let fixture = Fixture::new();
        for (key, value) in [
            ("schemaVersion", json!(2)),
            ("profile", json!("experimental-desktop-v1")),
            ("target", json!("not-this-machine")),
            ("name", json!("con")),
            ("name", json!("../test")),
            ("entry", json!("app/missing.mjs")),
            ("undeclared", json!(true)),
        ] {
            let mut manifest = fixture.manifest();
            manifest[key] = value;
            assert!(
                load(&fixture.write(&manifest)).is_err(),
                "accepted {manifest}"
            );
        }
        let mut manifest = fixture.manifest();
        let mut duplicate = manifest["files"][0].clone();
        duplicate["path"] = json!("app/MAIN.mjs");
        manifest["files"].as_array_mut().unwrap().push(duplicate);
        assert!(
            load(&fixture.write(&manifest))
                .unwrap_err()
                .to_string()
                .contains("duplicate")
        );
        let mut manifest = fixture.manifest();
        manifest["files"][0]["bytes"] = json!(12);
        assert!(matches!(
            load(&fixture.write(&manifest)),
            Err(PackageError::Integrity(_))
        ));
    }

    #[test]
    fn package_paths_cannot_escape_or_alias_portable_names() {
        let fixture = Fixture::new();
        for path in [
            "../escape.mjs",
            "/app/main.mjs",
            "app/../main.mjs",
            "app/./main.mjs",
            "app//main.mjs",
            "app\\main.mjs",
            "app/C:main.mjs",
            "app/con.mjs",
            "app/COM1.mjs",
            "app/name./main.mjs",
            "app/line\nbreak.mjs",
            "app/*.mjs",
            "app/a?b.mjs",
            "app/a|b.mjs",
            "app/\"quoted\".mjs",
            "app/<name>.mjs",
        ] {
            let mut manifest = fixture.manifest();
            manifest["entry"] = json!(path);
            manifest["files"][0]["path"] = json!(path);
            assert!(
                matches!(
                    load(&fixture.write(&manifest)),
                    Err(PackageError::Manifest(_))
                ),
                "accepted {path}"
            );
        }
    }

    #[test]
    fn oversized_and_duplicate_field_manifests_fail() {
        let fixture = Fixture::new();
        let path = fixture.0.join("app.json");
        fs::write(&path, vec![b' '; MAX_MANIFEST_BYTES as usize + 1]).unwrap();
        assert!(load(&path).unwrap_err().to_string().contains("exceeds"));
        let json = serde_json::to_string(&fixture.manifest()).unwrap();
        fs::write(&path, json.replacen('{', "{\"schemaVersion\":1,", 1)).unwrap();
        assert!(
            load(&path)
                .unwrap_err()
                .to_string()
                .contains("duplicate field")
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_entries_directories_and_manifests_are_rejected() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let path = fixture.write(&fixture.manifest());
        let payload = fixture.0.join("app/main.mjs");
        fs::rename(&payload, fixture.0.join("original.mjs")).unwrap();
        symlink("../original.mjs", &payload).unwrap();
        assert!(matches!(load(&path), Err(PackageError::Manifest(_))));
        fs::remove_file(&payload).unwrap();
        fs::rename(fixture.0.join("original.mjs"), &payload).unwrap();
        fs::rename(fixture.0.join("app"), fixture.0.join("original")).unwrap();
        symlink("original", fixture.0.join("app")).unwrap();
        assert!(matches!(load(&path), Err(PackageError::Manifest(_))));
        fs::rename(&path, fixture.0.join("original.json")).unwrap();
        symlink("original.json", &path).unwrap();
        assert!(matches!(load(&path), Err(PackageError::Manifest(_))));
    }
}
