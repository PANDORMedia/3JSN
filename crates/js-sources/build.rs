// Embedded Deno source retains its upstream headers; see THIRD_PARTY_NOTICES.md
// and LICENSES/Deno-MIT.txt at the repository root.

use std::{collections::BTreeMap, env, fmt::Write, fs, path::PathBuf, sync::Arc};

use deno_core::{Extension, ExtensionFileSourceCode};

fn collect_sources(extension: Extension, sources: &mut BTreeMap<&'static str, String>) {
    for source in [
        &extension.js_files,
        &extension.esm_files,
        &extension.lazy_loaded_esm_files,
        &extension.lazy_loaded_js_files,
    ]
    .into_iter()
    .flat_map(|files| files.iter())
    {
        if let ExtensionFileSourceCode::LoadedFromFsDuringSnapshot(path) = source.code {
            println!("cargo:rerun-if-changed={path}");
        }
        let code = source
            .load()
            .unwrap_or_else(|error| panic!("cannot embed {}: {error}", source.specifier))
            .to_string();
        assert!(
            code.is_ascii(),
            "extension source is not ASCII: {}",
            source.specifier
        );
        assert!(
            sources.insert(source.specifier, code).is_none(),
            "duplicate embedded extension specifier: {}",
            source.specifier
        );
    }
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let extensions = [
        deno_webidl::deno_webidl::init(),
        deno_web::deno_web::init(
            Arc::new(deno_web::BlobStore::default()),
            None,
            false,
            deno_web::InMemoryBroadcastChannel::default(),
        ),
        deno_webgpu::deno_webgpu::init(),
    ];
    let mut sources = BTreeMap::new();
    for extension in extensions {
        collect_sources(extension, &mut sources);
    }

    // Literal bytes keep generated output independent of checkout and registry paths.
    let mut generated =
        String::from("static EMBEDDED_SOURCES: &[(&str, deno_core::FastStaticString)] = &[\n");
    for (specifier, code) in sources {
        writeln!(
            generated,
            "    ({specifier:?}, deno_core::ascii_str!({code:?})),"
        )
        .unwrap();
    }
    generated.push_str("];\n");
    let destination = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo must set OUT_DIR"))
        .join("embedded_extension_sources.rs");
    fs::write(destination, generated).expect("cannot write embedded extension source table");
}
