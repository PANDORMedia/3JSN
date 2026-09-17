use blitz_dom::{Document, DocumentConfig};
use blitz_vibey_script::ScriptDocument;

#[test]
fn dynamic_profile_observation() {
    let mut document = ScriptDocument::from_html(
        "<!doctype html><html><body><div id='root'></div></body></html>",
        DocumentConfig::default(),
    )
    .without_timer_thread()
    .with_virtual_time();
    document.execute_scripts();
    document.eval(include_str!("threejsn-fixture.js"));
    for _ in 0..2 {
        let deadline = document.next_timer_deadline().expect("scheduled frame");
        document.advance_clock_to(deadline);
        document.poll(None);
    }
    let errors = document.take_js_errors();
    assert!(errors.is_empty(), "{errors:?}");
    let messages = document.take_messages();
    assert_eq!(messages.len(), 2);
    for message in messages {
        println!("3JSN_HTML_OBSERVATION {message}");
    }
}
