use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use blitz_dom::{
    BaseDocument, DocumentConfig, DocumentMutator, HtmlParserProvider, NodeId, PlainDocument,
};
use blitz_traits::{
    net::{NetHandler, NetProvider, Request},
    shell::ShellProvider,
};
use serde_json::{Value, json};

use crate::{
    LoadError,
    capabilities::{HTML_NAMESPACE, element_html_parser_requirement},
    contract::CompiledUi,
    load, load_json, load_json_restricted, load_restricted,
};

const SVG_NAMESPACE: &str = "http://www.w3.org/2000/svg";

fn element(namespace: &str, name: &str, attributes: &[(&str, &str)]) -> Value {
    json!({"kind":"element", "namespace":namespace, "name":name, "prefix":null,
        "attributes":attributes.iter().map(|(name, value)| json!({"namespace":null,"name":name,"prefix":null,"value":value})).collect::<Vec<_>>(),
        "children":[], "source":null})
}

fn fixture(children: Vec<Value>) -> Vec<u8> {
    let mut html = element(HTML_NAMESPACE, "html", &[]);
    html["children"] = json!([2]);
    let mut body = element(HTML_NAMESPACE, "body", &[]);
    body["children"] = json!((3..3 + children.len()).collect::<Vec<_>>());
    let mut nodes = vec![
        json!({"kind":"document","children":[1],"source":null}),
        html,
        body,
    ];
    nodes.extend(children);
    serde_json::to_vec(&json!({"format":"3jsn-static-ui-experiment","version":1,
        "source":{"name":"policy-fixture.html","sha256":"0".repeat(64),"byteLength":0},
        "document":{"mode":"no-quirks","scriptingEnabled":false},"nodes":nodes,
        "diagnostics":[],"diagnosticsTotal":0,"diagnosticsTruncated":false}))
    .unwrap()
}

#[derive(Default)]
struct Providers {
    requests: AtomicUsize,
    redraws: AtomicUsize,
    parses: Mutex<Vec<String>>,
}

impl NetProvider for Providers {
    fn fetch(&self, _: usize, _: Request, _: Box<dyn NetHandler>) {
        self.requests.fetch_add(1, Ordering::SeqCst);
    }
}

impl ShellProvider for Providers {
    fn request_redraw(&self) {
        self.redraws.fetch_add(1, Ordering::SeqCst);
    }
}

impl HtmlParserProvider for Providers {
    fn parse_inner_html(&self, _: &mut DocumentMutator<'_>, _: NodeId, html: &str) {
        self.parses.lock().unwrap().push(html.into());
    }

    fn parse_document(&self, html: &str, config: DocumentConfig) -> Box<dyn blitz_dom::Document> {
        self.parses.lock().unwrap().push(html.into());
        Box::new(PlainDocument(BaseDocument::new(config)))
    }
}

fn settings(providers: &Arc<Providers>) -> DocumentConfig {
    DocumentConfig {
        base_url: Some("threejsn://package/app/index.html".into()),
        net_provider: Some(providers.clone()),
        shell_provider: Some(providers.clone()),
        ..Default::default()
    }
}

fn no_provider_actions(providers: &Providers) {
    assert_eq!(providers.requests.load(Ordering::SeqCst), 0);
    assert_eq!(providers.redraws.load(Ordering::SeqCst), 0);
    assert!(providers.parses.lock().unwrap().is_empty());
}

fn blocked(result: Result<crate::LoadedUi, LoadError>) {
    assert!(
        matches!(result, Err(LoadError::Unsupported(_))),
        "expected capability rejection"
    );
}

#[test]
fn shared_requirement_tracks_html_and_actual_foreign_iframe_hook() {
    assert!(element_html_parser_requirement(HTML_NAMESPACE, "iframe").is_some());
    assert!(element_html_parser_requirement(SVG_NAMESPACE, "iframe").is_some());
    assert_ne!(
        element_html_parser_requirement(HTML_NAMESPACE, "iframe"),
        element_html_parser_requirement(SVG_NAMESPACE, "iframe")
    );
    for name in ["div", "object", "embed", "script", "template", "IFRAME"] {
        assert!(
            element_html_parser_requirement(HTML_NAMESPACE, name).is_none(),
            "{name}"
        );
    }
}

#[test]
fn restricted_preflight_rejects_iframes_before_earlier_resource_attachment() {
    for namespace in [HTML_NAMESPACE, SVG_NAMESPACE] {
        for attributes in [
            vec![],
            vec![("src", "child.html")],
            vec![("srcdoc", "<p>child</p>")],
        ] {
            let input = fixture(vec![
                element(HTML_NAMESPACE, "img", &[("src", "earlier.png")]),
                element(namespace, "iframe", &attributes),
            ]);
            let providers = Arc::new(Providers::default());
            blocked(load_json_restricted(&input, settings(&providers)));
            no_provider_actions(&providers);
            let input = CompiledUi::from_json(&input).unwrap();
            blocked(load_restricted(&input, settings(&providers)));
            no_provider_actions(&providers);
        }
    }
}

