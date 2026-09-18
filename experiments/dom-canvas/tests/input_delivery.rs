//! CPU delivery through the real DOM/window bindings. The target is obtained by
//! native DOM query, so these tests do not establish hit testing or OS input.

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
        [
            kind.into(),
            x.into(),
            y.into(),
            button.into(),
            key.into(),
            target.into(),
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
            ["keydown", " ", "Space", false, true, true],
            ["keydown", " ", "Space", true, true, true],
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
            ["keyup", " ", "Space", false, true, true],
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
            ["keydown", "r", "KeyR", false, true, true],
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
            ["keydown", "r", "KeyR", false, true, true],
            ["keyup", "r", "KeyR", false, true, true],
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
