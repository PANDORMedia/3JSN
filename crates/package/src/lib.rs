//! Local package validation before the event loop starts. Hashes detect damaged
//! artifacts; unsigned manifests and trusted application code are not a sandbox.

use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
pub const PROFILE: &str = "native-window-v1";
pub const DOM_PROFILE: &str = "dom-window-v1";
pub const DOM_FONT_CAPABILITY: &str = "dom-package-fonts-v1";
pub const PACKAGE_ASSETS_CAPABILITY: &str = "package-assets-v1";
pub const MAX_RESOURCES: usize = 64;
pub const MAX_STYLESHEET_BYTES: u64 = 1024 * 1024;
pub const MAX_FONT_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_RESOURCE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResourceKind {
    Font,
    Stylesheet,
    Image,
}

impl ResourceKind {
    pub fn byte_limit(self) -> u64 {
        match self {
            Self::Font => MAX_FONT_BYTES,
            Self::Stylesheet => MAX_STYLESHEET_BYTES,
            Self::Image => MAX_IMAGE_BYTES,
        }
    }
}

/// Integrity-checked bytes owned by the player, independent of later disk changes.
#[derive(Debug)]
pub struct Resource {
    pub path: String,
    pub kind: ResourceKind,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    NativeWindow,
    DomWindow,
}

