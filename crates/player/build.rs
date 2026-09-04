// Links libmpv through pkg-config (Homebrew on macOS, distro packages on Linux).
fn main() {
    pkg_config::Config::new()
        .atleast_version("2.0")
        .probe("mpv")
        .expect("libmpv not found: install mpv (brew install mpv) or libmpv-dev");
}
