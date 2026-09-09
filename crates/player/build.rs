// Links libmpv. macOS (Homebrew) and Linux (libmpv-dev) have it in pkg-config. Windows has no
// pkg-config install of libmpv, so BP_MPV_DIR, an extracted mpv-dev package holding the mpv.lib
// import library that scripts/mpv-windows.ps1 makes from libmpv-2.dll, is linked directly and no
// pkg-config is needed there. BP_MPV_DIR wins on every platform when set.
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=BP_MPV_DIR");
    if let Some(dir) = std::env::var_os("BP_MPV_DIR").filter(|d| !d.is_empty()) {
        let dir = PathBuf::from(dir);
        let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
        if msvc && !dir.join("mpv.lib").exists() {
            panic!(
                "BP_MPV_DIR={} has no mpv.lib; run scripts/mpv-windows.ps1 -Dir {} from a Developer PowerShell to make it",
                dir.display(),
                dir.display()
            );
        }
        println!("cargo:rustc-link-search=native={}", dir.display());
        println!("cargo:rustc-link-lib=dylib=mpv");
    } else {
        pkg_config::Config::new()
            .atleast_version("2.0")
            .probe("mpv")
            .expect("libmpv not found: install mpv (brew install mpv) or libmpv-dev, or set BP_MPV_DIR to an mpv-dev package");
    }

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            // Preserve runtime availability checks instead of adopting the SDK's minimum OS.
            .env("MACOSX_DEPLOYMENT_TARGET", "11.0")
            .file("src/macos/scaler.m")
            .flag("-fobjc-arc")
            .flag("-fobjc-arc-exceptions")
            .flag("-Wno-deprecated-declarations")
            .compile("bp_apple_scaler");
        println!("cargo:rerun-if-changed=src/macos/scaler.m");
        for framework in ["Foundation", "VideoToolbox", "CoreVideo", "CoreMedia", "CoreImage", "CoreGraphics", "Metal", "OpenGL"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
}
