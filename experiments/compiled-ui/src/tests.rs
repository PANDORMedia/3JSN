use std::{
    io::Write,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use blitz_dom::{
    BaseDocument, DocumentConfig, DocumentMutator, HtmlParserProvider, NodeData, NodeId,
};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use serde_json::{Value, json};

use crate::{LoadError, contract::CompiledUi, load_json};

const FONT: &[u8] = include_bytes!("../../web-font-matcher/fixtures/narrow.ttf");

fn config(scale: f32) -> DocumentConfig {
    DocumentConfig {
        viewport: Some(Viewport::new(448, 256, scale, ColorScheme::Light)),
        font_ctx: Some(blitz_dom::build_single_font_ctx(FONT)),
        html_parser_provider: Some(Arc::new(blitz_html::HtmlProvider)),
        ..Default::default()
    }
}

fn compile(html: &str) -> Vec<u8> {
    let compiler = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("compiler.mjs");
    let mut child = Command::new("node")
        .args(["--input-type=module", "--eval", "import{pathToFileURL}from'node:url';import{readFileSync}from'node:fs';const{compileHtml}=await import(pathToFileURL(process.argv[2]).href);process.stdout.write(JSON.stringify(compileHtml(readFileSync(0,'utf8'))));"])
        .arg("compiled-ui-test-driver").arg(compiler).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(html.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "compiler: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn snapshot(doc: &BaseDocument, id: NodeId) -> Value {
    let node = doc.get_node(id).unwrap();
    let children: Vec<_> = node.children.iter().map(|&id| snapshot(doc, id)).collect();
    match &node.data {
        NodeData::Document(_) => json!({"kind":"document","children":children}),
        NodeData::Element(element) => {
            let attrs: Vec<_> = element.attrs.iter().map(|attr| json!({"name":attr.name.local.as_ref(),"namespace":attr.name.ns.as_ref(),"prefix":attr.name.prefix.as_ref().map(|p|p.as_ref()),"value":attr.value})).collect();
            json!({"kind":"element","name":element.name.local.as_ref(),"namespace":element.name.ns.as_ref(),"prefix":element.name.prefix.as_ref().map(|p|p.as_ref()),"attributes":attrs,"children":children,"template":element.template_contents.map(|id|snapshot(doc,id))})
        }
        NodeData::Text(text) => json!({"kind":"text","value":text.content}),
        NodeData::Comment { contents } => json!({"kind":"comment","value":contents}),
        NodeData::AnonymousBlock(_) => panic!("generated layout boxes are not DOM children"),
    }
}

fn equal_tree(a: &BaseDocument, b: &BaseDocument) {
    assert_eq!(snapshot(a, a.root_node().id), snapshot(b, b.root_node().id));
}

fn equal_rects(a: &BaseDocument, b: &BaseDocument, selectors: &[&str]) {
    for selector in selectors {
        let a_id = a.query_selector(selector).unwrap().unwrap();
        let b_id = b.query_selector(selector).unwrap().unwrap();
        let ar = a.get_client_bounding_rect(a_id).unwrap();
        let br = b.get_client_bounding_rect(b_id).unwrap();
        assert_eq!(
            (ar.x, ar.y, ar.width, ar.height),
            (br.x, br.y, br.width, br.height),
            "{selector}"
        );
    }
}

#[test]
fn namespaced_attributes_text_and_comments_match_interpreted_tree() {
    let html = "<!doctype html><!--before--><html lang=en><head><title>A &amp; B</title></head><body><div ID=x id=ignored data-empty=''>é &lt; &#x1f600;<br>tail<!--middle--></div><svg viewBox='0 0 4 4'><a xlink:href='#x' xml:lang='fr' xmlns:xlink='http://www.w3.org/1999/xlink'><text>A</text></a><foreignObject><p>HTML</p></foreignObject></svg><math><mi>A</mi></math></body></html><!--after-->";
    let interpreted = HtmlDocument::from_html(html, config(1.0)).into_inner();
    let loaded = load_json(&compile(html), config(1.0)).unwrap();
    equal_tree(&interpreted, &loaded.document);
    assert_eq!(loaded.report.omitted_doctype_nodes, [1]);
    assert!(!loaded.report.initial_document_html_parser_used);
    assert_eq!(loaded.node_ids.iter().filter(|id| id.is_none()).count(), 1);
}

#[test]
fn nested_template_contents_remain_inert_and_can_be_moved_into_live_document() {
    let html = "<!doctype html><body><template id=outer><style>#live{width:99px}</style><div id=inside>text<template id=nested><span id=deep>A</span></template></div></template><div id=live style='height:12px'></div>";
    let mut a = HtmlDocument::from_html(html, config(1.0)).into_inner();
    let mut b = load_json(&compile(html), config(1.0)).unwrap().document;
    equal_tree(&a, &b);
    for doc in [&mut a, &mut b] {
        doc.resolve(0.0);
        let body = doc.find_body_node().unwrap().id;
        let live = doc.get_element_by_id("live").unwrap();
        assert_eq!(
            doc.get_client_bounding_rect(live).unwrap().width,
            doc.get_client_bounding_rect(body).unwrap().width,
            "inert template CSS must not change the connected element"
        );
        assert!(doc.get_element_by_id("inside").is_none());
        assert!(doc.query_selector("#deep").unwrap().is_none());
        let template = doc.get_element_by_id("outer").unwrap();
        let fragment = doc
            .get_node(template)
            .unwrap()
            .element_data()
            .unwrap()
            .template_contents
            .unwrap();
        let children = doc.get_node(fragment).unwrap().children.clone();
        let body = doc.find_body_node().unwrap().id;
        doc.mutate().append_children(body, &children);
        doc.resolve(0.0);
        assert!(doc.get_element_by_id("inside").is_some());
        assert!(doc.get_element_by_id("deep").is_none());
        assert_eq!(
            doc.get_client_bounding_rect(doc.get_element_by_id("live").unwrap())
                .unwrap()
                .width,
            99.0
        );
    }
    equal_tree(&a, &b);
    equal_rects(&a, &b, &["#live", "#inside"]);
}

#[test]
fn styles_mutations_queries_and_responsive_layout_match_at_multiple_scales() {
    let html = "<!doctype html><style>html,body{margin:0}.box{width:41.25px;height:12px} @media(min-width:400px){.box{width:89.5px}}</style><style>.wide{width:130.25px}</style><section><div id=item class=box>A A</div><div id=target></div></section>";
    let compiled = compile(html);
    for scale in [1.0, 1.5, 2.0] {
        let mut a = HtmlDocument::from_html(html, config(scale)).into_inner();
        let mut b = load_json(&compiled, config(scale)).unwrap().document;
        for step in 0..3 {
            for doc in [&mut a, &mut b] {
                if step == 1 {
                    let item = doc.get_element_by_id("item").unwrap();
                    let target = doc.get_element_by_id("target").unwrap();
                    let mut mutator = doc.mutate();
                    mutator.set_attribute(
                        item,
                        blitz_dom::QualName::new(None, "".into(), "class".into()),
                        "box wide",
                    );
                    mutator.set_inner_html(target, "<b data-k='v'>dynamic &amp; text</b>");
                    mutator.append_children(target, &[item]);
                } else if step == 2 {
                    doc.set_viewport(Viewport::new(320, 256, scale, ColorScheme::Light));
                    let item = doc.get_element_by_id("item").unwrap();
                    doc.mutate().set_attribute(
                        item,
                        blitz_dom::QualName::new(None, "".into(), "class".into()),
                        "box",
                    );
                }
                doc.resolve(0.0);
            }
            equal_tree(&a, &b);
            equal_rects(&a, &b, &["#item", "#target", "section"]);
        }
    }
}

#[test]
fn malformed_foster_parenting_and_style_source_order_match_interpreted() {
    let cases = [
        "<!doctype html><style>#x{width:40px;height:10px}</style><table>before<div id=x>inside</div><tr><td>A</table>after<style>#x{width:77.5px}</style>",
        "<!doctype html><style>#x{width:40px;height:10px}</style><p><b>bold<div id=x><i>A</b>B</i></div><style>#x{width:77.5px}</style>",
        "<!doctype html><table><style>#x{width:40px;height:10px}</style><div><style>#x{width:77.5px}</style></div><tr><td id=x>A</table>",
    ];
    for html in cases {
        let mut a = HtmlDocument::from_html(html, config(1.0)).into_inner();
        let mut b = load_json(&compile(html), config(1.0)).unwrap().document;
        equal_tree(&a, &b);
        a.resolve(0.0);
        b.resolve(0.0);
        equal_rects(&a, &b, &["#x"]);
    }
}

struct CountingParser(Arc<AtomicUsize>);
impl HtmlParserProvider for CountingParser {
    fn parse_inner_html(&self, mutator: &mut DocumentMutator<'_>, element: NodeId, html: &str) {
        self.0.fetch_add(1, Ordering::SeqCst);
        blitz_html::HtmlProvider.parse_inner_html(mutator, element, html);
    }
    fn parse_document(&self, html: &str, config: DocumentConfig) -> Box<dyn blitz_dom::Document> {
        self.0.fetch_add(1, Ordering::SeqCst);
        blitz_html::HtmlProvider.parse_document(html, config)
    }
}

#[test]
fn initial_tree_never_invokes_retained_dynamic_parser() {
    let counter = Arc::new(AtomicUsize::new(0));
    let input = compile("<!doctype html><div id=x>A</div>");
    let mut settings = config(1.0);
    settings.html_parser_provider = Some(Arc::new(CountingParser(counter.clone())));
    let mut loaded = load_json(&input, settings).unwrap();
    assert_eq!(counter.load(Ordering::SeqCst), 0);
    assert_eq!(
        loaded.report.dynamic_html_parser_provider,
        "caller-provided-unverified"
    );
    let id = loaded.document.get_element_by_id("x").unwrap();
    loaded
        .document
        .mutate()
        .set_inner_html(id, "<span>parsed later</span>");
    assert_eq!(counter.load(Ordering::SeqCst), 1);
    assert!(
        loaded
            .document
            .query_selector("#x > span")
            .unwrap()
            .is_some()
    );
    let mut settings = config(1.0);
    settings.html_parser_provider = None;
    let loaded = load_json(&input, settings).unwrap();
    assert_eq!(loaded.report.dynamic_html_parser_provider, "blitz-html");
}

#[test]
fn invalid_graph_and_unsupported_modes_fail_before_native_construction() {
    let base: Value = serde_json::from_slice(&compile("<!doctype html><div>A</div>")).unwrap();
    let reject = |input: Value| {
        assert!(load_json(&serde_json::to_vec(&input).unwrap(), config(1.0)).is_err())
    };
    let mut value = base.clone();
    value["version"] = json!(2);
    reject(value);
    let mut value = base.clone();
    value["document"]["mode"] = json!("quirks");
    reject(value);
    let mut value = base.clone();
    value["document"]["mode"] = json!("limited-quirks");
    reject(value);
    let mut value = base.clone();
    value["document"]["scriptingEnabled"] = json!(true);
    reject(value);
    let mut value = base.clone();
    value["nodes"][0]["children"] = json!([1, 99999]);
    reject(value);
    let mut value = base.clone();
    value["nodes"][0]["children"] = json!([1, 2, 2]);
    reject(value);
    let mut value = base.clone();
    value["nodes"][0]["children"] = json!([0]);
    reject(value);
    let mut value = base.clone();
    value["source"]["byteLength"] = json!(1_048_577);
    reject(value);
    let mut value = base.clone();
    value["source"]["sha256"] = json!("bad");
    reject(value);
    let mut value = base;
    value["unexpected"] = json!(true);
    reject(value);
    assert!(matches!(
        CompiledUi::from_json(&vec![b' '; 16 * 1024 * 1024 + 1]),
        Err(LoadError::Limit(_))
    ));
}

#[derive(Default)]
struct Stylesheets(std::sync::Mutex<Vec<String>>);
impl blitz_traits::net::NetProvider for Stylesheets {
    fn fetch(
        &self,
        _: usize,
        request: blitz_traits::net::Request,
        handler: Box<dyn blitz_traits::net::NetHandler>,
    ) {
        let url = request.url.to_string();
        self.0.lock().unwrap().push(url.clone());
        let css: &'static [u8] = match request.url.path() {
            "/app/styles/main.css" => b"@import './nested.css';#styled{height:17.5px}",
            "/app/styles/nested.css" => b"#styled{width:63.25px}",
            path => panic!("unexpected fixture resource: {path}"),
        };
        handler.bytes(url, blitz_traits::net::Bytes::from_static(css));
    }
}

#[test]
fn linked_stylesheet_and_import_use_the_same_provider_and_base_url() {
    let html = "<!doctype html><link rel=stylesheet href='./styles/main.css'><div id=styled></div>";
    let bytes = compile(html);
    let mut results = Vec::new();
    for compiled in [false, true] {
        let provider = Arc::new(Stylesheets::default());
        let mut settings = config(1.0);
        settings.base_url = Some("threejsn://package/app/index.html".into());
        settings.net_provider = Some(provider.clone());
        let mut doc = if compiled {
            load_json(&bytes, settings).unwrap().document
        } else {
            HtmlDocument::from_html(html, settings).into_inner()
        };
        doc.handle_messages();
        assert!(!doc.has_pending_critical_resources());
        doc.resolve(0.0);
        let id = doc.get_element_by_id("styled").unwrap();
        let rect = doc.get_client_bounding_rect(id).unwrap();
        assert_eq!((rect.width, rect.height), (63.25, 17.5));
        results.push(provider.0.lock().unwrap().clone());
    }
    assert_eq!(results[0], results[1]);
    assert_eq!(
        results[0],
        [
            "threejsn://package/app/styles/main.css",
            "threejsn://package/app/styles/nested.css"
        ]
    );
}

#[test]
fn shared_compiled_ui_fixtures_have_identical_native_trees_and_probe_rects() {
    let fixtures = [
        include_str!("../../../fixtures/compiled-ui/dashboard.html"),
        include_str!("../../../fixtures/compiled-ui/repaired.html"),
        include_str!("../../../fixtures/compiled-ui/namespaces.html"),
        include_str!("../../../fixtures/compiled-ui/templates.html"),
    ];
    for html in fixtures {
        let mut a = HtmlDocument::from_html(html, config(1.0)).into_inner();
        let mut b = load_json(&compile(html), config(1.0)).unwrap().document;
        equal_tree(&a, &b);
        a.resolve(0.0);
        b.resolve(0.0);
        equal_rects(&a, &b, &["#mutate-target"]);
    }
}

#[test]
fn validates_diagnostic_truncation_and_total_attribute_bound() {
    let base: Value = serde_json::from_slice(&compile("<!doctype html><div>A</div>")).unwrap();
    let mut value = base.clone();
    value["diagnosticsTotal"] = json!(4);
    value["diagnosticsTruncated"] = json!(true);
    assert!(CompiledUi::from_json(&serde_json::to_vec(&value).unwrap()).is_ok());
    value["diagnosticsTruncated"] = json!(false);
    assert!(matches!(
        CompiledUi::from_json(&serde_json::to_vec(&value).unwrap()),
        Err(LoadError::Invalid("diagnostic truncation metadata"))
    ));
    let mut value = base;
    let element = value["nodes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|node| node["kind"] == "element")
        .unwrap();
    element["attributes"] = json!((0..10_001).map(|index| json!({"name":format!("data-{index}"),"namespace":null,"prefix":null,"value":""})).collect::<Vec<_>>());
    assert!(matches!(
        CompiledUi::from_json(&serde_json::to_vec(&value).unwrap()),
        Err(LoadError::Limit("total attributes"))
    ));
}
