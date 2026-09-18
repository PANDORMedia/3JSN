use super::{tests::Fixture, *};
use serde_json::{Value, json};

const PROFILE_MODE: Profile = Profile::CompiledDomWindow(HtmlParserMode::Preserved);
const CAPABILITIES: &[&str] = &[DOM_FONT_CAPABILITY, NATIVE_WEBGL_CAPABILITY];

fn manifest(fixture: &Fixture, fonts: bool) -> Value {
    let mut value = compiled_tests::manifest(fixture, HtmlParserMode::Preserved, fonts);
    value["target"] = json!("macos-arm64");
    value["nativeWebgl"] =
        json!({"backend":"angle-metal", "abiVersion":1, "directory":"app/native/angle"});
    value["requires"] = if fonts {
        json!(CAPABILITIES)
    } else {
        json!([NATIVE_WEBGL_CAPABILITY])
    };
    fs::create_dir_all(fixture.0.join("app/native/angle")).unwrap();
    for name in ["libEGL.dylib", "libGLESv2.dylib", "LICENSES"] {
        let path = format!("app/native/angle/{name}");
        let bytes = format!("integrity test fixture for {name}");
        fs::write(fixture.0.join(&path), &bytes).unwrap();
        value["files"].as_array_mut().unwrap().push(json!({
            "path":path,"bytes":bytes.len(),"sha256":format!("{:x}", Sha256::digest(bytes.as_bytes()))
        }));
    }
    value
}

fn validate(value: &Value, profile: Profile) -> Result<(), PackageError> {
    let manifest: Manifest =
        serde_json::from_value(value.clone()).map_err(|e| invalid(e.to_string()))?;
    native_webgl::validate(&manifest, profile)?;
    validate_resources(&manifest, profile)
}

#[test]
fn native_webgl_descriptor_and_capability_are_exact() {
    let fixture = Fixture::new();
    let valid = manifest(&fixture, false);
    validate(&valid, PROFILE_MODE).unwrap();
    for descriptor in [Value::Null, json!([]), json!("angle")] {
        let mut value = valid.clone();
        value["nativeWebgl"] = descriptor;
        assert!(validate(&value, PROFILE_MODE).is_err());
    }
    for field in ["backend", "abiVersion", "directory"] {
        let mut value = valid.clone();
        value["nativeWebgl"].as_object_mut().unwrap().remove(field);
        assert!(validate(&value, PROFILE_MODE).is_err());
        value = valid.clone();
        value["nativeWebgl"][field] = Value::Null;
        assert!(validate(&value, PROFILE_MODE).is_err());
    }
    for (field, bad) in [
        ("extra", json!(true)),
        ("backend", json!("angle-vulkan")),
        ("abiVersion", json!(0)),
        ("abiVersion", json!(2)),
        ("abiVersion", json!(1.5)),
        ("directory", json!("app/native/../angle")),
        ("directory", json!("/tmp/angle")),
        ("directory", json!("app/native/angle/")),
        ("directory", json!("app/native/other")),
    ] {
        let mut value = valid.clone();
        value["nativeWebgl"][field] = bad;
        assert!(validate(&value, PROFILE_MODE).is_err(), "accepted {value}");
    }
    for requirements in [
        json!([]),
        json!([DOM_FONT_CAPABILITY]),
        json!([NATIVE_WEBGL_CAPABILITY, NATIVE_WEBGL_CAPABILITY]),
        json!([NATIVE_WEBGL_CAPABILITY, "unknown"]),
    ] {
        let mut value = valid.clone();
        value["requires"] = requirements;
        assert!(validate(&value, PROFILE_MODE).is_err());
    }
    let mut value = valid.clone();
    value.as_object_mut().unwrap().remove("requires");
    assert!(validate(&value, PROFILE_MODE).is_err());
    value = valid.clone();
    value.as_object_mut().unwrap().remove("nativeWebgl");
    assert!(validate(&value, PROFILE_MODE).is_err());
    let serialized = serde_json::to_string(&valid).unwrap();
    let duplicate = serialized.replacen("\"abiVersion\":1", "\"abiVersion\":1,\"abiVersion\":1", 1);
    assert!(serde_json::from_str::<Manifest>(&duplicate).is_err());
}

