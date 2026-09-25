use std::{fs, path::PathBuf};

use serde_json::json;
use sha2::{Digest, Sha256};
use threejs_native_runtime::Runtime;
use url::Url;

struct PackageFixture(PathBuf);

impl Drop for PackageFixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires a native hardware GPU; validates package-to-Three.js texture readback"]
async fn packaged_image_bitmap_renders_through_threejs_to_the_native_gpu() {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let package = PackageFixture(
        std::env::temp_dir().join(format!("3jsn-package-image-gpu-{}", std::process::id())),
    );
    fs::create_dir_all(package.0.join("app")).unwrap();
    let image = fs::read(fixture.join("checker.png")).unwrap();
    let entry = format!(
        "import {};\n",
        serde_json::to_string(
            &Url::from_file_path(fixture.join("package-image-gpu.mjs"))
                .unwrap()
                .to_string()
        )
        .unwrap()
    );
    fs::write(package.0.join("app/checker.png"), &image).unwrap();
    fs::write(package.0.join("app/main.mjs"), &entry).unwrap();
    let identity = |path: &str, bytes: &[u8]| {
        let hash = Sha256::digest(bytes);
        json!({ "path": path, "bytes": bytes.len(), "sha256": hash.iter().map(|byte| format!("{byte:02x}")).collect::<String>() })
    };
    fs::write(
        package.0.join("app.json"),
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "profile": "native-window-v1",
            "name": "package-image-gpu",
            "target": threejs_native_package::target(),
            "entry": "app/main.mjs",
            "requires": ["package-assets-v1"],
            "resources": [{ "path": "app/checker.png", "kind": "image" }],
            "files": [
                identity("app/checker.png", &image),
                identity("app/main.mjs", entry.as_bytes()),
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    let app = threejs_native_package::load(&package.0.join("app.json")).unwrap();
    Runtime::with_package_resources(app.resources.unwrap_or_default())
        .execute_module(&app.entry)
        .await
        .unwrap();
}
