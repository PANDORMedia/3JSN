use std::{path::PathBuf, process::ExitCode};
use threejs_native_runtime::Runtime;

mod input;
mod package;
mod window;

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let Some(argument) = args.next() else {
        return run_package(None, None);
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
    if argument == "--describe" && args.len() == 0 {
        println!(
            "{}",
            serde_json::to_string(&package::description()).expect("static runtime description")
        );
        return ExitCode::SUCCESS;
    }
    if argument == "--verify-app" && args.len() == 1 {
        let path = PathBuf::from(args.next().expect("one argument"));
        return finish(package::load(&path).map(|_| println!("{{\"packageVerified\":true}}")));
    }
    if argument == "--app" {
        let Some(manifest) = args.next() else {
            return usage();
        };
        let Ok(frames) = frame_limit(args) else {
            return usage();
        };
        return run_package(Some(PathBuf::from(manifest)), frames);
    }
    if argument == "--frames" {
        let Ok(frames) = frame_limit(std::iter::once(argument).chain(args)) else {
            return usage();
        };
        return run_package(None, frames);
    }
    if argument != "--window"
        && argument
            .to_str()
            .is_some_and(|value| value.starts_with('-'))
    {
        return usage();
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
    let frames = match frame_limit(args) {
        Ok(frames) if is_window || frames.is_none() => frames,
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
    finish(result)
}

fn frame_limit(mut args: impl Iterator<Item = std::ffi::OsString>) -> Result<Option<u64>, ()> {
    Ok(match args.next() {
        None => None,
        Some(flag) if flag == "--frames" => {
            let Some(count) = args
                .next()
                .and_then(|count| count.to_str().and_then(|count| count.parse::<u64>().ok()))
            else {
                return Err(());
            };
            if count == 0 || args.next().is_some() {
                return Err(());
            }
            Some(count)
        }
        _ => return Err(()),
    })
}

fn run_package(manifest: Option<PathBuf>, frames: Option<u64>) -> ExitCode {
    let result = (|| {
        let path = match manifest {
            Some(path) => path,
            None => std::env::current_exe()
                .map_err(|error| format!("cannot locate player executable: {error}"))?
                .with_file_name("app.json"),
        };
        let app = package::load(&path).map_err(|error| error.to_string())?;
        window::run(app.entry, frames)
    })();
    finish(result)
}

fn finish(result: Result<(), impl std::fmt::Display>) -> ExitCode {
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
        "Usage: threejs-native-player [--window] <module.mjs> [--frames COUNT]\n       threejs-native-player --app <app.json> [--frames COUNT]\n       threejs-native-player --verify-app <app.json>\n       threejs-native-player --version | --describe\n       packaged-executable [--frames COUNT]"
    );
    ExitCode::from(2)
}
