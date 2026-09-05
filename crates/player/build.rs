fn main() {
    pkg_config::Config::new().atleast_version("2.0").probe("mpv").expect("libmpv not found: install mpv (brew install mpv) or libmpv-dev");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()

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
