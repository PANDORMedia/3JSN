//! CPU delivery through the real DOM/window bindings. The target is obtained by
//! native DOM query, so these tests do not establish hit testing or OS input.
//! Microtasks checkpoint after each native record here, not between individual
//! listeners as browser-originated event dispatch can require. This pins the
//! current host behavior; it does not establish browser scheduling equivalence.

use std::{
    error::Error,
    future::Future,
    sync::Arc,
    task::{Context, Poll, Waker},
};

use blitz_dom::DocumentConfig;
use deno_core::{JsRuntime, OpState, RuntimeOptions, op2, serde_v8, v8};
use serde_json::{Value, json};

#[allow(
    dead_code,
    reason = "Reuse the real DOM bridge without exercising its GPU helpers."
)]
#[path = "../src/dom_bridge.rs"]
mod dom_bridge;
#[path = "../src/window_input.rs"]
mod window_input;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Default)]
struct Callback(Option<v8::Global<v8::Function>>);

#[op2]
fn op_dom_window_bind(
    state: &mut OpState,
    #[scoped] _frame: v8::Global<v8::Function>,
    #[scoped] _resize: v8::Global<v8::Function>,
    #[scoped] input: v8::Global<v8::Function>,
) {
    state.borrow_mut::<Callback>().0 = Some(input);
}

#[op2]
#[serde]
fn op_dom_window_viewport() -> Vec<f64> {
    vec![800.0, 600.0, 1.0]
}

#[op2(fast)]
fn op_dom_window_pending(_pending: bool) {}

deno_core::extension!(
    input_test_globals,
    deps = [deno_webidl, deno_web, deno_webgpu]
);
deno_core::extension!(
    input_test_window,
    ops = [
        op_dom_window_bind,
        op_dom_window_viewport,
        op_dom_window_pending
    ],
    state = |state| state.put(Callback::default()),
);

fn runtime() -> JsRuntime {
    let mut globals = input_test_globals::init();
    globals.esm_files = vec![deno_core::ExtensionFileSource::new(
        "ext:input_test_globals/web-globals.js",
        deno_core::ascii_str_include!("../../../crates/runtime/src/web-globals.js"),
    )]
    .into();
    globals.esm_entry_point = Some("ext:input_test_globals/web-globals.js");
    let mut window = input_test_window::init();
    window.esm_files = vec![
        deno_core::ExtensionFileSource::new(
            "ext:dom_window/animation.js",
            deno_core::ascii_str_include!("../../../crates/runtime/src/animation.js"),
        ),
        deno_core::ExtensionFileSource::new(
            "ext:dom_window/window.js",
            deno_core::ascii_str_include!("../src/window.js"),
        ),
    ]
    .into();
    window.esm_entry_point = Some("ext:dom_window/window.js");
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
        dom_bridge::extension(
            "<!doctype html><html><body><div id='parent'><button id='button'>Input</button></div></body></html>",
            DocumentConfig::default(),
        ),
        window,
    ];
    extensions
        .iter_mut()
        .for_each(threejs_native_js_sources::embed_extension_sources);
    // GPU WebIDL is installed by the shared globals, but no GPU Instance,
    // adapter, device, canvas context or native surface is created.
    JsRuntime::new(RuntimeOptions {
        extensions,
        ..Default::default()
    })
}

fn input(kind: &'static str, x: f64, y: f64, key: &str) -> window_input::Input {
    window_input::Input {
        kind,
        x,
        y,
        button: 0,
        key: key.into(),
        ..Default::default()
    }
}

