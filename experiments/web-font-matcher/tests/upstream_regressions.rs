//! These tests also compile against unmodified Fontique 0.11.1.
use fontique::{
    Attributes, Blob, Collection, CollectionOptions, FontInfoOverride, FontWeight, QueryStatus,
    SourceCache,
};
use std::sync::Arc;

#[test]
fn duplicate_coverage_variants_are_all_queried() {
    let mut collection = Collection::new(CollectionOptions {
        shared: false,
        system_fonts: false,
    });
    let mut ids = Vec::new();
    for bytes in [
        include_bytes!("../fixtures/narrow.ttf").as_slice(),
        include_bytes!("../fixtures/wide.ttf").as_slice(),
        include_bytes!("../fixtures/variable.ttf").as_slice(),
    ] {
        let blob = Blob::new(Arc::new(bytes.to_vec()));
        ids.push(blob.id());
        assert_eq!(
            collection
                .register_fonts(
                    blob,
                    Some(FontInfoOverride {
                        family_name: Some("Composite"),
                        ..Default::default()
                    })
                )
                .len(),
            1
        );
    }
    let mut cache = SourceCache::default();
    let mut query = collection.query(&mut cache);
    query.set_families(["Composite"]);
    let mut actual = Vec::new();
    query.matches_with(|font| {
        actual.push(font.blob.id());
        QueryStatus::Continue
    });
    assert_eq!(actual, ids);
}

#[test]
fn scalar_weight_override_still_sets_nondefault_variable_coordinate() {
    let mut collection = Collection::new(CollectionOptions {
        shared: false,
        system_fonts: false,
    });
    collection.register_fonts(
        Blob::new(Arc::new(
            include_bytes!("../fixtures/variable.ttf").to_vec(),
        )),
        Some(FontInfoOverride {
            family_name: Some("Variable"),
            weight: Some(FontWeight::new(700.0)),
            ..Default::default()
        }),
    );
    let mut cache = SourceCache::default();
    let mut query = collection.query(&mut cache);
    query.set_families(["Variable"]);
    query.set_attributes(Attributes {
        weight: FontWeight::new(700.0),
        ..Default::default()
    });
    let mut wght = None;
    query.matches_with(|font| {
        wght = font
            .synthesis
            .variation_settings()
            .iter()
            .find(|(tag, _)| tag.to_be_bytes() == *b"wght")
            .map(|(_, value)| *value);
        QueryStatus::Stop
    });
    assert_eq!(wght, Some(700.0));
}
