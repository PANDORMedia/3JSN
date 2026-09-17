use std::{path::PathBuf, process::ExitCode};
use threejs_native_runtime::Runtime;

mod window;

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let Some(argument) = args.next() else {
        return usage();
    };
    if argument == "--version" && args.len() == 0 {
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
    let is_window = argument == "--window";
    let module = if is_window {
        let Some(module) = args.next() else {
            return usage();
        };
        module
    } else {
        argument
    };
    let frames = match args.next() {
        None => None,
        Some(flag) if is_window && flag == "--frames" => {
            let Some(count) = args
                .next()
                .and_then(|count| count.to_str().and_then(|count| count.parse::<u64>().ok()))
            else {
                return usage();
            };
            if count == 0 || args.next().is_some() {
                return usage();
            }
            Some(count)
        }
        _ => return usage(),
    };
    let path = PathBuf::from(module);
    let result = if is_window {
        window::run(path, frames)
    } else {
        match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(reactor) => reactor.block_on(async {
                Runtime::new()
                    .execute_module(&path)
                    .await
                    .map_err(|error| error.to_string())
            }),
            Err(error) => Err(format!("cannot start async reactor: {error}")),
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn usage() -> ExitCode {
    eprintln!(
        "Usage: threejs-native-player [--window] <module.mjs> [--frames COUNT]\n       threejs-native-player --version"
    );
    ExitCode::from(2)
}