fn dispatch(runtime: &mut JsRuntime, input: window_input::Input) -> Result<()> {
    let target = if input.kind.starts_with("mouse") {
        dom_bridge::with_document(runtime, |doc| {
            doc.get_element_by_id("button")
                .expect("real DOM button")
                .as_u64()
                .to_string()
        })
    } else {
        String::new()
    };
    let callback = runtime
        .op_state()
        .borrow()
        .borrow::<Callback>()
        .0
        .clone()
        .expect("window.js registered its callback");
    let args = {
        deno_core::scope!(scope, runtime);
        let kind = v8::String::new(scope, input.kind).unwrap();
        let x = v8::Number::new(scope, input.x);
        let y = v8::Number::new(scope, input.y);
        let button = v8::Number::new(scope, f64::from(input.button));
        let key = v8::String::new(scope, &input.key).unwrap();
        let target = v8::String::new(scope, &target).unwrap();
        let code = v8::String::new(scope, &input.code).unwrap();
        let repeat = v8::Boolean::new(scope, input.repeat);
        let shift = v8::Boolean::new(scope, input.modifiers.shift);
        let control = v8::Boolean::new(scope, input.modifiers.control);
        let alt = v8::Boolean::new(scope, input.modifiers.alt);
        let meta = v8::Boolean::new(scope, input.modifiers.meta);
        [
            kind.into(),
            x.into(),
            y.into(),
            button.into(),
            key.into(),
            target.into(),
            code.into(),
            repeat.into(),
            shift.into(),
            control.into(),
            alt.into(),
            meta.into(),
        ]
        .map(|value: v8::Local<v8::Value>| v8::Global::new(scope, value))
    };
    let callback = runtime.call_with_args(&callback, &args);
    let mut callback = std::pin::pin!(callback);
    match callback
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(result) => {
            result?;
            Ok(())
        }
        Poll::Pending => Err("synchronous window input callback returned a promise".into()),
    }
}

