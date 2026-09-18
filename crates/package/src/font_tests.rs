use super::{tests::Fixture, *};

fn assert_font_limit(error: PackageError) {
    assert!(matches!(error, PackageError::Manifest(message)
        if message == "fallback font exceeds 16 MiB"));
}

#[test]
fn explicit_font_read_enforces_inclusive_size_bound_and_preserves_io_errors() {
    let fixture = Fixture::new();
    let path = fixture.0.join("font.woff2");
    let file = File::create(&path).unwrap();
    file.set_len(MAX_FONT_BYTES).unwrap();
    assert_eq!(read_font(&path).unwrap(), vec![0; MAX_FONT_BYTES as usize]);
    file.set_len(MAX_FONT_BYTES + 1).unwrap();
    assert_font_limit(read_font(&path).unwrap_err());
    drop(file);
    fs::remove_file(&path).unwrap();
    assert!(
        matches!(read_font(&path), Err(PackageError::Io { path: failed, source })
        if failed == path && source.kind() == io::ErrorKind::NotFound)
    );
}

#[cfg(target_os = "macos")]
mod packages {
    use super::*;
    use serde_json::{Value, json};

    const PROFILES: [Profile; 3] = [
        Profile::DomWindow,
        Profile::CompiledDomWindow(HtmlParserMode::Preserved),
        Profile::CompiledDomWindow(HtmlParserMode::Restricted),
    ];

    fn manifest(fixture: &Fixture, profile: Profile) -> Value {
        match profile {
            Profile::DomWindow => fixture.dom_manifest(),
            Profile::CompiledDomWindow(mode) => compiled_tests::manifest(fixture, mode, false),
            Profile::NativeWindow => unreachable!(),
        }
    }

    fn font_record(value: &mut Value) -> &mut Value {
        value["files"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|file| file["path"] == "app/font.woff2")
            .unwrap()
    }

    #[test]
    fn verified_fallback_bytes_survive_deletion_and_replacement_in_every_dom_profile() {
        for profile in PROFILES {
            for replacement in [None, Some(b"unverified replacement".as_slice())] {
                let fixture = Fixture::new();
                let value = manifest(&fixture, profile);
                let app = load_for(&fixture.write(&value), profile).unwrap();
                let path = fixture.0.join("app/font.woff2");
                fs::remove_file(&path).unwrap();
                if let Some(bytes) = replacement {
                    fs::write(&path, bytes).unwrap();
                }
                assert_eq!(app.font.unwrap(), b"integrity-only fixture");
            }
        }
    }

    #[test]
    fn declared_oversized_fallback_fails_before_payload_io() {
        for profile in PROFILES {
            let fixture = Fixture::new();
            let mut value = manifest(&fixture, profile);
            font_record(&mut value)["bytes"] = json!(MAX_FONT_BYTES + 1);
            fs::remove_file(fixture.0.join("app/main.mjs")).unwrap();
            fs::remove_file(fixture.0.join("app/font.woff2")).unwrap();
            assert_font_limit(load_for(&fixture.write(&value), profile).unwrap_err());
        }
    }

    #[test]
    fn actual_fallback_read_is_bounded_even_when_manifest_understates_size() {
        for profile in PROFILES {
            let fixture = Fixture::new();
            let value = manifest(&fixture, profile);
            File::create(fixture.0.join("app/font.woff2"))
                .unwrap()
                .set_len(MAX_FONT_BYTES + 1)
                .unwrap();
            assert_font_limit(load_for(&fixture.write(&value), profile).unwrap_err());
        }
    }

    #[test]
    fn fallback_hash_and_length_mismatches_report_the_font_path() {
        for profile in PROFILES {
            for wrong_length in [false, true] {
                let fixture = Fixture::new();
                let mut value = manifest(&fixture, profile);
                if wrong_length {
                    font_record(&mut value)["bytes"] = json!(1);
                } else {
                    fs::write(fixture.0.join("app/font.woff2"), b"INTEGRITY-ONLY FIXTURE").unwrap();
                }
                assert!(matches!(load_for(&fixture.write(&value), profile),
                    Err(PackageError::Integrity(path)) if path == "app/font.woff2"));
            }
        }
    }

    #[test]
    fn fallback_at_the_limit_is_hashed_and_retained() {
        let fixture = Fixture::new();
        let mut value = fixture.dom_manifest();
        let bytes = vec![17; MAX_FONT_BYTES as usize];
        fs::write(fixture.0.join("app/font.woff2"), &bytes).unwrap();
        let record = font_record(&mut value);
        record["bytes"] = json!(MAX_FONT_BYTES);
        record["sha256"] = json!(format!("{:x}", Sha256::digest(&bytes)));
        let app = load_for(&fixture.write(&value), Profile::DomWindow).unwrap();
        assert_eq!(app.font.unwrap(), bytes);
    }
}
