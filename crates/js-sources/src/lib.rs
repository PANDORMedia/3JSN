//! Compile-time sources for the shared Deno web extensions.

use deno_core::{Extension, ExtensionFileSource, ExtensionFileSourceCode};

include!(concat!(env!("OUT_DIR"), "/embedded_extension_sources.rs"));

deno_core::extension!(
    deno_net,
    lazy_loaded_js = [dir "src/deno_net", "02_tls.js"]
);

pub fn network_fetch_shim() -> Extension {
    deno_net::init()
}

/// Remove build-machine filesystem dependencies before Deno registers any sources.
/// Missing entries are a build integration defect, never a reason to read runtime files.
pub fn embed_extension_sources(extension: &mut Extension) {
    let name = extension.name;
    for sources in [
        &mut extension.js_files,
        &mut extension.esm_files,
        &mut extension.lazy_loaded_esm_files,
        &mut extension.lazy_loaded_js_files,
    ] {
        for source in sources.to_mut() {
            if matches!(
                source.code,
                ExtensionFileSourceCode::LoadedFromFsDuringSnapshot(_)
            ) {
                let index = EMBEDDED_SOURCES
                    .binary_search_by_key(&source.specifier, |(specifier, _)| *specifier)
                    .unwrap_or_else(|_| {
                        panic!(
                            "missing compiled extension source for {} in {name}",
                            source.specifier
                        )
                    });
                *source = ExtensionFileSource::new(source.specifier, EMBEDDED_SOURCES[index].1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{borrow::Cow, sync::Arc};

    use super::*;

    const UNAVAILABLE: &str = "/3jsn-embedding-test/source-must-not-be-read.js";

    fn all_sources(extension: &Extension) -> impl Iterator<Item = &ExtensionFileSource> {
        [
            &extension.js_files,
            &extension.esm_files,
            &extension.lazy_loaded_esm_files,
            &extension.lazy_loaded_js_files,
        ]
        .into_iter()
        .flat_map(|files| files.iter())
    }

    #[test]
    fn replaces_every_source_category_without_accessing_declared_paths() {
        let (specifier, expected) = EMBEDDED_SOURCES[0];
        let files = || {
            Cow::Owned(vec![ExtensionFileSource::loaded_during_snapshot(
                specifier,
                UNAVAILABLE,
            )])
        };
        let mut extension = Extension {
            js_files: files(),
            esm_files: files(),
            lazy_loaded_esm_files: files(),
            lazy_loaded_js_files: files(),
            ..Default::default()
        };
        embed_extension_sources(&mut extension);
        for source in all_sources(&extension) {
            assert!(source.is_runtime_loadable());
            assert_eq!(source.load().unwrap().as_str(), expected.as_str());
        }
    }

    #[test]
    fn table_covers_current_dependency_declarations() {
        let extensions = [
            deno_webidl::deno_webidl::init(),
            deno_web::deno_web::init(
                Arc::new(deno_web::BlobStore::default()),
                None,
                false,
                deno_web::InMemoryBroadcastChannel::default(),
            ),
            deno_webgpu::deno_webgpu::init(),
            deno_image::deno_image::init(),
            deno_fetch::deno_fetch::init(deno_fetch::Options::default()),
            network_fetch_shim(),
        ];
        let mut checked = 0;
        for mut extension in extensions {
            for files in [
                &mut extension.js_files,
                &mut extension.esm_files,
                &mut extension.lazy_loaded_esm_files,
                &mut extension.lazy_loaded_js_files,
            ] {
                for source in files.to_mut() {
                    *source =
                        ExtensionFileSource::loaded_during_snapshot(source.specifier, UNAVAILABLE);
                }
            }
            embed_extension_sources(&mut extension);
            for source in all_sources(&extension) {
                assert!(source.is_runtime_loadable());
                assert!(!source.load().unwrap().is_empty());
                checked += 1;
            }
        }
        assert_eq!(checked, EMBEDDED_SOURCES.len());
    }

    #[test]
    fn table_is_sorted_and_specifiers_are_unique() {
        assert!(!EMBEDDED_SOURCES.is_empty());
        assert!(
            EMBEDDED_SOURCES
                .windows(2)
                .all(|pair| pair[0].0 < pair[1].0)
        );
    }

    #[test]
    fn existing_in_memory_sources_are_preserved() {
        let mut extension = Extension {
            js_files: Cow::Owned(vec![ExtensionFileSource::new(
                "ext:test/already-embedded.js",
                deno_core::ascii_str!("globalThis.embedded = true;"),
            )]),
            esm_files: Cow::Owned(vec![ExtensionFileSource::new_computed(
                "ext:test/computed.js",
                Arc::from("export const computed = true;"),
            )]),
            ..Default::default()
        };
        embed_extension_sources(&mut extension);
        assert_eq!(
            extension.js_files[0].load().unwrap().as_str(),
            "globalThis.embedded = true;"
        );
        assert_eq!(
            extension.esm_files[0].load().unwrap().as_str(),
            "export const computed = true;"
        );
    }

    #[test]
    #[should_panic(expected = "missing compiled extension source for ext:test/unregistered.js")]
    fn missing_compiled_source_fails_closed() {
        let mut extension = Extension {
            js_files: Cow::Owned(vec![ExtensionFileSource::loaded_during_snapshot(
                "ext:test/unregistered.js",
                UNAVAILABLE,
            )]),
            ..Default::default()
        };
        embed_extension_sources(&mut extension);
    }
}
