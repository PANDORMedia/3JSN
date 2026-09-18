use std::{fs, path::PathBuf, process::Command};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

struct Fixture(PathBuf);

impl Drop for Fixture {
    fn drop(&mut self) {
        let mut retries = 0;
        loop {
            match fs::remove_dir_all(&self.0) {
                Ok(()) => break,
                Err(error)
                    if cfg!(windows)
                        && matches!(error.raw_os_error(), Some(32 | 33))
                        && retries < 20 =>
                {
                    // Windows can briefly retain an executable mapping after the
                    // child has exited. Retry only sharing/lock violations.
                    retries += 1;
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(error) => panic!(
                    "failed to remove package fixture {}: {error}",
                    self.0.display()
                ),
            }
        }
    }
}

#[test]
fn packaged_executable_discovers_its_manifest_and_rejects_damage_without_a_gpu() {
    let player = env!("CARGO_BIN_EXE_threejs-native-player");
    let description = Command::new(player).arg("--describe").output().unwrap();
    assert!(description.status.success());
    let description: Value = serde_json::from_slice(&description.stdout).unwrap();
    assert_eq!(description["packageVersions"], json!([1]));
    assert_eq!(description["profiles"], json!(["native-window-v1"]));

    let fixture =
        Fixture(std::env::temp_dir().join(format!("3jsn-package-cli-{}", std::process::id())));
    fs::create_dir(&fixture.0).unwrap();
    let package = fixture.0.join("relocated game");
    fs::create_dir(&package).unwrap();
    fs::create_dir(package.join("app")).unwrap();
    let executable = package.join(format!("test-game{}", std::env::consts::EXE_SUFFIX));
    fs::copy(player, &executable).unwrap();
    let source = b"throw new Error('must not execute during verification');\n";
    fs::write(package.join("app/main.mjs"), source).unwrap();
    let manifest = json!({
        "schemaVersion": 1, "profile": "native-window-v1", "name": "test-game",
        "target": description["target"], "entry": "app/main.mjs", "files": [{
            "path": "app/main.mjs", "bytes": source.len(),
            "sha256": format!("{:x}", Sha256::digest(source))
        }]
    });
    fs::write(
        package.join("app.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let verified = Command::new(&executable)
        .args(["--verify-app", "relocated game/app.json"])
        .current_dir(&fixture.0)
        .output()
        .unwrap();
    assert!(
        verified.status.success(),
        "{}",
        String::from_utf8_lossy(&verified.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&verified.stdout).unwrap(),
        json!({"packageVerified":true})
    );

    fs::write(package.join("app/main.mjs"), b"throw 'modified';\n").unwrap();
    let damaged = Command::new(&executable)
        .current_dir(&fixture.0)
        .output()
        .unwrap();
    assert_eq!(damaged.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&damaged.stderr).contains("integrity verification: app/main.mjs")
    );
    assert!(damaged.stdout.is_empty());
    let invalid = Command::new(&executable)
        .arg("--unknown")
        .current_dir(&fixture.0)
        .output()
        .unwrap();
    assert_eq!(invalid.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&invalid.stderr).contains("Usage:"));
}
