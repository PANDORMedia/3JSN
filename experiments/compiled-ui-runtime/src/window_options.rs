use std::{
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
};

use threejs_compiled_ui_experiment::{
    contract::{CompiledUi, FORMAT, MAX_IR_BYTES, VERSION},
    preflight_json,
};
use threejs_native_package::{Application, HtmlParserMode, Profile, Resource, load_for};

use crate::Result;

pub struct DocumentInput(CompiledUi);

impl DocumentInput {
    fn from_bytes(bytes: &[u8]) -> Result<Self> {
        Ok(Self(preflight_json(bytes, cfg!(feature = "dynamic-html"))?))
    }

    pub fn into_dom(self, config: blitz_dom::DocumentConfig) -> Result<deno_core::Extension> {
        #[cfg(feature = "dynamic-html")]
        let loaded = threejs_compiled_ui_experiment::load(&self.0, config)?;
        #[cfg(not(feature = "dynamic-html"))]
        let loaded = threejs_compiled_ui_experiment::load_restricted(&self.0, config)?;
        println!("{}", serde_json::json!({"compiledUi": loaded.report}));
        Ok(crate::dom_bridge::extension_with_document(loaded.document))
    }
}

pub struct Options {
    pub font: Vec<u8>,
    pub document: DocumentInput,
    pub module: PathBuf,
    pub frames: Option<u64>,
    pub resources: Option<Vec<Resource>>,
}

pub struct MeasurementOptions {
    pub font: Vec<u8>,
    pub document: DocumentInput,
    pub resources: Vec<Resource>,
    pub behavior: PathBuf,
    pub verify: bool,
}

pub enum Command {
    Describe,
    Verified,
    Run(Options),
    Measure(MeasurementOptions),
}

pub const USAGE: &str = "Usage: threejs-compiled-ui-runtime --compiled-ui <ui.json> <font> <bundled-app> [--frames COUNT]\n       threejs-compiled-ui-runtime --app <app.json> [--frames COUNT]\n       packaged-executable [--frames COUNT]\n       threejs-compiled-ui-runtime --verify-app <app.json>\n       threejs-compiled-ui-runtime --measure-layout <ui.json> <font> <behavior.js> [--verify]\n       threejs-compiled-ui-runtime --measure-app <app.json> <behavior.js> [--verify]\n       threejs-compiled-ui-runtime --describe";

fn parser_mode() -> HtmlParserMode {
    if cfg!(feature = "dynamic-html") {
        HtmlParserMode::Preserved
    } else {
        HtmlParserMode::Restricted
    }
}

pub fn description() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "playerVersion": env!("CARGO_PKG_VERSION"),
        "packageVersions": [1],
        "profiles": [threejs_native_package::COMPILED_DOM_PROFILE],
        "capabilities": [threejs_native_package::DOM_FONT_CAPABILITY],
        "target": threejs_native_package::target(),
        "backend": "metal",
        "v8": deno_core::v8::V8::get_version(),
        "compiledUi": {"format": FORMAT, "versions": [VERSION], "htmlParser": parser_mode().as_str()},
        "experiment": "compiled-ui-runtime",
        "dynamicHtml": cfg!(feature = "dynamic-html"),
        "packageProfiles": [threejs_native_package::COMPILED_DOM_PROFILE],
    })
}

pub fn input(ui: &Path) -> Result<DocumentInput> {
    let mut bytes = Vec::new();
    std::fs::File::open(ui)?
        .take(MAX_IR_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    DocumentInput::from_bytes(&bytes)
}

fn frame_option(args: &[OsString]) -> Result<Option<u64>> {
    match args {
        [] => Ok(None),
        [flag, count] if flag == "--frames" => count
            .to_str()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|n| *n > 0)
            .map(Some)
            .ok_or_else(|| "frame count must be a positive integer".into()),
        _ => Err(USAGE.into()),
    }
}

fn verification_option(args: &[OsString]) -> Result<bool> {
    match args {
        [] => Ok(false),
        [flag] if flag == "--verify" => Ok(true),
        _ => Err(USAGE.into()),
    }
}

fn package(manifest: &Path, frames: Option<u64>) -> Result<Options> {
    from_application(
        load_for(manifest, Profile::CompiledDomWindow(parser_mode()))?,
        frames,
    )
}

fn from_application(app: Application, frames: Option<u64>) -> Result<Options> {
    let ui = app
        .compiled_ui
        .ok_or("compiled DOM package has no compiled UI")?;
    if ui.format != FORMAT || ui.version != VERSION {
        return Err("compiled UI descriptor format or version is unsupported".into());
    }
    if ui.html_parser != parser_mode() {
        return Err("compiled UI parser mode does not match this runtime".into());
    }
    // Keep the package loader's verified bytes; never reopen the UI payload.
    let document = DocumentInput::from_bytes(&ui.bytes)?;
    let font = app.font.ok_or("compiled DOM package has no font")?;
    Ok(Options {
        font: std::fs::read(font)?,
        document,
        module: app.entry,
        frames,
        resources: Some(app.resources.unwrap_or_default()),
    })
}

pub fn parse(args: &[OsString], executable: &Path) -> Result<Command> {
    match args {
        [flag] if flag == "--describe" => Ok(Command::Describe),
        [flag, manifest] if flag == "--verify-app" => {
            package(Path::new(manifest), None)?;
            Ok(Command::Verified)
        }
        [flag, manifest, rest @ ..] if flag == "--app" => Ok(Command::Run(package(
            Path::new(manifest),
            frame_option(rest)?,
        )?)),
        [flag, ui, font, module, rest @ ..] if flag == "--compiled-ui" => {
            let frames = frame_option(rest)?;
            let document = input(Path::new(ui))?;
            Ok(Command::Run(Options {
                font: std::fs::read(font)?,
                document,
                module: PathBuf::from(module).canonicalize()?,
                frames,
                resources: Some(Vec::new()),
            }))
        }
        [flag, ui, font, behavior, rest @ ..] if flag == "--measure-layout" => {
            let verify = verification_option(rest)?;
            let document = input(Path::new(ui))?;
            Ok(Command::Measure(MeasurementOptions {
                font: std::fs::read(font)?,
                document,
                resources: Vec::new(),
                behavior: behavior.into(),
                verify,
            }))
        }
        [flag, manifest, behavior, rest @ ..] if flag == "--measure-app" => {
            let verify = verification_option(rest)?;
            let app = package(Path::new(manifest), None)?;
            Ok(Command::Measure(MeasurementOptions {
                font: app.font,
                document: app.document,
                resources: app.resources.unwrap_or_default(),
                behavior: behavior.into(),
                verify,
            }))
        }
        [] => Ok(Command::Run(package(
            &executable.with_file_name("app.json"),
            None,
        )?)),
        [flag, ..] if flag == "--frames" => Ok(Command::Run(package(
            &executable.with_file_name("app.json"),
            frame_option(args)?,
        )?)),
        _ => Err(USAGE.into()),
    }
}