#[test]
fn restricted_startup_includes_iframes_in_inert_templates() {
    let mut input: Value =
        serde_json::from_slice(&fixture(vec![element(HTML_NAMESPACE, "template", &[])])).unwrap();
    input["nodes"][3]["templateContents"] = json!(4);
    input["nodes"].as_array_mut().unwrap().extend([
        json!({"kind":"fragment","children":[5],"source":null}),
        element(HTML_NAMESPACE, "iframe", &[("srcdoc", "later activation")]),
    ]);
    let providers = Arc::new(Providers::default());
    blocked(load_json_restricted(
        &serde_json::to_vec(&input).unwrap(),
        settings(&providers),
    ));
    no_provider_actions(&providers);
}

#[test]
fn explicit_restricted_loading_rejects_caller_parser_without_invoking_it() {
    let providers = Arc::new(Providers::default());
    let mut config = settings(&providers);
    config.html_parser_provider = Some(providers.clone());
    blocked(load_json_restricted(
        &fixture(vec![element(
            HTML_NAMESPACE,
            "img",
            &[("src", "earlier.png")],
        )]),
        config,
    ));
    no_provider_actions(&providers);
}

#[test]
fn restricted_static_construction_keeps_ordinary_nodes_and_reports_absent_parser() {
    let input = fixture(vec![
        element(HTML_NAMESPACE, "div", &[("id", "ordinary")]),
        element(HTML_NAMESPACE, "object", &[]),
        element(HTML_NAMESPACE, "embed", &[]),
        element(HTML_NAMESPACE, "script", &[]),
    ]);
    let loaded = load_json_restricted(&input, DocumentConfig::default()).unwrap();
    assert_eq!(loaded.report.dynamic_html_parser_provider, "absent");
    assert!(!loaded.report.initial_document_html_parser_used);
    assert!(loaded.document.get_element_by_id("ordinary").is_some());
    assert_eq!(loaded.report.native_nodes, 7);
}

#[test]
fn ordinary_api_preserves_explicit_provider_in_both_feature_configurations() {
    let providers = Arc::new(Providers::default());
    let mut config = settings(&providers);
    config.html_parser_provider = Some(providers.clone());
    let input = fixture(vec![element(
        HTML_NAMESPACE,
        "iframe",
        &[("srcdoc", "<p>exact source</p>")],
    )]);
    let loaded = load(&CompiledUi::from_json(&input).unwrap(), config).unwrap();
    assert_eq!(
        loaded.report.dynamic_html_parser_provider,
        "caller-provided-unverified"
    );
    assert_eq!(
        providers.parses.lock().unwrap().as_slice(),
        ["<p>exact source</p>"]
    );
    assert_eq!(loaded.document.sub_document_node_ids().len(), 1);
}

#[cfg(feature = "dynamic-html")]
#[test]
fn default_feature_keeps_the_maintained_html_provider_and_subdocuments() {
    let loaded = load_json(
        &fixture(vec![element(
            HTML_NAMESPACE,
            "iframe",
            &[("srcdoc", "<p>child</p>")],
        )]),
        DocumentConfig::default(),
    )
    .unwrap();
    assert_eq!(loaded.report.dynamic_html_parser_provider, "blitz-html");
    let iframe = loaded.document.sub_document_node_ids()[0];
    assert!(
        loaded
            .document
            .subdoc(iframe)
            .unwrap()
            .inner()
            .query_selector("p")
            .unwrap()
            .is_some()
    );
}

#[cfg(not(feature = "dynamic-html"))]
#[test]
fn missing_default_feature_rejects_automatic_parse_before_any_provider_work() {
    let input = fixture(vec![
        element(HTML_NAMESPACE, "img", &[("src", "earlier.png")]),
        element(HTML_NAMESPACE, "iframe", &[("srcdoc", "<p>child</p>")]),
    ]);
    let providers = Arc::new(Providers::default());
    blocked(load_json(&input, settings(&providers)));
    no_provider_actions(&providers);
    blocked(load(
        &CompiledUi::from_json(&input).unwrap(),
        settings(&providers),
    ));
    no_provider_actions(&providers);
    let loaded = load_json(
        &fixture(vec![element(HTML_NAMESPACE, "div", &[])]),
        settings(&providers),
    )
    .unwrap();
    assert_eq!(loaded.report.dynamic_html_parser_provider, "absent");
}
