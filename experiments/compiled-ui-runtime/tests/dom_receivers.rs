//! CPU receiver validation through the actual DOM ops, bindings and parser mode.
//! No GPU instance or native window is created.

use std::{error::Error, sync::Arc};

use blitz_dom::{BaseDocument, LocalName, QualName, ns};
use deno_core::{JsRuntime, RuntimeOptions};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[allow(
    dead_code,
    reason = "Reuse the production bridge; GPU helpers are outside this CPU test."
)]
#[path = "../src/dom_bridge.rs"]
mod dom_bridge;

deno_core::extension!(
    receiver_test_globals,
    deps = [deno_webidl, deno_web, deno_webgpu]
);

fn runtime() -> JsRuntime {
    let mut document = BaseDocument::new(Default::default());
    let root = document.root_node().id;
    {
        let mut dom = document.mutate();
        let element = |name: &str| QualName::new(None, ns!(html), LocalName::from(name));
        let html = dom.create_element(element("html"), vec![]);
        let head = dom.create_element(element("head"), vec![]);
        let body = dom.create_element(element("body"), vec![]);
        let retained = dom.create_element(element("div"), vec![]);
        dom.set_attribute(
            retained,
            QualName::new(None, ns!(), "id".into()),
            "retained",
        );
        let text = dom.create_text_node("original");
        dom.append_children(retained, &[text]);
        dom.append_children(body, &[retained]);
        dom.append_children(html, &[head, body]);
        dom.append_children(root, &[html]);
    }
    let mut globals = receiver_test_globals::init();
    globals.esm_files = vec![deno_core::ExtensionFileSource::new(
        "ext:receiver_test_globals/web-globals.js",
        deno_core::ascii_str_include!("../../../crates/runtime/src/web-globals.js"),
    )]
    .into();
    globals.esm_entry_point = Some("ext:receiver_test_globals/web-globals.js");
    let mut extensions = vec![
        deno_webidl::deno_webidl::init(),
        deno_web::deno_web::init(
            Arc::new(deno_web::BlobStore::default()),
            None,
            false,
            deno_web::InMemoryBroadcastChannel::default(),
        ),
        deno_webgpu::deno_webgpu::init(),
        globals,
        dom_bridge::extension_with_document(document),
    ];
    extensions
        .iter_mut()
        .for_each(threejs_native_js_sources::embed_extension_sources);
    JsRuntime::new(RuntimeOptions {
        extensions,
        ..Default::default()
    })
}

#[tokio::test(flavor = "current_thread")]
async fn invalid_receivers_leave_the_live_document_unchanged() -> Result<()> {
    let mut runtime = runtime();
    runtime.execute_script(
        "test:parser-mode",
        if cfg!(feature = "dynamic-html") {
            "globalThis.parserPreserved = true;"
        } else {
            "globalThis.parserPreserved = false;"
        },
    )?;
    runtime.execute_script("test:dom-receivers", r#"
(() => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const html = document.documentElement, body = document.body;
  const retained = document.getElementById('retained'), text = retained.firstChild;
  const roots = [...document.childNodes], children = [...body.childNodes];
  const setter = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML').set;
  const unchanged = () => {
    assert(document.documentElement === html && document.body === body, 'document roots retained');
    assert(roots.length === document.childNodes.length && roots.every((n, i) => document.childNodes[i] === n), 'document children retained');
    assert(children.length === body.childNodes.length && children.every((n, i) => body.childNodes[i] === n), 'body children retained');
    assert(retained.parentNode === body && text.parentNode === retained && retained.firstChild === text && retained.childNodes.length === 1 && text.data === 'original', 'subtree identity and text retained');
  };
  const rejects = (action, validate, message) => {
    let error;
    try { action(); } catch (caught) { error = caught; }
    assert(error && validate(error), message);
    unchanged();
  };
  assert(document.activeElement === body, 'exercise the path with no focused element');
  for (const receiver of [text, document]) {
    rejects(() => setter.call(receiver, '<b>replacement</b>'),
      error => parserPreserved ? error instanceof TypeError : error.message.includes('dynamic HTML parsing is unavailable'),
      'invalid innerHTML receiver rejects before mutation');
    rejects(() => Element.prototype.getBoundingClientRect.call(receiver), error => error instanceof TypeError, 'non-element rect rejects');
  }
  for (const all of [false, true]) {
    const query = all ? Element.prototype.querySelectorAll : Element.prototype.querySelector;
    rejects(() => query.call(text, '*'), error => error instanceof TypeError, 'Text cannot be a selector scope');
  }
  assert(document.querySelector('html') === html, 'Document query includes its root Element');
  assert(document.querySelector('#retained') === retained && document.querySelectorAll('#retained')[0] === retained, 'Document query remains supported');
  assert(body.querySelector('#retained') === retained && body.querySelectorAll('#retained')[0] === retained, 'Element query remains supported');
  assert(Number.isFinite(retained.getBoundingClientRect().width), 'Element geometry remains supported');
  if (parserPreserved) {
    setter.call(retained, '<b id="replacement">parsed</b>');
    assert(text.parentNode === null && text.data === 'original', 'valid parsing retains detached Text');
    assert(retained.firstChild === document.getElementById('replacement') && retained.firstChild.textContent === 'parsed', 'preserved parser still constructs HTML');
  } else {
    rejects(() => setter.call(retained, '<b>replacement</b>'), error => error.message.includes('dynamic HTML parsing is unavailable'), 'restricted valid Element rejects unchanged');
  }
})()
"#)?;
    Ok(())
}
