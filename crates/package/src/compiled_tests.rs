use super::{tests::Fixture, *};
use serde_json::{Value, json};

const UI: &[u8] = b"{\"opaqueRuntimeData\":true}\n";

pub(super) fn manifest(fixture: &Fixture, mode: HtmlParserMode, resources: bool) -> Value {
    let mut value = if resources {
        fixture.font_manifest()
    } else {
        fixture.dom_manifest()
    };
    value["profile"] = json!(COMPILED_DOM_PROFILE);
    value.as_object_mut().unwrap().remove("html");
    value["compiledUi"] = json!({
        "path":"app/ui.json", "format":"3jsn-static-ui-experiment", "version":1,
        "htmlParser":mode.as_str(),
    });
    fs::write(fixture.0.join("app/ui.json"), UI).unwrap();
    value["files"].as_array_mut().unwrap().push(json!({
        "path":"app/ui.json", "bytes":UI.len(), "sha256":format!("{:x}", Sha256::digest(UI))
    }));
    value
}

#[test]
fn compiled_descriptor_rejects_null_unknown_missing_and_mistyped_fields() {
    let fixture = Fixture::new();
    let valid = manifest(&fixture, HtmlParserMode::Preserved, false);
    assert!(serde_json::from_value::<Manifest>(valid.clone()).is_ok());
    for descriptor in [Value::Null, json!([]), json!("app/ui.json")] {
        let mut value = valid.clone();
        value["compiledUi"] = descriptor;
        assert!(serde_json::from_value::<Manifest>(value).is_err());
    }
    for key in ["path", "format", "version", "htmlParser"] {
        let mut value = valid.clone();
        value["compiledUi"].as_object_mut().unwrap().remove(key);
        assert!(serde_json::from_value::<Manifest>(value).is_err());
        let mut value = valid.clone();
        value["compiledUi"][key] = Value::Null;
        assert!(serde_json::from_value::<Manifest>(value).is_err());
    }
    for (key, invalid) in [
        ("unexpected", json!(true)),
        ("path", json!(123)),
        ("format", json!(false)),
        ("version", json!(-1)),
        ("version", json!(1.5)),
        ("version", json!(u64::from(u32::MAX) + 1)),
        ("htmlParser", json!("automatic")),
        ("htmlParser", json!("Preserved")),
    ] {
        let mut value = valid.clone();
        value["compiledUi"][key] = invalid;
        assert!(serde_json::from_value::<Manifest>(value).is_err());
    }
    let serialized = serde_json::to_string(&valid).unwrap();
    let duplicate = serialized.replacen("\"version\":1", "\"version\":1,\"version\":1", 1);
    assert!(serde_json::from_str::<Manifest>(&duplicate).is_err());
}

#[test]
fn compiled_transport_metadata_is_bounded_but_not_runtime_format_validation() {
    let fixture = Fixture::new();
    let valid = manifest(&fixture, HtmlParserMode::Preserved, false);
    for format in ["future-format_2.0".into(), "a".repeat(128)] {
        let mut value = valid.clone();
        value["compiledUi"]["format"] = json!(format);
        value["compiledUi"]["version"] = json!(u32::MAX);
        let manifest: Manifest = serde_json::from_value(value).unwrap();
        compiled::validate(&manifest, HtmlParserMode::Preserved).unwrap();
    }
    for format in [
        "".into(),
        "a".repeat(129),
        "not an identifier".into(),
        "é".into(),
        ".prefix".into(),
        "a/b".into(),
    ] {
        let mut value = valid.clone();
        value["compiledUi"]["format"] = json!(format);
        let manifest: Manifest = serde_json::from_value(value).unwrap();
        assert!(compiled::validate(&manifest, HtmlParserMode::Preserved).is_err());
    }
    let mut value = valid;
    value["compiledUi"]["version"] = json!(0);
    let manifest: Manifest = serde_json::from_value(value).unwrap();
    assert!(compiled::validate(&manifest, HtmlParserMode::Preserved).is_err());
}

