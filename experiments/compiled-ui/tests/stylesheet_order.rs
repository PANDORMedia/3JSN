use blitz_dom::{BaseDocument, DocumentConfig, NodeId, WebFontLoadError, qual_name};
use blitz_html::HtmlDocument;
use blitz_traits::{
    net::{Bytes, NetHandler, NetProvider, Request},
    shell::{ColorScheme, Viewport},
};
use std::{
    io::Write,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};

const FONT: &[u8] = include_bytes!("../../web-font-matcher/fixtures/narrow.ttf");
fn config() -> DocumentConfig {
    DocumentConfig {
        viewport: Some(Viewport::new(448, 256, 1.0, ColorScheme::Light)),
        font_ctx: Some(blitz_dom::build_single_font_ctx(FONT)),
        html_parser_provider: Some(Arc::new(blitz_html::HtmlProvider)),
        ..Default::default()
    }
}
fn document(html: &str) -> BaseDocument {
    HtmlDocument::from_html(html, config()).into_inner()
}
fn id(doc: &BaseDocument, name: &str) -> NodeId {
    doc.get_element_by_id(name).unwrap()
}
fn width(doc: &mut BaseDocument, expected: f64) {
    doc.resolve(0.0);
    assert_eq!(
        doc.get_client_bounding_rect(id(doc, "x")).unwrap().width,
        expected
    );
}
fn replace_style_text(doc: &mut BaseDocument, owner: NodeId, text: &str) {
    let child = doc.get_node(owner).unwrap().children[0];
    doc.mutate().set_node_text(child, text);
}
fn assert_order(doc: &BaseDocument, expected: &[NodeId]) {
    assert_eq!(doc.stylesheet_owner_nodes().collect::<Vec<_>>(), expected);
    assert_eq!(doc.author_stylesheets().count(), expected.len());
}
const PAIR: &str = "<!doctype html><body><section id=a><style id=first>#x{width:40px;height:10px}</style></section><section id=b><style id=second>#x{width:77.5px}</style></section><div id=x></div>";

#[test]
fn foster_parenting_uses_final_dom_order_for_interpreted_and_compiled_documents() {
    let html = "<!doctype html><table><style>#x{width:40px;height:10px}</style><div><style>#x{width:77.5px}</style></div><tr><td id=x>A</table>";
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap();
    let mut process = Command::new("node").args(["--input-type=module", "--eval", "import{pathToFileURL}from'node:url';import{readFileSync}from'node:fs';const{compileHtml}=await import(pathToFileURL(process.argv[2]).href);process.stdout.write(JSON.stringify(compileHtml(readFileSync(0,'utf8'))));"]).arg("stylesheet-order-driver").arg(root.join("experiments/compiled-ui/compiler.mjs")).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    process
        .stdin
        .take()
        .unwrap()
        .write_all(html.as_bytes())
        .unwrap();
    let compiled = process.wait_with_output().unwrap();
    assert!(compiled.status.success());
    let mut interpreted = document(html);
    let mut compiled = threejs_compiled_ui_experiment::load_json(&compiled.stdout, config())
        .unwrap()
        .document;
    width(&mut interpreted, 42.0);
    width(&mut compiled, 42.0);
    for doc in [&interpreted, &compiled] {
        let texts: Vec<_> = doc
            .stylesheet_owner_nodes()
            .map(|owner| doc.get_node(owner).unwrap().text_content())
            .collect();
        assert_eq!(texts, ["#x{width:77.5px}", "#x{width:40px;height:10px}"]);
    }
}

#[test]
fn moving_style_ancestors_reorders_existing_objects_and_cssom_rules() {
    let mut doc = document(PAIR);
    let first = id(&doc, "first");
    let second = id(&doc, "second");
    let a = id(&doc, "a");
    let b = id(&doc, "b");
    let body = doc.find_body_node().unwrap().id;
    width(&mut doc, 77.5);
    assert_order(&doc, &[first, second]);
    doc.stylesheet_insert_rule(first, &[], "#x{width:63px}", 1)
        .unwrap();
    let generation = doc.stylesheet_generation();
    doc.mutate().append_children(body, &[a]);
    width(&mut doc, 63.0);
    assert_order(&doc, &[second, first]);
    assert!(doc.stylesheet_generation() > generation);
    for _ in 0..3 {
        doc.mutate().append_children(body, &[b]);
        width(&mut doc, 77.5);
        doc.mutate().append_children(body, &[a]);
        width(&mut doc, 63.0);
    }
    let generation = doc.stylesheet_generation();
    {
        let mut dom = doc.mutate();
        let node = dom.create_element(qual_name!("div", html), vec![]);
        dom.append_children(body, &[node]);
    }
    width(&mut doc, 63.0);
    assert_eq!(
        doc.stylesheet_generation(),
        generation,
        "unrelated tree changes do not invalidate CSSOM objects"
    );
}

