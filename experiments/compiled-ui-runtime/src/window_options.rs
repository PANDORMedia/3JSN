use std::{
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
};

use threejs_compiled_ui_experiment::contract::MAX_IR_BYTES;

use crate::Result;

pub struct DocumentInput(pub Vec<u8>);

impl DocumentInput {
    pub fn into_dom(self, config: blitz_dom::DocumentConfig) -> Result<deno_core::Extension> {
        #[cfg(feature = "dynamic-html")]
        let loaded = threejs_compiled_ui_experiment::load_json(&self.0, config)?;
        #[cfg(not(feature = "dynamic-html"))]
        let loaded = threejs_compiled_ui_experiment::load_json_restricted(&self.0, config)?;
        println!("{}", serde_json::json!({"compiledUi": loaded.report}));
        Ok(crate::dom_bridge::extension_with_document(loaded.document))
    }
}

pub struct Options {
    pub font: Vec<u8>,
    pub document: DocumentInput,
    pub module: PathBuf,
    pub frames: Option<u64>,
    pub resources: Option<Vec<threejs_native_package::Resource>>,
}

pub const USAGE: &str = "Usage: threejs-compiled-ui-runtime --compiled-ui <ui.json> <font> <bundled-app> [--frames COUNT]\n       threejs-compiled-ui-runtime --measure-layout <ui.json> <font> <behavior.js> [--verify]\n       threejs-compiled-ui-runtime --describe";

pub fn input(ui: &Path) -> Result<DocumentInput> {
    let mut bytes = Vec::new();
    std::fs::File::open(ui)?
        .take(MAX_IR_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_IR_BYTES {
        return Err("compiled UI input exceeds 16 MiB".into());
    }
    Ok(DocumentInput(bytes))
}

pub fn window(args: &[OsString]) -> Result<Options> {
    let [flag, ui, font, module, rest @ ..] = args else {
        return Err(USAGE.into());
    };
    if flag != "--compiled-ui" {
        return Err(USAGE.into());
    }
    let frames = match rest {
        [] => None,
        [flag, count] if flag == "--frames" => Some(
            count
                .to_str()
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|n| *n > 0)
                .ok_or("frame count must be a positive integer")?,
        ),
        _ => return Err(USAGE.into()),
    };
    Ok(Options {
        font: std::fs::read(font)?,
        document: input(Path::new(ui))?,
        module: PathBuf::from(module).canonicalize()?,
        frames,
        resources: Some(Vec::new()),
    })
}