#[test]
fn native_webgl_profiles_targets_and_fonts_are_independent() {
    let fixture = Fixture::new();
    for fonts in [false, true] {
        let valid = manifest(&fixture, fonts);
        for target in ["macos-arm64", "macos-x64"] {
            let mut value = valid.clone();
            value["target"] = json!(target);
            validate(&value, PROFILE_MODE).unwrap();
        }
        for target in ["linux-x64", "windows-x64", "macos-other"] {
            let mut value = valid.clone();
            value["target"] = json!(target);
            assert!(validate(&value, PROFILE_MODE).is_err());
        }
        for profile in [Profile::DomWindow, Profile::NativeWindow] {
            assert!(validate(&valid, profile).is_err());
        }
        if fonts {
            let mut value = valid.clone();
            value["requires"] = json!([NATIVE_WEBGL_CAPABILITY]);
            assert!(validate(&value, PROFILE_MODE).is_err());
            value = valid.clone();
            value.as_object_mut().unwrap().remove("resources");
            assert!(validate(&value, PROFILE_MODE).is_err());
            value = valid.clone();
            value["requires"] = json!([NATIVE_WEBGL_CAPABILITY, DOM_FONT_CAPABILITY]);
            validate(&value, PROFILE_MODE).unwrap();
        } else {
            let mut value = valid.clone();
            value["requires"] = json!(CAPABILITIES);
            assert!(validate(&value, PROFILE_MODE).is_err());
        }
    }
}

#[test]
fn native_webgl_payload_entries_are_required_and_bounded() {
    let fixture = Fixture::new();
    let valid = manifest(&fixture, false);
    for name in ["libEGL.dylib", "libGLESv2.dylib", "LICENSES"] {
        let path = format!("app/native/angle/{name}");
        let index = valid["files"]
            .as_array()
            .unwrap()
            .iter()
            .position(|f| f["path"] == path)
            .unwrap();
        let mut value = valid.clone();
        value["files"].as_array_mut().unwrap().remove(index);
        assert!(validate(&value, PROFILE_MODE).is_err());
        for size in [
            0,
            if name == "LICENSES" {
                4 * 1024 * 1024 + 1
            } else {
                64 * 1024 * 1024 + 1
            },
        ] {
            value = valid.clone();
            value["files"][index]["bytes"] = json!(size);
            assert!(validate(&value, PROFILE_MODE).is_err());
        }
        value = valid.clone();
        value["files"][index]["path"] = json!(format!("app/other/{name}"));
        assert!(validate(&value, PROFILE_MODE).is_err());
    }
}

#[cfg(target_os = "macos")]
#[test]
fn native_webgl_loading_checks_capabilities_integrity_and_relocation() {
    let mut fixture = Fixture::new();
    for fonts in [false, true] {
        let mut value = manifest(&fixture, fonts);
        value["target"] = json!(target());
        let path = fixture.write(&value);
        assert!(matches!(
            load_for(&path, PROFILE_MODE),
            Err(PackageError::Incompatible { .. })
        ));
        assert!(load_for_with_capabilities(&path, PROFILE_MODE, &[]).is_err());
        if fonts {
            assert!(
                load_for_with_capabilities(&path, PROFILE_MODE, &[NATIVE_WEBGL_CAPABILITY])
                    .is_err()
            );
        }
        let app = load_for_with_capabilities(&path, PROFILE_MODE, CAPABILITIES).unwrap();
        assert_eq!(app.native_webgl, Some(fixture.0.join("app/native/angle")));
        for name in ["libEGL.dylib", "libGLESv2.dylib", "LICENSES"] {
            let file = fixture.0.join("app/native/angle").join(name);
            let bytes = fs::read(&file).unwrap();
            fs::write(&file, b"corrupted").unwrap();
            assert!(matches!(
                load_for_with_capabilities(&path, PROFILE_MODE, CAPABILITIES),
                Err(PackageError::Integrity(_))
            ));
            fs::remove_file(&file).unwrap();
            assert!(load_for_with_capabilities(&path, PROFILE_MODE, CAPABILITIES).is_err());
            std::os::unix::fs::symlink(fixture.0.join("app/main.mjs"), &file).unwrap();
            assert!(load_for_with_capabilities(&path, PROFILE_MODE, CAPABILITIES).is_err());
            fs::remove_file(&file).unwrap();
            fs::write(&file, bytes).unwrap();
        }
    }
    let moved = fixture.0.with_extension("relocated");
    fs::rename(&fixture.0, &moved).unwrap();
    fixture.0 = moved;
    let app = load_for_with_capabilities(&fixture.0.join("app.json"), PROFILE_MODE, CAPABILITIES)
        .unwrap();
    assert_eq!(app.native_webgl, Some(fixture.0.join("app/native/angle")));
}

#[test]
fn native_webgl_payloads_cannot_also_be_dom_resources() {
    let fixture = Fixture::new();
    let valid = manifest(&fixture, true);
    for name in ["libEGL.dylib", "libGLESv2.dylib", "LICENSES"] {
        for kind in ["font", "stylesheet"] {
            let mut value = valid.clone();
            let path = format!("app/native/angle/{name}");
            value["resources"]
                .as_array_mut()
                .unwrap()
                .push(json!({"path": path, "kind": kind}));
            let parsed: Manifest = serde_json::from_value(value).unwrap();
            let error = native_webgl::validate(&parsed, PROFILE_MODE).unwrap_err();
            assert!(matches!(error, PackageError::Manifest(message)
                if message == format!("native WebGL files cannot also be DOM resources: {path}")));
        }
    }
}