#[test]
fn removal_reinsertion_and_text_replacement_keep_tree_order() {
    let mut doc = document(PAIR);
    let first = id(&doc, "first");
    let second = id(&doc, "second");
    let a = id(&doc, "a");
    let b = id(&doc, "b");
    width(&mut doc, 77.5);
    doc.mutate().remove_node(second);
    width(&mut doc, 40.0);
    assert_order(&doc, &[first]);
    doc.mutate().insert_nodes_before(first, &[second]);
    width(&mut doc, 40.0);
    assert_order(&doc, &[second, first]);
    replace_style_text(&mut doc, first, "#x{width:51px;height:10px}");
    width(&mut doc, 51.0);
    doc.mutate().append_children(b, &[second]);
    width(&mut doc, 77.5);
    doc.mutate().remove_and_drop_node(first);
    assert_order(&doc, &[second]);
    {
        let mut dom = doc.mutate();
        let style = dom.create_element(qual_name!("style", html), vec![]);
        let text = dom.create_text_node("#x{width:19px}");
        dom.append_children(style, &[text]);
        dom.append_children(a, &[style]);
    }
    width(&mut doc, 77.5);
}

#[test]
fn template_styles_are_inert_until_connected_and_become_inert_again() {
    let mut doc = document(
        "<!doctype html><body><style id=base>#x{width:40px;height:10px}</style><template id=t><style>#x{width:91px}</style></template><div id=x></div>",
    );
    let base = id(&doc, "base");
    let template = id(&doc, "t");
    let fragment = doc
        .get_node(template)
        .unwrap()
        .element_data()
        .unwrap()
        .template_contents
        .unwrap();
    let style = doc.get_node(fragment).unwrap().children[0];
    let body = doc.find_body_node().unwrap().id;
    width(&mut doc, 40.0);
    assert_order(&doc, &[base]);
    assert!(!doc.node_has_stylesheet(style));
    doc.mutate().append_children(body, &[style]);
    width(&mut doc, 91.0);
    assert_order(&doc, &[base, style]);
    doc.mutate().append_children(fragment, &[style]);
    width(&mut doc, 40.0);
    assert_order(&doc, &[base]);
    replace_style_text(&mut doc, style, "#x{width:112px}");
    width(&mut doc, 40.0);
    assert!(!doc.node_has_stylesheet(style));
    doc.mutate().append_children(body, &[style]);
    width(&mut doc, 112.0);
}

#[test]
fn a_style_detached_before_mutator_flush_is_not_installed() {
    let mut doc = document(PAIR);
    let body = doc.find_body_node().unwrap().id;
    let style = {
        let mut dom = doc.mutate();
        let style = dom.create_element(qual_name!("style", html), vec![]);
        let text = dom.create_text_node("#x{width:123px}");
        dom.append_children(style, &[text]);
        dom.append_children(body, &[style]);
        dom.remove_node(style);
        style
    };
    width(&mut doc, 77.5);
    assert!(!doc.node_has_stylesheet(style));
}

#[test]
fn a_style_dropped_before_mutator_flush_is_not_dereferenced() {
    let mut doc = document(PAIR);
    let body = doc.find_body_node().unwrap().id;
    {
        let mut dom = doc.mutate();
        let style = dom.create_element(qual_name!("style", html), vec![]);
        let text = dom.create_text_node("#x{width:123px}");
        dom.append_children(style, &[text]);
        dom.append_children(body, &[style]);
        dom.remove_and_drop_node(style);
    }
    width(&mut doc, 77.5);
}

type PendingResponse = (Request, Box<dyn NetHandler>);