#[test]
fn parser_modes_are_exact_requirements_and_resources_reuse_existing_capability() {
    let fixture = Fixture::new();
    for mode in [HtmlParserMode::Preserved, HtmlParserMode::Restricted] {
        let mut value = manifest(&fixture, mode, true);
        let descriptor: Manifest = serde_json::from_value(value.clone()).unwrap();
        compiled::validate(&descriptor, mode).unwrap();
        let other = match mode {
            HtmlParserMode::Preserved => HtmlParserMode::Restricted,
            HtmlParserMode::Restricted => HtmlParserMode::Preserved,
        };
        assert!(matches!(
            compiled::validate(&descriptor, other),
            Err(PackageError::Incompatible { .. })
        ));
        validate_resources(&descriptor, Profile::CompiledDomWindow(mode)).unwrap();
        assert_eq!(
            Profile::CompiledDomWindow(mode).as_str(),
            COMPILED_DOM_PROFILE
        );
        for requirements in [
            json!([]),
            json!(["unknown"]),
            json!([DOM_FONT_CAPABILITY, DOM_FONT_CAPABILITY]),
        ] {
            value["requires"] = requirements;
            let descriptor: Manifest = serde_json::from_value(value.clone()).unwrap();
            assert!(validate_resources(&descriptor, Profile::CompiledDomWindow(mode)).is_err());
        }
    }
}

#[cfg(target_os = "macos")]
#[test]
fn compiled_ui_and_web_font_bytes_survive_relocation_and_later_disk_changes() {
    let mut fixture = Fixture::new();
    let mut value = manifest(&fixture, HtmlParserMode::Restricted, true);
    // Deliberately not a supported UI schema: only the runtime interprets it.
    value["compiledUi"]["format"] = json!("future-format");
    value["compiledUi"]["version"] = json!(37);
    fixture.write(&value);
    let moved = fixture.0.with_extension("compiled-relocated");
    fs::rename(&fixture.0, &moved).unwrap();
    fixture.0 = moved;
    let app = load_for(
        &fixture.0.join("app.json"),
        Profile::CompiledDomWindow(HtmlParserMode::Restricted),
    )
    .unwrap();
    assert!(app.html.is_none());
    assert_eq!(app.entry, fixture.0.join("app/main.mjs"));
    assert_eq!(app.font.unwrap(), b"integrity-only fixture");
    let ui = app.compiled_ui.unwrap();
    assert_eq!(ui.format, "future-format");
    assert_eq!(ui.version, 37);
    assert_eq!(ui.html_parser, HtmlParserMode::Restricted);
    fs::remove_file(fixture.0.join("app/ui.json")).unwrap();
    fs::write(fixture.0.join("app/type.css"), b"changed").unwrap();
    assert_eq!(ui.bytes, UI);
    assert_eq!(app.resources.unwrap()[0].bytes, b"body{}");
}