impl Profile {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NativeWindow => PROFILE,
            Self::DomWindow => DOM_PROFILE,
        }
    }
}

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
    #[serde(default, deserialize_with = "present_string")]
    html: Option<String>,
    #[serde(default, deserialize_with = "present_string")]
    font: Option<String>,
    #[serde(default, deserialize_with = "present_vec")]
    requires: Option<Vec<String>>,
    #[serde(default, deserialize_with = "present_vec")]
    resources: Option<Vec<ResourceDescriptor>>,
    files: Vec<PackageFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResourceDescriptor {
    path: String,
    kind: ResourceKind,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PackageFile {
    path: String,
    sha256: String,
    bytes: u64,
}

fn present_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

fn present_vec<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<T>>, D::Error> {
    Vec::deserialize(deserializer).map(Some)
}

#[derive(Debug)]
pub struct Application {
    pub entry: PathBuf,
    pub html: Option<PathBuf>,
    pub font: Option<PathBuf>,
    pub resources: Option<Vec<Resource>>,
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

fn validate_resources(manifest: &Manifest, profile: Profile) -> Result<(), PackageError> {
    let resources = match (&manifest.requires, &manifest.resources) {
        (None, None) => return Ok(()),
        (Some(requires), Some(resources))
            if profile == Profile::DomWindow && requires == &[DOM_FONT_CAPABILITY] =>
        {
            resources
        }
        (Some(requires), Some(resources))
            if profile == Profile::NativeWindow && requires == &[PACKAGE_ASSETS_CAPABILITY] =>
        {
            resources
        }
        _ => {
            return Err(invalid(
                "resources require a profile-supported package capability",
            ));
        }
    };
    if resources.len() > MAX_RESOURCES {
        return Err(invalid("package exceeds 64 resources"));
    }
    let mut paths = HashSet::new();
    let mut total = 0_u64;
    for resource in resources {
        validate_path(&resource.path)?;
        if !paths.insert(resource.path.to_lowercase()) {
            return Err(invalid(format!("duplicate resource: {}", resource.path)));
        }
        if resource.path == manifest.entry
            || Some(&resource.path) == manifest.html.as_ref()
            || Some(&resource.path) == manifest.font.as_ref()
        {
            return Err(invalid(
                "resource paths must be distinct from entry, HTML and fallback font",
            ));
        }
        let suffixes: &[&str] = match resource.kind {
            ResourceKind::Font => &[".ttf", ".otf", ".woff", ".woff2"],
            ResourceKind::Stylesheet => &[".css"],
            ResourceKind::Image => &[".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp"],
        };
        match profile {
            Profile::NativeWindow if resource.kind != ResourceKind::Image => {
                return Err(invalid("native-window-v1 supports image resources only"));
            }
            Profile::DomWindow if resource.kind == ResourceKind::Image => {
                return Err(invalid("image resources require native-window-v1"));
            }
            _ => {}
        }
        let lowercase_path = resource.path.to_ascii_lowercase();
        if !suffixes
            .iter()
            .any(|suffix| lowercase_path.ends_with(suffix))
        {
            return Err(invalid(format!(
                "resource kind does not match its path: {}",
                resource.path
            )));
        }
        let file = manifest
            .files
            .iter()
            .find(|file| file.path == resource.path)
            .ok_or_else(|| {
                invalid(format!(
                    "resource must be listed in files: {}",
                    resource.path
                ))
            })?;
        if file.bytes > resource.kind.byte_limit() {
            return Err(invalid(format!(
                "resource exceeds its byte limit: {}",
                resource.path
            )));
        }
        total = total
            .checked_add(file.bytes)
            .ok_or_else(|| invalid("resource size overflow"))?;
        if total > MAX_RESOURCE_BYTES {
            return Err(invalid("package resource bytes exceed 64 MiB"));
        }
    }
    Ok(())
}

fn validate_manifest(manifest: &Manifest, profile: Profile) -> Result<(), PackageError> {
    if manifest.schema_version != 1 {
        return Err(invalid("expected schemaVersion 1"));
    }
    if manifest.profile != profile.as_str() {
        return Err(PackageError::Incompatible {
            required: manifest.profile.clone(),
            actual: profile.as_str().into(),
        });
    }
    if target() == "unsupported" || manifest.target != target() {
        return Err(PackageError::Incompatible {
            required: manifest.target.clone(),
            actual: target().into(),
        });
    }
    if profile == Profile::DomWindow && !target().starts_with("macos-") {
        return Err(invalid(
            "dom-window-v1 requires the experimental macOS Metal player",
        ));
    }
    if manifest.name.is_empty()
        || manifest.name.len() > 64
        || !manifest
            .name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || manifest.name.starts_with('-')
        || reserved_component(&manifest.name)
        || matches!(manifest.name.as_str(), "app" | "metadata")
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
    match (profile, &manifest.html, &manifest.font) {
        (Profile::NativeWindow, None, None) => {}
        (Profile::DomWindow, Some(html), Some(font)) => {
            for path in [html, font] {
                validate_path(path)?;
                if !manifest.files.iter().any(|file| &file.path == path) {
                    return Err(invalid("HTML and font must be listed in files"));
                }
            }
            if !html.ends_with(".html") || !font.ends_with(".woff2") {
                return Err(invalid("DOM package requires .html and .woff2 paths"));
            }
            if html == font || html == &manifest.entry || font == &manifest.entry {
                return Err(invalid("DOM package entry, HTML and font must be distinct"));
            }
        }
        (Profile::NativeWindow, _, _) => {
            return Err(invalid(
                "native-window-v1 does not accept HTML or font fields",
            ));
        }
        (Profile::DomWindow, _, _) => {
            return Err(invalid("dom-window-v1 requires HTML and font fields"));
        }
    }
    validate_resources(manifest, profile)
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
    load_for(manifest_path, Profile::NativeWindow)
}

/// Verify only the profile this executable implements; every listed payload is
/// checked before callers create a window, realm or GPU device.
pub fn load_for(manifest_path: &Path, profile: Profile) -> Result<Application, PackageError> {
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
    validate_manifest(&manifest, profile)?;
    let mut resources = manifest.resources.as_ref().map(|_| Vec::new());
    for item in &manifest.files {
        let path = root.join(&item.path);
        let mut file = regular_file(&root, &item.path)?;
        let mut hasher = Sha256::new();
        let resource = manifest
            .resources
            .as_ref()
            .and_then(|resources| resources.iter().find(|resource| resource.path == item.path));
        let size = if let Some(resource) = resource {
            let mut bytes = Vec::new();
            file.take(resource.kind.byte_limit() + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| io_error(&path, e))?;
            if bytes.len() as u64 > resource.kind.byte_limit() {
                return Err(invalid(format!(
                    "resource exceeds its byte limit: {}",
                    item.path
                )));
            }
            hasher.update(&bytes);
            let size = bytes.len() as u64;
            resources
                .as_mut()
                .expect("resource descriptors are present")
                .push(Resource {
                    path: item.path.clone(),
                    kind: resource.kind,
                    bytes,
                });
            size
        } else {
            io::copy(&mut file, &mut hasher).map_err(|e| io_error(&path, e))?
        };
        if size != item.bytes || format!("{:x}", hasher.finalize()) != item.sha256 {
            return Err(PackageError::Integrity(item.path.clone()));
        }
    }
    Ok(Application {
        entry: root.join(manifest.entry),
        html: manifest.html.map(|path| root.join(path)),
        font: manifest.font.map(|path| root.join(path)),
        resources,
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

        fn dom_manifest(&self) -> Value {
            let mut manifest = self.manifest();
            manifest["profile"] = json!(DOM_PROFILE);
            manifest["html"] = json!("app/index.html");
            manifest["font"] = json!("app/font.woff2");
            for (path, bytes) in [
                (
                    "app/index.html",
                    b"<!doctype html><canvas></canvas>".as_slice(),
                ),
                ("app/font.woff2", b"integrity-only fixture".as_slice()),
            ] {
                fs::write(self.0.join(path), bytes).unwrap();
                manifest["files"].as_array_mut().unwrap().push(json!({
                    "path": path, "bytes": bytes.len(),
                    "sha256": format!("{:x}", Sha256::digest(bytes)),
                }));
            }
            manifest
        }

        fn font_manifest(&self) -> Value {
            let mut manifest = self.dom_manifest();
            manifest["requires"] = json!([DOM_FONT_CAPABILITY]);
            manifest["resources"] = json!([
                {"path":"app/type.css", "kind":"stylesheet"},
                {"path":"app/type.ttf", "kind":"font"},
            ]);
            for (path, bytes) in [
                ("app/type.css", b"body{}".as_slice()),
                ("app/type.ttf", b"font fixture".as_slice()),
            ] {
                fs::write(self.0.join(path), bytes).unwrap();
                manifest["files"].as_array_mut().unwrap().push(json!({
                    "path":path, "bytes":bytes.len(), "sha256":format!("{:x}", Sha256::digest(bytes))
                }));
            }
            manifest
        }

        fn image_manifest(&self) -> Value {
            let mut manifest = self.manifest();
            manifest["requires"] = json!([PACKAGE_ASSETS_CAPABILITY]);
            manifest["resources"] = json!([
                {"path":"app/assets/checker.png", "kind":"image"},
            ]);
            let bytes = b"verified image bytes";
            fs::create_dir_all(self.0.join("app/assets")).unwrap();
            fs::write(self.0.join("app/assets/checker.png"), bytes).unwrap();
            manifest["files"].as_array_mut().unwrap().push(json!({
                "path":"app/assets/checker.png", "bytes":bytes.len(),
                "sha256":format!("{:x}", Sha256::digest(bytes))
            }));
            manifest
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
    fn each_player_accepts_only_its_advertised_profile() {
        let fixture = Fixture::new();
        assert!(matches!(
            load_for(&fixture.write(&fixture.manifest()), Profile::DomWindow),
            Err(PackageError::Incompatible { .. })
        ));
        assert!(matches!(
            load(&fixture.write(&fixture.dom_manifest())),
            Err(PackageError::Incompatible { .. })
        ));
        for key in ["html", "font"] {
            for value in [Value::Null, json!("app/extra.html")] {
                let mut manifest = fixture.manifest();
                manifest[key] = value;
                assert!(matches!(
                    load(&fixture.write(&manifest)),
                    Err(PackageError::Manifest(_))
                ));
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dom_packages_relocate_and_verify_both_ui_payloads() {
        let mut fixture = Fixture::new();
        let manifest = fixture.dom_manifest();
        fixture.write(&manifest);
        let moved = fixture.0.with_extension("dom-relocated");
        fs::rename(&fixture.0, &moved).unwrap();
        fixture.0 = moved;
        let path = fixture.0.join("app.json");
        let app = load_for(&path, Profile::DomWindow).unwrap();
        assert_eq!(app.html.unwrap(), fixture.0.join("app/index.html"));
        assert_eq!(app.font.unwrap(), fixture.0.join("app/font.woff2"));
        for payload in ["app/index.html", "app/font.woff2"] {
            let file = fixture.0.join(payload);
            let original = fs::read(&file).unwrap();
            fs::write(&file, b"damaged").unwrap();
            assert!(matches!(
                load_for(&path, Profile::DomWindow),
                Err(PackageError::Integrity(_))
            ));
            fs::write(&file, original).unwrap();
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dom_ui_paths_must_be_present_typed_contained_and_listed() {
        let fixture = Fixture::new();
        let valid = fixture.dom_manifest();
        for key in ["html", "font"] {
            let mut missing = valid.clone();
            missing.as_object_mut().unwrap().remove(key);
            assert!(load_for(&fixture.write(&missing), Profile::DomWindow).is_err());
            for value in [
                Value::Null,
                json!("../escape.html"),
                json!("app/main.mjs"),
                json!("app/missing.woff2"),
            ] {
                let mut manifest = valid.clone();
                manifest[key] = value;
                assert!(load_for(&fixture.write(&manifest), Profile::DomWindow).is_err());
            }
        }
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

    #[cfg(target_os = "macos")]
    #[test]
    fn resources_are_verified_once_and_owned_after_relocation() {
        let mut fixture = Fixture::new();
        fixture.write(&fixture.font_manifest());
        let moved = fixture.0.with_extension("resources-relocated");
        fs::rename(&fixture.0, &moved).unwrap();
        fixture.0 = moved;
        let path = fixture.0.join("app.json");
        let app = load_for(&path, Profile::DomWindow).unwrap();
        let resources = app.resources.unwrap();
        assert_eq!(resources.len(), 2);
        fs::write(fixture.0.join("app/type.css"), b"bad CSS").unwrap();
        assert_eq!(resources[0].bytes, b"body{}");
        assert_eq!(resources[0].kind, ResourceKind::Stylesheet);
        assert!(matches!(
            load_for(&path, Profile::DomWindow),
            Err(PackageError::Integrity(_))
        ));
    }

    #[test]
    fn native_image_resources_are_verified_and_owned_after_relocation() {
        let mut fixture = Fixture::new();
        fixture.write(&fixture.image_manifest());
        let moved = fixture.0.with_extension("images-relocated");
        fs::rename(&fixture.0, &moved).unwrap();
        fixture.0 = moved;
        let path = fixture.0.join("app.json");
        let app = load(&path).unwrap();
        let resources = app.resources.unwrap();
        assert_eq!(resources.len(), 1);
        assert_eq!(resources[0].path, "app/assets/checker.png");
        assert_eq!(resources[0].kind, ResourceKind::Image);
        assert_eq!(resources[0].bytes, b"verified image bytes");

        fs::write(fixture.0.join("app/assets/checker.png"), b"damaged").unwrap();
        assert_eq!(resources[0].bytes, b"verified image bytes");
        assert!(matches!(load(&path), Err(PackageError::Integrity(_))));
    }

    #[test]
    fn native_image_resource_validation_accepts_mixed_case_suffixes() {
        let fixture = Fixture::new();
        let mut manifest = fixture.image_manifest();
        let old_path = "app/assets/checker.png";
        let new_path = "app/assets/checker.PNG";
        fs::rename(fixture.0.join(old_path), fixture.0.join(new_path)).unwrap();
        manifest["resources"][0]["path"] = json!(new_path);
        manifest["files"][1]["path"] = json!(new_path);
        assert_eq!(
            load(&fixture.write(&manifest)).unwrap().resources.unwrap()[0].kind,
            ResourceKind::Image
        );
    }

    #[test]
    fn resource_capabilities_are_explicit_and_profile_specific() {
        let fixture = Fixture::new();
        for (requires, resources) in [
            (json!([DOM_FONT_CAPABILITY]), json!([])),
            (Value::Null, json!([])),
        ] {
            let mut manifest = fixture.manifest();
            manifest["requires"] = requires;
            manifest["resources"] = resources;
            assert!(load(&fixture.write(&manifest)).is_err());
        }
        let valid = fixture.font_manifest();
        // Exercise this profile's schema on every host, independently of host admission.
        let validate = |value: &Value| {
            let manifest: Manifest =
                serde_json::from_value(value.clone()).map_err(|e| invalid(e.to_string()))?;
            validate_resources(&manifest, Profile::DomWindow)
        };
        assert!(validate(&valid).is_ok());
        for key in ["requires", "resources"] {
            let mut value = valid.clone();
            value.as_object_mut().unwrap().remove(key);
            assert!(validate(&value).is_err());
            value[key] = Value::Null;
            assert!(validate(&value).is_err());
        }
        for requires in [
            json!([]),
            json!(["unknown"]),
            json!([DOM_FONT_CAPABILITY, DOM_FONT_CAPABILITY]),
        ] {
            let mut value = valid.clone();
            value["requires"] = requires;
            assert!(validate(&value).is_err());
        }
        let mut empty = valid.clone();
        empty["resources"] = json!([]);
        assert!(validate(&empty).is_ok());
        for resource in [
            json!({"path":"app/missing.css","kind":"stylesheet"}),
            json!({"path":"app/type.css","kind":"font"}),
            json!({"path":"app/font.woff2","kind":"font"}),
            json!({"path":"app/type.css","kind":"image"}),
            json!({"path":"app/../type.css","kind":"stylesheet"}),
        ] {
            let mut value = valid.clone();
            value["resources"][0] = resource;
            assert!(validate(&value).is_err(), "accepted {value}");
        }
        let mut duplicate = valid.clone();
        duplicate["resources"][1] = duplicate["resources"][0].clone();
        assert!(validate(&duplicate).is_err());
        let mut too_many = valid.clone();
        too_many["resources"] = json!(vec![valid["resources"][0].clone(); MAX_RESOURCES + 1]);
        assert!(validate(&too_many).unwrap_err().to_string().contains("64"));
        for (index, limit) in [(3, MAX_STYLESHEET_BYTES), (4, MAX_FONT_BYTES)] {
            let mut value = valid.clone();
            value["files"][index]["bytes"] = json!(limit + 1);
            assert!(
                validate(&value)
                    .unwrap_err()
                    .to_string()
                    .contains("byte limit")
            );
        }
    }

    #[test]
    fn each_profile_rejects_resources_the_runtime_does_not_serve() {
        for (kind, path, bytes) in [
            ("font", "app/assets/type.ttf", b"font bytes".as_slice()),
            ("stylesheet", "app/assets/type.css", b"body{}".as_slice()),
        ] {
            let fixture = Fixture::new();
            let mut manifest = fixture.image_manifest();
            manifest["resources"] = json!([{ "path": path, "kind": kind }]);
            fs::write(fixture.0.join(path), bytes).unwrap();
            manifest["files"].as_array_mut().unwrap().push(json!({
                "path": path, "bytes": bytes.len(), "sha256": format!("{:x}", Sha256::digest(bytes))
            }));
            let error = load_for(&fixture.write(&manifest), Profile::NativeWindow).unwrap_err();
            assert!(error.to_string().contains("supports image resources only"));
        }

        let fixture = Fixture::new();
        let mut manifest = fixture.font_manifest();
        let path = "app/assets/checker.png";
        let bytes = b"image bytes";
        fs::create_dir_all(fixture.0.join("app/assets")).unwrap();
        fs::write(fixture.0.join(path), bytes).unwrap();
        manifest["resources"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "path": path, "kind": "image" }));
        manifest["files"].as_array_mut().unwrap().push(json!({
            "path": path, "bytes": bytes.len(), "sha256": format!("{:x}", Sha256::digest(bytes))
        }));
        let error = load_for(&fixture.write(&manifest), Profile::DomWindow).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("image resources require native-window-v1")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn actual_resource_bytes_cannot_exceed_declared_role_limits() {
        let fixture = Fixture::new();
        let manifest = fixture.font_manifest();
        let path = fixture.write(&manifest);
        File::create(fixture.0.join("app/type.css"))
            .unwrap()
            .set_len(MAX_STYLESHEET_BYTES + 1)
            .unwrap();
        let error = load_for(&path, Profile::DomWindow).unwrap_err();
        assert!(error.to_string().contains("byte limit"));
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
