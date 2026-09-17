use std::path::PathBuf;

fn main() {
    assert_eq!(std::env::var("CARGO_CFG_TARGET_OS").unwrap(), "macos");
    let angle = PathBuf::from(
        std::env::var_os("THREEJS_NATIVE_ANGLE_PACKAGE")
            .expect("Set THREEJS_NATIVE_ANGLE_PACKAGE to the isolated gl@9.0.0-rc.10 package"),
    );
    let native = angle.join("src/native");
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .flag("-fobjc-arc")
        .include(native.join("angle-includes"))
        .include(&native)
        .file("bridge.mm")
        .file(native.join("angle-loader/egl_loader.cc"))
        .file(native.join("angle-loader/gles_loader.cc"))
        .compile("angle_bridge");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=Metal");
    println!("cargo:rerun-if-env-changed=THREEJS_NATIVE_ANGLE_PACKAGE");
    println!("cargo:rerun-if-changed=bridge.mm");
}
