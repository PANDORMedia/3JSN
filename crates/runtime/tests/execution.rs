use std::path::Path;
use threejs_native_runtime::{Runtime, RuntimeError};

#[tokio::test(flavor = "current_thread")]
async fn modules_web_globals_and_errors() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    Runtime::new()
        .execute_module(&fixture.join("modules.mjs"))
        .await
        .unwrap();
    Runtime::new()
        .execute_module(&fixture.join("animation.mjs"))
        .await
        .unwrap();
    let thrown = Runtime::new()
        .execute_module(&fixture.join("throws.mjs"))
        .await
        .unwrap_err();
    assert!(
        thrown
            .to_string()
            .contains("fixture failure with source location")
    );
    assert!(thrown.to_string().contains("throws.mjs:1"));
    let listener = Runtime::new()
        .execute_module(&fixture.join("listener-throws.mjs"))
        .await
        .unwrap_err();
    assert!(listener.to_string().contains("unhandled listener failure"));
    assert!(listener.to_string().contains("listener-throws.mjs:2"));
    for (name, message) in [
        ("throw-with-interval.mjs", "failure with pending interval"),
        ("timer-throws.mjs", "asynchronous timer failure"),
    ] {
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            Runtime::new().execute_module(&fixture.join(name)),
        )
        .await
        .expect("failed module must not leave referenced work running")
        .unwrap_err();
        assert!(error.to_string().contains(message));
        assert!(error.to_string().contains(name));
    }
    let missing = Runtime::new()
        .execute_module(&fixture.join("missing-import.mjs"))
        .await
        .unwrap_err();
    assert!(missing.to_string().contains("does-not-exist.mjs"));
    assert!(matches!(
        Runtime::new()
            .execute_module(&fixture.join("absent.mjs"))
            .await,
        Err(RuntimeError::ModulePath { .. })
    ));

    let runtime = Runtime::new();
    let interrupt = runtime.interrupt_handle();
    let worker_interrupt = interrupt.clone();
    let interrupter = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(worker_interrupt.terminate());
    });
    assert!(matches!(
        runtime.execute_module(&fixture.join("infinite.mjs")).await,
        Err(RuntimeError::Cancelled)
    ));
    interrupter.join().unwrap();
    assert!(
        !interrupt.terminate(),
        "disposed isolates reject further interrupts safely"
    );
}
