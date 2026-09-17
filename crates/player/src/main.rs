use std::{path::PathBuf, process::ExitCode};
use threejs_native_runtime::Runtime;

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let Some(argument) = args.next() else {
        eprintln!("Usage: threejs-native-player <module.mjs>");
        return ExitCode::from(2);
    };
    if args.next().is_some() {
        eprintln!("Expected one local JavaScript module path");
        return ExitCode::from(2);
    }
    if argument == "--version" {
        println!(
            "3JSN {} / V8 {} / {} / {}-{}",
            env!("CARGO_PKG_VERSION"),
            threejs_native_runtime::engine_version(),
            threejs_native_runtime::backend_name(),
            std::env::consts::OS,
            std::env::consts::ARCH
        );
        return ExitCode::SUCCESS;
    }
    let path = PathBuf::from(argument);
    match Runtime::new().execute_module(&path).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
