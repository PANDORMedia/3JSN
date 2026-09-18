use std::path::PathBuf;

fn main() {
    assert_eq!(std::env::var("CARGO_CFG_TARGET_OS").unwrap(), "macos");
    let package = PathBuf::from(
        std::env::var_os("THREEJS_NATIVE_ANGLE_PACKAGE")
            .expect("Set THREEJS_NATIVE_ANGLE_PACKAGE to the pinned gl@9.0.0-rc.10 package"),
    );
    let metadata: String = std::fs::read_to_string(package.join("package.json")).unwrap();
    let metadata: serde_json::Value =
        serde_json::from_str(&metadata).expect("ANGLE package metadata");
    assert_eq!(metadata["name"], "gl", "Unexpected ANGLE package name");
    assert_eq!(
        metadata["version"], "9.0.0-rc.10",
        "Unexpected ANGLE package version"
    );
    let native = package.join("src/native");
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .flag("-fobjc-arc")
        .include(native.join("angle-includes"))
        .include(&native)
        .file("native/angle.mm")
        .file(native.join("angle-loader/egl_loader.cc"))
        .file(native.join("angle-loader/gles_loader.cc"))
        .compile("webgl_angle");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=Metal");
    println!("cargo:rustc-link-lib=framework=IOSurface");
    println!("cargo:rerun-if-env-changed=THREEJS_NATIVE_ANGLE_PACKAGE");
    println!("cargo:rerun-if-changed=native/angle.mm");
    println!("cargo:rerun-if-changed=native/angle.h");
    println!(
        "cargo:rerun-if-changed={}",
        package.join("package.json").display()
    );
}