fn observation(runtime: &mut JsRuntime) -> Value {
    // Reading plain V8 data avoids an extra script execution/microtask checkpoint
    // that could conceal a missing checkpoint in the real window callback.
    deno_core::scope!(scope, runtime);
    let global = scope.get_current_context().global(scope);
    let key = v8::String::new(scope, "__inputDelivery").unwrap();
    let value = global.get(scope, key.into()).unwrap();
    serde_v8::from_v8(scope, value).unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn stylesheet_and_focus_state_changes_defer_focus_fixup_without_panicking() {
    let mut runtime = runtime();
    runtime
        .execute_script(
            "test:focus-stylesheets",
            include_str!("fixtures/focus-stylesheets.js"),
        )
        .unwrap();
    runtime.execute_script("test:run-focus-stylesheets", "runFocusStylesheetBehavior().then(result => { globalThis.__inputDelivery = result; });").unwrap();
    runtime.run_event_loop(Default::default()).await.unwrap();
    assert_eq!(
        observation(&mut runtime),
        json!([
            { "mode": "append-stylesheet", "immediate": "focus-stylesheet-target", "afterMicrotask": "focus-stylesheet-target", "afterLayout": "focus-stylesheet-target", "afterTask": "body", "focus": null },
            { "mode": "replace-stylesheet-text", "immediate": "focus-stylesheet-target", "afterMicrotask": "focus-stylesheet-target", "afterLayout": "focus-stylesheet-target", "afterTask": "body", "focus": null },
            { "mode": "focus-hides-self", "immediate": "focus-stylesheet-target", "afterMicrotask": "focus-stylesheet-target", "afterLayout": "focus-stylesheet-target", "afterTask": "body", "focus": null }
        ])
    );
}

#[tokio::test(flavor = "current_thread")]
async fn coalesced_bursts_preserve_dom_transitions_and_record_microtasks() {
    const BURST: u32 = 10_000;
    let (sender, mut receiver) = window_input::channel();
    let motion = |y| {
        for index in 0..BURST {
            sender
                .try_send(input("mousemove", f64::from(index) + 0.25, y, ""))
                .unwrap();
        }
    };
    let send = |kind, x, y, key| sender.try_send(input(kind, x, y, key)).unwrap();
    motion(10.0);
    send("mousedown", 31.0, 41.0, "");
    motion(20.0);
    send("keydown", 0.0, 0.0, "Space");
    send("keydown", 0.0, 0.0, "Space");
    motion(30.0);
    send("keyup", 0.0, 0.0, "Space");
    send("mouseup", 32.0, 42.0, "");
    motion(40.0);
    send("mousedown", 33.0, 43.0, "");
    send("keydown", 0.0, 0.0, "r");
    send("blur", 0.0, 0.0, "");
    send("focus", 0.0, 0.0, "");
    motion(50.0);
    send("keydown", 0.0, 0.0, "r");
    send("keyup", 0.0, 0.0, "r");
    send("mouseup", 34.0, 44.0, "");
    send("mousedown", 35.0, 45.0, "");
    send("pointerreset", 0.0, 0.0, "");
    motion(60.0);
    send("mouseup", 36.0, 46.0, "");
    send("mousedown", 37.0, 47.0, "");
    send("mouseup", 38.0, 48.0, "");

    let mut runtime = runtime();
    runtime
        .execute_script(
            "test:input-delivery",
            include_str!("fixtures/input-delivery.js"),
        )
        .unwrap();
    let mut kinds = Vec::new();
    let mut record_ends = Vec::new();
    while let Ok(record) = receiver.try_recv() {
        kinds.push(record.kind);
        dispatch(&mut runtime, record).unwrap();
        let report = observation(&mut runtime);
        assert_eq!(report["pendingMicrotasks"], 0);
        assert_eq!(
            report["completedMicrotasks"],
            report["rows"].as_array().unwrap().len()
        );
        let last = report["rows"].as_array().unwrap().len() - 1;
        dom_bridge::with_document(&mut runtime, |doc| {
            let button = doc.get_element_by_id("button").unwrap();
            assert_eq!(
                doc.get_node(button)
                    .unwrap()
                    .element_data()
                    .unwrap()
                    .attr(blitz_dom::LocalName::from("data-last-microtask")),
                Some(last.to_string().as_str())
            );
        });
        record_ends.push(report["timeline"].as_array().unwrap().len());
    }
    assert_eq!(
        kinds,
        [
            "mousemove",
            "mousedown",
            "mousemove",
            "keydown",
            "keydown",
            "mousemove",
            "keyup",
            "mouseup",
            "mousemove",
            "mousedown",
            "keydown",
            "blur",
            "focus",
            "mousemove",
            "keydown",
            "keyup",
            "mouseup",
            "mousedown",
            "pointerreset",
            "mousemove",
            "mouseup",
            "mousedown",
            "mouseup",
        ]
    );
    let report = observation(&mut runtime);
    assert_eq!(
        report["rows"],
        json!([
            [
                "mousemove",
                "button",
                "button",
                9999.25,
                10,
                0,
                0,
                0,
                true,
                false
            ],
            [
                "mousedown",
                "button",
                "button",
                31,
                41,
                0,
                1,
                0,
                true,
                false
            ],
            [
                "mousemove",
                "button",
                "button",
                9999.25,
                20,
                0,
                1,
                0,
                true,
                false
            ],
            ["keydown", " ", "Space", false, false, true],
            ["keydown", " ", "Space", true, false, true],
            [
                "mousemove",
                "button",
                "button",
                9999.25,
                30,
                0,
                1,
                0,
                true,
                false
            ],
            ["keyup", " ", "Space", false, false, true],
            ["mouseup", "button", "button", 32, 42, 0, 0, 0, true, false],
            ["click", "button", "button", 32, 42, 0, 0, 1, true, true],
            ["click", "button", "parent", 32, 42, 0, 0, 1, true, true],
            [
                "mousemove",
                "button",
                "button",
                9999.25,
                40,
                0,
                0,
                0,
                true,
                false
            ],
            [
                "mousedown",
                "button",
                "button",
                33,
                43,
                0,
                1,
                0,
                true,
                false
            ],
            ["keydown", "r", "KeyR", false, false, true],
            ["blur", true],
            ["focus", true],
            [
                "mousemove",
                "button",
                "button",
                9999.25,
                50,
                0,
                0,
                0,
                true,
                false
            ],
            ["keydown", "r", "KeyR", false, false, true],
            ["keyup", "r", "KeyR", false, false, true],
            ["mouseup", "button", "button", 34, 44, 0, 0, 0, true, false],
            [
                "mousedown",
                "button",
                "button",
                35,
                45,
                0,
                1,
                0,
                true,
                false
            ],
            [
                "mousemove",
                "button",
                "button",
                9999.25,
                60,
                0,
                0,
                0,
                true,
                false
            ],
            ["mouseup", "button", "button", 36, 46, 0, 0, 0, true, false],
            [
                "mousedown",
                "button",
                "button",
                37,
                47,
                0,
                1,
                0,
                true,
                false
            ],
            ["mouseup", "button", "button", 38, 48, 0, 0, 0, true, false],
            ["click", "button", "button", 38, 48, 0, 0, 1, true, true],
            ["click", "button", "parent", 38, 48, 0, 0, 1, true, true],
        ])
    );
    let timeline = report["timeline"].as_array().unwrap();
    let mut start = 0;
    let mut event_index = 0;
    for end in record_ends {
        let events = (end - start) / 2;
        let expected: Vec<_> = (event_index..event_index + events)
            .map(|index| json!(format!("event:{index}")))
            .chain(
                (event_index..event_index + events)
                    .map(|index| json!(format!("microtask:{index}"))),
            )
            .collect();
        assert_eq!(&timeline[start..end], expected);
        start = end;
        event_index += events;
    }
    runtime.run_event_loop(Default::default()).await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn native_dom_input_listener_and_microtask_failures_surface() {
    for (source, message) in [
        (
            "document.getElementById('button').addEventListener('mousedown', () => { throw new Error('input listener failure'); });",
            "input listener failure",
        ),
        (
            "document.getElementById('button').addEventListener('mousedown', () => { Promise.resolve().then(() => { throw new Error('input microtask failure'); }); });",
            "input microtask failure",
        ),
    ] {
        let mut runtime = runtime();
        runtime.execute_script("test:input-errors", source).unwrap();
        let (sender, mut receiver) = window_input::channel();
        sender.try_send(input("mousedown", 1.0, 2.0, "")).unwrap();
        let immediate = dispatch(&mut runtime, receiver.try_recv().unwrap());
        let error = match immediate {
            Err(error) => error.to_string(),
            Ok(()) => tokio::time::timeout(
                std::time::Duration::from_secs(2),
                runtime.run_event_loop(Default::default()),
            )
            .await
            .expect("input failure must not leave an event loop waiting")
            .expect_err("application input exceptions must fail the host")
            .to_string(),
        };
        assert!(error.contains(message), "{error}");
    }
}

#[test]
fn discrete_dom_records_still_reject_queue_overflow_without_reordering() {
    let (sender, mut receiver) = window_input::channel();
    for index in 0..window_input::CAPACITY {
        sender
            .try_send(input("keydown", 0.0, 0.0, &index.to_string()))
            .unwrap();
    }
    let rejected = input("keyup", 0.0, 0.0, "overflow");
    assert_eq!(
        sender.try_send(rejected.clone()),
        Err(threejs_native_input_queue::TrySendError::Full(rejected))
    );
    for index in 0..window_input::CAPACITY {
        assert_eq!(
            receiver.try_recv().unwrap(),
            input("keydown", 0.0, 0.0, &index.to_string())
        );
    }
    assert_eq!(
        receiver.try_recv(),
        Err(threejs_native_input_queue::TryRecvError::Empty)
    );
}

#[test]
fn modifier_changes_bar_motion_coalescing() {
    let (sender, mut receiver) = window_input::channel();
    let plain = input("mousemove", 1.0, 2.0, "");
    let mut shifted = input("mousemove", 3.0, 4.0, "");
    shifted.modifiers.shift = true;
    sender.try_send(plain.clone()).unwrap();
    sender.try_send(shifted.clone()).unwrap();
    let mut latest = shifted.clone();
    latest.x = 9.0;
    sender.try_send(latest.clone()).unwrap();
    assert_eq!(receiver.try_recv().unwrap(), plain);
    assert_eq!(receiver.try_recv().unwrap(), latest);
    assert!(receiver.try_recv().is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn native_keyboard_focus_routing_and_pointer_defaults() {
    let mut runtime = runtime();
    runtime.execute_script("test:focus-input", r#"
      globalThis.__inputDelivery = [];
      const first = document.getElementById('button');
      const second = document.createElement('button'); second.id = 'second';
      document.body.appendChild(second);
      first.focus();
      first.addEventListener('keydown', event => {
        __inputDelivery.push([event.type,event.target.id,event.code,event.repeat,event.shiftKey,event.ctrlKey,event.altKey,event.metaKey]);
        second.focus();
      }, { once: true });
      second.addEventListener('keyup', event => __inputDelivery.push([event.type,event.target.id]));
    "#).unwrap();
    let mut key = input("keydown", 0.0, 0.0, "é");
    key.code = "Digit2".into();
    key.repeat = true;
    key.modifiers = window_input::Modifiers {
        shift: true,
        control: true,
        alt: true,
        meta: true,
    };
    dispatch(&mut runtime, key.clone()).unwrap();
    key.kind = "keyup";
    key.repeat = false;
    dispatch(&mut runtime, key).unwrap();
    assert_eq!(
        observation(&mut runtime),
        json!([
            ["keydown", "button", "Digit2", true, true, true, true, true],
            ["keyup", "second"]
        ])
    );
    runtime.execute_script("test:cancel-tab", r#"
      document.getElementById('second').addEventListener('keydown', event => event.preventDefault(), { once:true });
    "#).unwrap();
    let mut tab = input("keydown", 0.0, 0.0, "Tab");
    tab.code = "Tab".into();
    dispatch(&mut runtime, tab.clone()).unwrap();
    runtime
        .execute_script(
            "test:observe",
            "__inputDelivery = document.activeElement.id",
        )
        .unwrap();
    assert_eq!(observation(&mut runtime), json!("second"));
    tab.modifiers.shift = true;
    dispatch(&mut runtime, tab).unwrap();
    runtime
        .execute_script(
            "test:observe",
            "__inputDelivery = document.activeElement.id",
        )
        .unwrap();
    assert_eq!(observation(&mut runtime), json!("button"));
    runtime.execute_script("test:cancel-pointer", r#"
      document.getElementById('second').focus();
      document.getElementById('button').addEventListener('mousedown', event => event.preventDefault(), { once:true });
    "#).unwrap();
    dispatch(&mut runtime, input("mousedown", 1.0, 2.0, "")).unwrap();
    runtime
        .execute_script(
            "test:observe",
            "__inputDelivery = document.activeElement.id",
        )
        .unwrap();
    assert_eq!(observation(&mut runtime), json!("second"));
    runtime.execute_script("test:detach-pointer", r#"
      document.getElementById('button').addEventListener('mousedown', event => event.target.parentNode.removeChild(event.target), { once:true });
    "#).unwrap();
    dispatch(&mut runtime, input("mousedown", 1.0, 2.0, "")).unwrap();
    runtime
        .execute_script(
            "test:observe",
            "__inputDelivery = document.activeElement.id",
        )
        .unwrap();
    assert_ne!(observation(&mut runtime), json!("button"));
}

#[tokio::test(flavor = "current_thread")]
async fn focus_mutations_validate_before_blur_and_preserve_focused_contents() {
    let mut runtime = runtime();
    runtime.execute_script("test:focus-mutations", r#"
      const button = document.getElementById('button');
      const parent = document.getElementById('parent');
      const log = globalThis.__inputDelivery = [];
      button.addEventListener('blur', () => log.push(['blur',button.isConnected,button.parentNode?.id]));
      button.focus();
      for (const mutate of [() => document.body.removeChild(button), () => button.appendChild(parent)]) {
        try { mutate(); log.push('unexpected success'); }
        catch (error) { log.push([error.name,document.activeElement===button]); }
      }
      button.textContent = 'Updated';
      log.push(['own text',document.activeElement===button]);
      parent.textContent = 'Removed';
      log.push(['ancestor text',document.activeElement===document.body,button.isConnected]);
    "#).unwrap();
    assert_eq!(
        observation(&mut runtime),
        json!([
            ["NotFoundError", true],
            ["HierarchyRequestError", true],
            ["own text", true],
            ["blur", true, "parent"],
            ["ancestor text", true, false]
        ])
    );
}

#[tokio::test(flavor = "current_thread")]
async fn focused_node_blurs_before_reparenting() {
    let mut runtime = runtime();
    runtime.execute_script("test:focus-reparent", r#"
      const button = document.getElementById('button');
      const other = document.createElement('div'); other.id='other'; document.body.appendChild(other);
      const log = globalThis.__inputDelivery = [];
      button.addEventListener('blur', () => log.push(['blur',button.isConnected,button.parentNode.id]));
      button.focus();
      other.appendChild(button);
      log.push(['moved',button.parentNode.id,document.activeElement===document.body]);
    "#).unwrap();
    assert_eq!(
        observation(&mut runtime),
        json!([["blur", true, "parent"], ["moved", "other", true]])
    );
}

#[tokio::test(flavor = "current_thread")]
async fn focused_no_op_insertions_still_run_focus_removal_steps() {
    for operation in [
        "parent.insertBefore(button,button)",
        "parent.appendChild(button)",
        "parent.insertBefore(button,button.nextSibling)",
    ] {
        let mut runtime = runtime();
        let source = format!(
            r#"
          const button=document.getElementById('button'), parent=document.getElementById('parent');
          const log=globalThis.__inputDelivery=[];
          button.addEventListener('blur',()=>log.push(['blur',button.parentNode===parent]));
          button.addEventListener('focusout',()=>log.push(['focusout',button.parentNode===parent]));
          button.focus();
          {operation};
          log.push(['activeBody',document.activeElement===document.body]);
        "#
        );
        runtime.execute_script("test:focus-no-op", source).unwrap();
        assert_eq!(
            observation(&mut runtime),
            json!([["blur", true], ["focusout", true], ["activeBody", true]])
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn native_keys_follow_window_document_capture_and_bubble_path() {
    let mut runtime = runtime();
    runtime
        .execute_script(
            "test:key-event-path",
            r#"
      const button=document.getElementById('button');
      button.focus();
      globalThis.__inputDelivery=[];
      const record=(label,owner)=>event=>__inputDelivery.push([
        label,event.target===button,event.currentTarget===owner,event.eventPhase
      ]);
      globalThis.addEventListener('keydown',record('window capture',globalThis),true);
      document.addEventListener('keydown',record('document capture',document),true);
      button.addEventListener('keydown',record('target',button));
      document.addEventListener('keydown',record('document bubble',document));
      globalThis.addEventListener('keydown',record('window bubble',globalThis));
    "#,
        )
        .unwrap();
    dispatch(&mut runtime, input("keydown", 0.0, 0.0, "a")).unwrap();
    assert_eq!(
        observation(&mut runtime),
        json!([
            ["window capture", true, true, 1],
            ["document capture", true, true, 1],
            ["target", true, true, 2],
            ["document bubble", true, true, 3],
            ["window bubble", true, true, 3]
        ])
    );
    runtime
        .execute_script(
            "test:cancel-stop-tab",
            r#"
      __inputDelivery=[];
      const second=document.createElement('button'); document.body.appendChild(second);
      button.addEventListener('keydown',event=>{
        event.preventDefault(); event.stopPropagation();
      },{once:true});
    "#,
        )
        .unwrap();
    dispatch(&mut runtime, input("keydown", 0.0, 0.0, "Tab")).unwrap();
    runtime
        .execute_script(
            "test:observe-tab",
            "__inputDelivery.push(['focus retained',document.activeElement===button])",
        )
        .unwrap();
    assert_eq!(
        observation(&mut runtime),
        json!([
            ["window capture", true, true, 1],
            ["document capture", true, true, 1],
            ["target", true, true, 2],
            ["focus retained", true]
        ])
    );
}

#[tokio::test(flavor = "current_thread")]
async fn document_load_does_not_propagate_to_default_view() {
    let mut runtime = runtime();
    runtime
        .execute_script(
            "test:document-load",
            r#"
      globalThis.__inputDelivery=[['defaultView',document.defaultView===globalThis]];
      globalThis.addEventListener('load',()=>__inputDelivery.push('window capture'),true);
      globalThis.addEventListener('load',()=>__inputDelivery.push('window bubble'));
      document.addEventListener('load',event=>__inputDelivery.push([
        'document',event.target===document,event.currentTarget===document
      ]));
      document.dispatchEvent(new Event('load',{bubbles:true}));
    "#,
        )
        .unwrap();
    assert_eq!(
        observation(&mut runtime),
        json!([["defaultView", true], ["document", true, true]])
    );
}