#[derive(Default)]
struct FixtureNet {
    requests: Mutex<Vec<String>>,
    pending: Mutex<Vec<PendingResponse>>,
}
impl NetProvider for FixtureNet {
    fn fetch(&self, _: usize, request: Request, handler: Box<dyn NetHandler>) {
        self.requests.lock().unwrap().push(request.url.to_string());
        self.pending.lock().unwrap().push((request, handler));
    }
}
impl FixtureNet {
    fn respond(&self, suffix: &str, bytes: &[u8]) {
        let (request, handler) = {
            let mut pending = self.pending.lock().unwrap();
            let index = pending
                .iter()
                .position(|(r, _)| r.url.as_str().ends_with(suffix))
                .unwrap();
            pending.remove(index)
        };
        handler.bytes(request.url.to_string(), Bytes::copy_from_slice(bytes));
    }
}
fn network_config(net: Arc<FixtureNet>) -> DocumentConfig {
    DocumentConfig {
        base_url: Some("https://fixture.invalid/index.html".into()),
        net_provider: Some(net),
        defer_font_loads: true,
        ..config()
    }
}

#[test]
fn reversed_link_arrival_and_imports_preserve_stylesheet_then_rule_order() {
    let net = Arc::new(FixtureNet::default());
    let mut doc=HtmlDocument::from_html("<!doctype html><head><link id=first rel=stylesheet href=first.css><link id=second rel=stylesheet href=second.css></head><body><div id=x></div>",network_config(net.clone())).into_inner();
    net.respond("second.css", b"#x{width:77.5px;height:10px}");
    doc.handle_messages();
    net.respond(
        "first.css",
        b"@import 'nested.css';#x{width:40px;height:10px}",
    );
    doc.handle_messages();
    net.respond("nested.css", b"#x{width:18px}");
    doc.handle_messages();
    let first = id(&doc, "first");
    let second = id(&doc, "second");
    let head = doc.get_node(first).unwrap().parent.unwrap();
    width(&mut doc, 77.5);
    assert_order(&doc, &[first, second]);
    doc.mutate().append_children(head, &[first]);
    width(&mut doc, 40.0);
    assert_order(&doc, &[second, first]);
    assert_eq!(
        net.requests.lock().unwrap().len(),
        3,
        "owner moves reuse the imported stylesheet"
    );
}

#[test]
fn a_link_removed_before_response_cannot_install_a_disconnected_sheet() {
    let net = Arc::new(FixtureNet::default());
    let mut doc=HtmlDocument::from_html("<!doctype html><head><link id=late rel=stylesheet href=late.css><style>#x{width:40px;height:10px}</style></head><body><div id=x></div>",network_config(net.clone())).into_inner();
    let late = id(&doc, "late");
    doc.mutate().remove_and_drop_node(late);
    net.respond("late.css", b"#x{width:91px}");
    doc.handle_messages();
    width(&mut doc, 40.0);
    assert!(!doc.node_has_stylesheet(late));
}

#[test]
fn checked_font_order_tracks_cascade_order_and_rejects_later_face_reordering() {
    let net = Arc::new(FixtureNet::default());
    let mut doc=HtmlDocument::from_html("<!doctype html><body><section id=a><style id=first>@font-face{font-family:Same;src:url(first.ttf)}#x{width:40px;height:10px}</style></section><section id=b><style id=second>@font-face{font-family:Same;src:url(second.ttf)}#x{width:77.5px}</style></section><div id=x></div>",network_config(net.clone())).into_inner();
    let a = id(&doc, "a");
    let b = id(&doc, "b");
    let body = doc.find_body_node().unwrap().id;
    let first = id(&doc, "first");
    let second = id(&doc, "second");
    doc.mutate().append_children(body, &[a]);
    width(&mut doc, 40.0);
    assert_order(&doc, &[second, first]);
    doc.load_web_fonts().unwrap();
    assert_eq!(
        *net.requests.lock().unwrap(),
        [
            "https://fixture.invalid/second.ttf",
            "https://fixture.invalid/first.ttf"
        ]
    );
    net.respond("first.ttf", FONT);
    net.respond("second.ttf", FONT);
    doc.handle_messages();
    assert_eq!(doc.check_web_fonts().unwrap().registered, 2);
    doc.mutate().append_children(body, &[b]);
    width(&mut doc, 77.5);
    assert_order(&doc, &[first, second]);
    assert_eq!(
        doc.check_web_fonts(),
        Err(WebFontLoadError::DynamicMutation)
    );
}