#[cfg(target_os = "macos")]
#[test]
fn compiled_profile_rejects_cross_profile_modes_and_conflicting_roles() {
    let fixture = Fixture::new();
    let mode = HtmlParserMode::Preserved;
    let valid = manifest(&fixture, mode, false);
    for profile in [
        Profile::NativeWindow,
        Profile::DomWindow,
        Profile::CompiledDomWindow(HtmlParserMode::Restricted),
    ] {
        assert!(matches!(
            load_for(&fixture.write(&valid), profile),
            Err(PackageError::Incompatible { .. })
        ));
    }
    for profile in [PROFILE, DOM_PROFILE] {
        let mut value = valid.clone();
        value["profile"] = json!(profile);
        let expected = if profile == PROFILE {
            Profile::NativeWindow
        } else {
            Profile::DomWindow
        };
        assert!(load_for(&fixture.write(&value), expected).is_err());
    }
    let mut cases = Vec::new();
    for field in ["compiledUi", "font"] {
        let mut value = valid.clone();
        value.as_object_mut().unwrap().remove(field);
        cases.push(value);
    }
    let mut value = valid.clone();
    value["html"] = json!("app/index.html");
    cases.push(value);
    for path in [
        "../ui.json",
        "app/../ui.json",
        "app/main.mjs",
        "app/font.woff2",
        "app/missing.json",
        "app/ui.txt",
        "app/UI.json",
    ] {
        let mut value = valid.clone();
        value["compiledUi"]["path"] = json!(path);
        cases.push(value);
    }
    let mut value = valid.clone();
    let mut duplicate = value["files"].as_array().unwrap().last().unwrap().clone();
    duplicate["path"] = json!("app/UI.json");
    value["files"].as_array_mut().unwrap().push(duplicate);
    cases.push(value);
    let mut value = valid;
    value["requires"] = json!([DOM_FONT_CAPABILITY]);
    value["resources"] = json!([{"path":"app/ui.json", "kind":"stylesheet"}]);
    cases.push(value);
    for value in cases {
        assert!(
            load_for(&fixture.write(&value), Profile::CompiledDomWindow(mode)).is_err(),
            "accepted {value}"
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn compiled_payload_requires_hash_size_and_existence() {
    let fixture = Fixture::new();
    let valid = manifest(&fixture, HtmlParserMode::Preserved, false);
    let manifest_path = fixture.write(&valid);
    let ui_path = fixture.0.join("app/ui.json");
    let profile = Profile::CompiledDomWindow(HtmlParserMode::Preserved);
    fs::write(&ui_path, vec![b'x'; UI.len()]).unwrap();
    assert!(
        matches!(load_for(&manifest_path, profile), Err(PackageError::Integrity(path)) if path == "app/ui.json")
    );
    fs::write(&ui_path, UI).unwrap();
    let mut value = valid;
    value["files"].as_array_mut().unwrap().last_mut().unwrap()["bytes"] = json!(UI.len() + 1);
    assert!(matches!(
        load_for(&fixture.write(&value), profile),
        Err(PackageError::Integrity(_))
    ));
    fs::remove_file(&ui_path).unwrap();
    assert!(matches!(
        load_for(&manifest_path, profile),
        Err(PackageError::Io { .. })
    ));
}

#[cfg(target_os = "macos")]
#[test]
fn compiled_payload_limit_applies_to_declared_and_actual_bytes_inclusively() {
    let fixture = Fixture::new();
    let mut value = manifest(&fixture, HtmlParserMode::Restricted, false);
    let profile = Profile::CompiledDomWindow(HtmlParserMode::Restricted);
    let ui_path = fixture.0.join("app/ui.json");
    value["files"].as_array_mut().unwrap().last_mut().unwrap()["bytes"] =
        json!(MAX_COMPILED_UI_BYTES + 1);
    fs::remove_file(&ui_path).unwrap();
    assert!(
        load_for(&fixture.write(&value), profile)
            .unwrap_err()
            .to_string()
            .contains("compiled UI exceeds 16 MiB")
    );
    value["files"].as_array_mut().unwrap().last_mut().unwrap()["bytes"] = json!(UI.len());
    File::create(&ui_path)
        .unwrap()
        .set_len(MAX_COMPILED_UI_BYTES + 1)
        .unwrap();
    assert!(
        load_for(&fixture.write(&value), profile)
            .unwrap_err()
            .to_string()
            .contains("compiled UI exceeds 16 MiB")
    );
    let bytes = vec![b' '; MAX_COMPILED_UI_BYTES as usize];
    fs::write(&ui_path, &bytes).unwrap();
    let file = value["files"].as_array_mut().unwrap().last_mut().unwrap();
    file["bytes"] = json!(bytes.len());
    file["sha256"] = json!(format!("{:x}", Sha256::digest(&bytes)));
    let app = load_for(&fixture.write(&value), profile).unwrap();
    assert_eq!(app.compiled_ui.unwrap().bytes, bytes);
}

#[cfg(target_os = "macos")]
#[test]
fn compiled_payload_and_parent_symlinks_are_rejected() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let value = manifest(&fixture, HtmlParserMode::Preserved, false);
    let path = fixture.write(&value);
    let profile = Profile::CompiledDomWindow(HtmlParserMode::Preserved);
    let payload = fixture.0.join("app/ui.json");
    let original = fixture.0.join("original.json");
    fs::rename(&payload, &original).unwrap();
    symlink("../original.json", &payload).unwrap();
    assert!(matches!(
        load_for(&path, profile),
        Err(PackageError::Manifest(_))
    ));
    fs::remove_file(&payload).unwrap();
    fs::rename(&original, &payload).unwrap();
    fs::rename(fixture.0.join("app"), fixture.0.join("original")).unwrap();
    symlink("original", fixture.0.join("app")).unwrap();
    assert!(matches!(
        load_for(&path, profile),
        Err(PackageError::Manifest(_))
    ));
}

#[cfg(not(target_os = "macos"))]
#[test]
fn compiled_profile_does_not_claim_other_host_support() {
    let fixture = Fixture::new();
    for mode in [HtmlParserMode::Preserved, HtmlParserMode::Restricted] {
        let value = manifest(&fixture, mode, false);
        assert!(
            load_for(&fixture.write(&value), Profile::CompiledDomWindow(mode))
                .unwrap_err()
                .to_string()
                .contains("macOS Metal")
        );
    }
}
