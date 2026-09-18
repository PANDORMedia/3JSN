use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

use threejs_native_package::{Application, Profile, load_for, read_font};

use crate::Result;

pub enum DocumentInput {
    Html(String),
    Compiled(Vec<u8>),
}

impl DocumentInput {
    pub fn into_dom(self, config: blitz_dom::DocumentConfig) -> Result<deno_core::Extension> {
        match self {
            Self::Html(html) => Ok(crate::dom_bridge::extension(&html, config)),
            Self::Compiled(bytes) => {
                let loaded = threejs_compiled_ui_experiment::load_json(&bytes, config)?;
                println!("{}", serde_json::json!({"compiledUi": loaded.report}));
                Ok(crate::dom_bridge::extension_with_document(loaded.document))
            }
        }
    }
}

pub struct Options {
    pub font: Vec<u8>,
    pub document: DocumentInput,
    pub module: PathBuf,
    pub frames: Option<u64>,
    pub resources: Option<Vec<threejs_native_package::Resource>>,
}

pub enum Command {
    Describe,
    Verify(PathBuf),
    Run(Options),
}

pub const USAGE: &str = "Usage: threejs-dom-window-probe <font> <html> <bundled-app> [frame-count]\n       threejs-dom-window-probe --compiled-ui <ui.json> <font> <bundled-app> [--frames COUNT]\n       threejs-dom-window-probe --describe\n       threejs-dom-window-probe --verify-app <app.json>\n       threejs-dom-window-probe --app <app.json> [--frames COUNT]\n       packaged-executable [--frames COUNT]";

pub fn description() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "playerVersion": env!("CARGO_PKG_VERSION"),
        "packageVersions": [1],
        "profiles": [threejs_native_package::DOM_PROFILE],
        "capabilities": [threejs_native_package::DOM_FONT_CAPABILITY],
        "target": threejs_native_package::target(),
        "backend": "metal",
        "v8": deno_core::v8::V8::get_version(),
    })
}

fn frame_count(value: &OsString) -> Result<u64> {
    value
        .to_str()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|count| *count > 0)
        .ok_or_else(|| "frame count must be a positive integer".into())
}

fn frame_option(args: &[OsString]) -> Result<Option<u64>> {
    match args {
        [] => Ok(None),
        [flag, value] if flag == "--frames" => Ok(Some(frame_count(value)?)),
        _ => Err(USAGE.into()),
    }
}

fn package(manifest: &Path, frames: Option<u64>) -> Result<Command> {
    from_application(load_for(manifest, Profile::DomWindow)?, frames)
}

fn from_application(app: Application, frames: Option<u64>) -> Result<Command> {
    let html = app.html.ok_or("DOM package has no HTML entry")?;
    let font = app.font.ok_or("DOM package has no font")?;
    Ok(Command::Run(Options {
        font,
        document: DocumentInput::Html(std::fs::read_to_string(html)?),
        module: app.entry,
        frames,
        resources: app.resources,
    }))
}

pub fn parse(args: &[OsString], executable: &Path) -> Result<Command> {
    match args {
        [flag] if flag == "--describe" => Ok(Command::Describe),
        [flag, path] if flag == "--verify-app" => Ok(Command::Verify(path.into())),
        [flag, manifest, rest @ ..] if flag == "--app" => {
            package(Path::new(manifest), frame_option(rest)?)
        }
        [flag, ui, font, module, rest @ ..] if flag == "--compiled-ui" => {
            use std::io::Read;
            use threejs_compiled_ui_experiment::contract::MAX_IR_BYTES;
            let frames = frame_option(rest)?;
            let mut bytes = Vec::new();
            std::fs::File::open(ui)?
                .take(MAX_IR_BYTES as u64 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > MAX_IR_BYTES {
                return Err("compiled UI input exceeds 16 MiB".into());
            }
            Ok(Command::Run(Options {
                font: read_font(Path::new(font))?,
                document: DocumentInput::Compiled(bytes),
                module: PathBuf::from(module).canonicalize()?,
                frames,
                resources: Some(Vec::new()),
            }))
        }
        [] => package(&executable.with_file_name("app.json"), None),
        [flag, ..] if flag == "--frames" => {
            package(&executable.with_file_name("app.json"), frame_option(args)?)
        }
        [first, ..] if first.to_str().is_some_and(|value| value.starts_with('-')) => {
            Err(USAGE.into())
        }
        [font, html, module, rest @ ..] if rest.len() <= 1 => Ok(Command::Run(Options {
            font: read_font(Path::new(font))?,
            document: DocumentInput::Html(std::fs::read_to_string(html)?),
            module: PathBuf::from(module).canonicalize()?,
            frames: rest.first().map(frame_count).transpose()?,
            resources: None,
        })),
        _ => Err(USAGE.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn interpreted_package_options_use_owned_fallback_bytes() {
        use sha2::{Digest, Sha256};
        use std::{
            fs,
            sync::atomic::{AtomicU64, Ordering},
        };

        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "3jsn-interpreted-font-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("app")).unwrap();
        let files: Vec<_> = [
            ("app/main.mjs", b"throw new Error('must not execute');".as_slice()),
            ("app/index.html", b"<!doctype html><body>fixture</body>".as_slice()),
            ("app/font.woff2", b"verified original fallback".as_slice()),
        ].into_iter().map(|(path, bytes)| {
            fs::write(root.join(path), bytes).unwrap();
            serde_json::json!({"path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes))})
        }).collect();
        let manifest = root.join("app.json");
        fs::write(
            &manifest,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion":1,"profile":threejs_native_package::DOM_PROFILE,
                "target":threejs_native_package::target(),"name":"fixture",
                "entry":"app/main.mjs","html":"app/index.html","font":"app/font.woff2","files":files
            }))
            .unwrap(),
        )
        .unwrap();
        let app = load_for(&manifest, Profile::DomWindow).unwrap();
        fs::remove_file(root.join("app/font.woff2")).unwrap();
        let Command::Run(options) = from_application(app, None).unwrap() else {
            panic!("expected interpreted window options");
        };
        assert_eq!(options.font, b"verified original fallback");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn diagnostics_are_gpu_independent_and_arguments_are_strict() {
        let exe = Path::new("unused/player");
        assert!(matches!(
            parse(&["--describe".into()], exe).unwrap(),
            Command::Describe
        ));
        assert!(matches!(
            parse(&["--verify-app".into(), "app.json".into()], exe).unwrap(),
            Command::Verify(_)
        ));
        for args in [
            vec!["--describe", "extra"],
            vec!["--verify-app"],
            vec!["--app"],
            vec!["--frames", "0"],
            vec!["--frames", "-1"],
            vec!["--frames", "1.5"],
            vec!["--frames", "1", "extra"],
            vec!["--unknown"],
        ] {
            let args: Vec<_> = args.into_iter().map(OsString::from).collect();
            assert!(parse(&args, exe).is_err());
        }
        assert_eq!(
            description()["profiles"],
            serde_json::json!(["dom-window-v1"])
        );
    }
}
