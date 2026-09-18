//! Compile-time sources for the shared Deno web extensions.
//! Embedded upstream source is MIT-licensed by the Deno authors; see
//! THIRD_PARTY_NOTICES.md and LICENSES/Deno-MIT.txt at the repository root.

use deno_core::{Extension, ExtensionFileSource, ExtensionFileSourceCode};

include!(concat!(env!("OUT_DIR"), "/embedded_extension_sources.rs"));

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
            // Apply the checked Document/Window event-path repair in release
            // builds too, where Deno can already supply an in-memory source.
            if source.specifier == "ext:deno_web/02_event.js"
                || matches!(
                    source.code,
                    ExtensionFileSourceCode::LoadedFromFsDuringSnapshot(_)
                )
            {
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

/// Remove bootstrap-only entry points before evaluating application code.
/// Extension modules retain their captured core imports; this closes public
/// raw-op access without claiming that trusted application modules are sandboxed.
pub fn seal_application_realm(
    runtime: &mut deno_core::JsRuntime,
) -> Result<(), Box<deno_core::error::JsError>> {
    runtime.execute_script(
        "3jsn:seal-application-realm",
        r#"(() => {
          for (const name of ['Deno', '__bootstrap', '__infra']) {
            if (!Reflect.deleteProperty(globalThis, name) || name in globalThis) {
              throw new Error(`Cannot remove privileged bootstrap global: ${name}`);
            }
          }
        })()"#,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{borrow::Cow, sync::Arc};

    use super::*;

    #[test]
    fn application_realm_removes_core_aliases_and_can_be_sealed_twice() {
        let mut runtime = deno_core::JsRuntime::new(Default::default());
        seal_application_realm(&mut runtime).unwrap();
        seal_application_realm(&mut runtime).unwrap();
        runtime.execute_script("sealed:assert", "for (const name of ['Deno','__bootstrap','__infra']) { if (name in globalThis) throw Error(name); }").unwrap();
    }

    #[test]
    fn application_realm_rejects_nonremovable_bootstrap_globals() {
        for name in ["Deno", "__bootstrap", "__infra"] {
            let mut runtime = deno_core::JsRuntime::new(Default::default());
            runtime
                .execute_script(
                    "sealed:nonconfigurable",
                    format!(
                        "Object.defineProperty(globalThis, '{name}', {{ configurable: false }});"
                    ),
                )
                .unwrap();
            let error = seal_application_realm(&mut runtime).unwrap_err();
            assert!(error.to_string().contains(name));
        }
    }

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
    fn document_event_repair_also_replaces_in_memory_dependency_source() {
        let specifier = "ext:deno_web/02_event.js";
        let mut extension = Extension {
            lazy_loaded_js_files: Cow::Owned(vec![ExtensionFileSource::new(
                specifier,
                deno_core::ascii_str!("unpatched dependency source"),
            )]),
            ..Default::default()
        };
        embed_extension_sources(&mut extension);
        let actual = extension.lazy_loaded_js_files[0].load().unwrap();
        let expected = EMBEDDED_SOURCES
            .iter()
            .find(|(name, _)| *name == specifier)
            .unwrap()
            .1;
        assert_eq!(actual.as_str(), expected.as_str());
        assert!(actual.as_str().contains("eventTarget.defaultView ?? null"));
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
