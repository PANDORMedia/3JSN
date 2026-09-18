use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

use threejs_native_package::{Profile, load_for};

use crate::Result;

pub struct Options {
    pub font: Vec<u8>,
    pub html: String,
    pub module: PathBuf,
    pub frames: Option<u64>,
    pub resources: Option<Vec<threejs_native_package::Resource>>,
}

pub enum Command {
    Describe,
    Verify(PathBuf),
    Run(Options),
}

pub const USAGE: &str = "Usage: threejs-dom-window-probe <font> <html> <bundled-app> [frame-count]\n       threejs-dom-window-probe --describe\n       threejs-dom-window-probe --verify-app <app.json>\n       threejs-dom-window-probe --app <app.json> [--frames COUNT]\n       packaged-executable [--frames COUNT]";

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
    let app = load_for(manifest, Profile::DomWindow)?;
    let html = app.html.ok_or("DOM package has no HTML entry")?;
    let font = app.font.ok_or("DOM package has no font")?;
    Ok(Command::Run(Options {
        font: std::fs::read(font)?,
        html: std::fs::read_to_string(html)?,
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
        [] => package(&executable.with_file_name("app.json"), None),
        [flag, ..] if flag == "--frames" => {
            package(&executable.with_file_name("app.json"), frame_option(args)?)
        }
        [first, ..] if first.to_str().is_some_and(|value| value.starts_with('-')) => {
            Err(USAGE.into())
        }
        [font, html, module, rest @ ..] if rest.len() <= 1 => Ok(Command::Run(Options {
            font: std::fs::read(font)?,
            html: std::fs::read_to_string(html)?,
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
