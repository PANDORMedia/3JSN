use super::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
};
use threejs_native_package::{COMPILED_DOM_PROFILE, DOM_FONT_CAPABILITY, ResourceKind};

fn ui() -> Value {
    json!({"format":FORMAT,"version":VERSION,
        "source":{"name":"fixture.html","sha256":"0".repeat(64),"byteLength":0},
        "document":{"mode":"no-quirks","scriptingEnabled":false},
        "nodes":[
            {"kind":"document","children":[1],"source":null},
            {"kind":"element","name":"html","namespace":"http://www.w3.org/1999/xhtml","prefix":null,"attributes":[],"children":[2],"source":null},
            {"kind":"element","name":"body","namespace":"http://www.w3.org/1999/xhtml","prefix":null,"attributes":[],"children":[],"source":null}
        ],"diagnostics":[],"diagnosticsTotal":0,"diagnosticsTruncated":false})
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "3jsn-compiled-options-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join("app")).unwrap();
        fs::write(
            path.join("app/main.mjs"),
            b"throw new Error('must never execute during verification');",
        )
        .unwrap();
        fs::write(
            path.join("app/font.woff2"),
            b"font bytes are integrity-checked, not decoded during verification",
        )
        .unwrap();
        fs::write(path.join("app/style.css"), b"body { color: red }").unwrap();
        fs::write(
            path.join("behavior.js"),
            b"// supplied only for measurement, not package verification",
        )
        .unwrap();
        Self(path)
    }
    fn write(&self, input: &Value, mode: HtmlParserMode, resources: bool) -> PathBuf {
        fs::write(
            self.0.join("app/ui.json"),
            serde_json::to_vec(input).unwrap(),
        )
        .unwrap();
        let paths = if resources {
            vec![
                "app/main.mjs",
                "app/font.woff2",
                "app/ui.json",
                "app/style.css",
            ]
        } else {
            vec!["app/main.mjs", "app/font.woff2", "app/ui.json"]
        };
        let files: Vec<_> = paths.into_iter().map(|path| {let bytes=fs::read(self.0.join(path)).unwrap();json!({"path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes))})}).collect();
        let mut manifest = json!({"schemaVersion":1,"profile":COMPILED_DOM_PROFILE,"name":"fixture","target":threejs_native_package::target(),
            "entry":"app/main.mjs","font":"app/font.woff2",
            "compiledUi":{"path":"app/ui.json","format":FORMAT,"version":VERSION,"htmlParser":mode.as_str()},"files":files});
        if resources {
            manifest["requires"] = json!([DOM_FONT_CAPABILITY]);
            manifest["resources"] = json!([{"path":"app/style.css","kind":"stylesheet"}]);
        }
        self.write_manifest(&manifest)
    }
    fn write_manifest(&self, manifest: &Value) -> PathBuf {
        let path = self.0.join("app.json");
        fs::write(&path, serde_json::to_vec(manifest).unwrap()).unwrap();
        path
    }
    fn command(&self, flag: &str) -> Vec<OsString> {
        vec![flag.into(), self.0.join("app.json").into()]
    }
    fn executable(&self) -> PathBuf {
        self.0.join("player")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn description_advertises_exact_profile_and_compiled_parser_contract() {
    let value = description();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["packageVersions"], json!([1]));
    assert_eq!(value["profiles"], json!([COMPILED_DOM_PROFILE]));
    assert_eq!(value["packageProfiles"], value["profiles"]);
    assert_eq!(value["capabilities"], json!([DOM_FONT_CAPABILITY]));
    assert_eq!(value["backend"], "metal");
    assert_eq!(
        value["compiledUi"],
        json!({"format":FORMAT,"versions":[VERSION],"htmlParser":parser_mode().as_str()})
    );
    assert_eq!(value["dynamicHtml"], cfg!(feature = "dynamic-html"));
    assert!(matches!(
        parse(&["--describe".into()], Path::new("unused")).unwrap(),
        Command::Describe
    ));
}

#[test]
fn malformed_arguments_fail_before_attempting_package_io() {
    for args in [
        vec!["--describe", "extra"],
        vec!["--verify-app"],
        vec!["--verify-app", "missing", "extra"],
        vec!["--app"],
        vec!["--frames", "0"],
        vec!["--frames", "-1"],
        vec!["--frames", "1.5"],
        vec!["--frames", "1", "extra"],
        vec!["--app", "missing", "--frames", "0"],
        vec!["--measure-app", "missing", "script", "--unknown"],
        vec![
            "--measure-layout",
            "missing",
            "font",
            "script",
            "--verify",
            "extra",
        ],
        vec!["--unknown"],
    ] {
        let args: Vec<_> = args.into_iter().map(OsString::from).collect();
        let error = parse(&args, Path::new("unused/player"))
            .err()
            .expect("invalid arguments accepted")
            .to_string();
        assert!(
            error.contains("Usage:") || error.contains("positive integer"),
            "{error}"
        );
    }
}

#[test]
fn preflight_checks_schema_and_all_subdocument_hooks_without_construction() {
    let mut input = ui();
    assert!(preflight_json(&serde_json::to_vec(&input).unwrap(), false).is_ok());
    input["version"] = json!(99);
    assert!(preflight_json(&serde_json::to_vec(&input).unwrap(), true).is_err());
    input = ui();
    input["nodes"][2]["children"] = json!([3]);
    input["nodes"].as_array_mut().unwrap().push(json!({"kind":"element","name":"iframe","namespace":"http://www.w3.org/1999/xhtml","prefix":null,"attributes":[],"children":[],"source":null}));
    assert!(preflight_json(&serde_json::to_vec(&input).unwrap(), true).is_ok());
    assert!(
        preflight_json(&serde_json::to_vec(&input).unwrap(), false)
            .unwrap_err()
            .to_string()
            .contains("iframe")
    );
    input["nodes"][3]["namespace"] = json!("http://www.w3.org/2000/svg");
    assert!(
        preflight_json(&serde_json::to_vec(&input).unwrap(), false)
            .unwrap_err()
            .to_string()
            .contains("foreign iframe")
    );
}

#[test]
#[cfg(target_os = "macos")]
fn verified_packages_select_adjacent_or_explicit_manifest_with_strict_resources() {
    let fixture = Fixture::new();
    fixture.write(&ui(), parser_mode(), false);
    assert!(matches!(
        parse(&fixture.command("--verify-app"), &fixture.executable()).unwrap(),
        Command::Verified
    ));
    for args in [
        Vec::new(),
        fixture.command("--app"),
        vec!["--frames".into(), "7".into()],
    ] {
        let Command::Run(options) = parse(&args, &fixture.executable()).unwrap() else {
            panic!("expected window options")
        };
        assert_eq!(
            options.module,
            fixture.0.join("app/main.mjs").canonicalize().unwrap()
        );
        assert!(options.resources.unwrap().is_empty());
        assert_eq!(options.document.0.nodes.len(), 3);
        assert_eq!(
            description()["compiledUi"]["format"],
            options.document.0.format
        );
        assert_eq!(
            description()["compiledUi"]["versions"],
            json!([options.document.0.version])
        );
        assert_eq!(
            options.frames,
            if args.first().is_some_and(|v| v == "--frames") {
                Some(7)
            } else {
                None
            }
        );
    }
    fixture.write(&ui(), parser_mode(), true);
    let Command::Run(options) = parse(&fixture.command("--app"), &fixture.executable()).unwrap()
    else {
        panic!("expected window options")
    };
    let resources = options.resources.unwrap();
    assert_eq!(resources.len(), 1);
    assert_eq!(resources[0].kind, ResourceKind::Stylesheet);
    assert_eq!(resources[0].bytes, b"body { color: red }");
}

#[test]
#[cfg(target_os = "macos")]
fn verified_ui_bytes_are_not_reopened_and_measure_app_does_not_select_entry_module() {
    let fixture = Fixture::new();
    let manifest = fixture.write(&ui(), parser_mode(), true);
    let app = load_for(&manifest, Profile::CompiledDomWindow(parser_mode())).unwrap();
    fs::remove_file(fixture.0.join("app/ui.json")).unwrap();
    let options = from_application(app, None).unwrap();
    assert_eq!(options.document.0.nodes.len(), 3);
    fixture.write(&ui(), parser_mode(), true);
    let args = vec![
        "--measure-app".into(),
        manifest.into(),
        fixture.0.join("behavior.js").into(),
        "--verify".into(),
    ];
    let Command::Measure(options) = parse(&args, &fixture.executable()).unwrap() else {
        panic!("expected measurement")
    };
    assert_eq!(options.behavior, fixture.0.join("behavior.js"));
    assert!(options.verify);
    assert_eq!(options.resources.len(), 1);
}

#[test]
#[cfg(target_os = "macos")]
fn package_preflight_rejects_format_version_mode_and_invalid_verified_ir() {
    let fixture = Fixture::new();
    let manifest = fixture.write(&ui(), parser_mode(), false);
    for (field, value) in [("format", json!("future-format")), ("version", json!(2))] {
        let mut data: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        data["compiledUi"][field] = value;
        fixture.write_manifest(&data);
        let error = parse(&fixture.command("--verify-app"), &fixture.executable())
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("descriptor format or version"), "{error}");
        fixture.write(&ui(), parser_mode(), false);
    }
    let other = if parser_mode() == HtmlParserMode::Preserved {
        HtmlParserMode::Restricted
    } else {
        HtmlParserMode::Preserved
    };
    fixture.write(&ui(), other, false);
    assert!(parse(&fixture.command("--verify-app"), &fixture.executable()).is_err());
    let mut bad = ui();
    bad["nodes"][2]["children"] = json!([0]);
    fixture.write(&bad, parser_mode(), false);
    assert!(parse(&fixture.command("--verify-app"), &fixture.executable()).is_err());
}

#[test]
fn direct_commands_preflight_ir_before_font_or_module_access() {
    let fixture = Fixture::new();
    let path = fixture.0.join("bad.json");
    fs::write(&path, b"{}").unwrap();
    let args = vec![
        "--compiled-ui".into(),
        path.into(),
        "missing-font".into(),
        "missing-module".into(),
    ];
    let error = parse(&args, &fixture.executable())
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("invalid compiled UI JSON"), "{error}");
}

#[test]
#[cfg(target_os = "macos")]
fn package_verification_applies_the_actual_runtime_parser_capability() {
    let fixture = Fixture::new();
    let mut input = ui();
    input["nodes"][2]["children"] = json!([3]);
    input["nodes"].as_array_mut().unwrap().push(json!({
        "kind":"element","name":"iframe","namespace":"http://www.w3.org/1999/xhtml",
        "prefix":null,"attributes":[],"children":[],"source":null
    }));
    fixture.write(&input, parser_mode(), false);
    let result = parse(&fixture.command("--verify-app"), &fixture.executable());
    if cfg!(feature = "dynamic-html") {
        assert!(matches!(result.unwrap(), Command::Verified));
    } else {
        assert!(result.err().unwrap().to_string().contains("iframe"));
    }
}

#[test]
fn direct_window_and_measurement_commands_preserve_explicit_inputs() {
    let fixture = Fixture::new();
    let ui = fixture.0.join("ui.json");
    fs::write(&ui, serde_json::to_vec(&self::ui()).unwrap()).unwrap();
    let args = vec![
        "--compiled-ui".into(),
        ui.clone().into(),
        fixture.0.join("app/font.woff2").into(),
        fixture.0.join("app/main.mjs").into(),
        "--frames".into(),
        "2".into(),
    ];
    let Command::Run(options) = parse(&args, &fixture.executable()).unwrap() else {
        panic!("expected window options")
    };
    assert_eq!(options.frames, Some(2));
    assert!(options.resources.unwrap().is_empty());
    let args = vec![
        "--measure-layout".into(),
        ui.into(),
        fixture.0.join("app/font.woff2").into(),
        fixture.0.join("behavior.js").into(),
        "--verify".into(),
    ];
    let Command::Measure(options) = parse(&args, &fixture.executable()).unwrap() else {
        panic!("expected measurement options")
    };
    assert!(options.verify);
    assert!(options.resources.is_empty());
    assert_eq!(options.behavior, fixture.0.join("behavior.js"));
}
