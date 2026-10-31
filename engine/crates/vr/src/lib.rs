mod follow;
mod gestures;
mod maths;
mod presence;
pub use follow::Follow;
pub use gestures::{Action, Buzz, Gestures, Shortcut, Step};
pub use maths::{EyeView, Pose, Recentre, eye_view, panel};
pub use presence::{Presence, Signal};

#[cfg(windows)]
mod input;
#[cfg(windows)]
mod overlays;
#[cfg(windows)]
mod runtime;
#[cfg(windows)]
mod scene;
#[cfg(windows)]
#[allow(clippy::all)]
mod sys;
#[cfg(windows)]
pub use overlays::Overlays;
#[cfg(windows)]
pub use scene::{Events, Eye, Frame, Scene, mirror, release_mirror};

pub const ERROR_CODES: [&str; 11] =
    ["not-installed", "not-running", "no-headset", "other-gpu", "no-interop", "old-steamvr", "timeout", "busy", "quit", "compositor", "failed"];

pub fn coded(error: String) -> String {
    let known = error.split_once(": ").is_some_and(|(code, _)| ERROR_CODES.contains(&code));
    if known { error } else { format!("failed: {error}") }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Availability {
    pub installed: bool,
    pub hmd: bool,
}

pub fn availability() -> Availability {
    #[cfg(windows)]
    {
        use std::sync::Mutex;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::{Duration, Instant};
        static LAST: Mutex<Option<(Instant, Availability)>> = Mutex::new(None);
        static CHECKING: AtomicBool = AtomicBool::new(false);
        let check = || {
            let installed = runtime::installed();
            let a = Availability { installed, hmd: installed && runtime::steamvr_running() && runtime::hmd_present() };
            *LAST.lock().unwrap() = Some((Instant::now(), a));
            a
        };
        let last = *LAST.lock().unwrap();
        match last {
            None => check(),
            Some((at, a)) => {
                if at.elapsed() > Duration::from_secs(2) && !CHECKING.swap(true, Ordering::AcqRel) {
                    let spawned = std::thread::Builder::new().name("bp-vr-check".into()).spawn(move || {
                        check();
                        CHECKING.store(false, Ordering::Release);
                    });
                    if spawned.is_err() {
                        CHECKING.store(false, Ordering::Release);
                    }
                }
                a
            }
        }
    }
    #[cfg(not(windows))]
    Availability::default()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OverlayEvent {
    pub overlay: i32,
    pub kind: &'static str,
    pub x: f32,
    pub y: f32,
    pub button: u32,
    pub dx: f32,
    pub dy: f32,
}

#[cfg(windows)]
impl OverlayEvent {
    pub(crate) fn system(kind: &'static str) -> OverlayEvent {
        OverlayEvent { overlay: -1, kind, x: 0.0, y: 0.0, button: 0, dx: 0.0, dy: 0.0 }
    }
}

#[cfg(not(windows))]
pub struct Overlays(std::convert::Infallible);

#[cfg(not(windows))]
impl Overlays {
    pub fn new() -> Result<Overlays, String> {
        Err("not-installed: SteamVR needs Windows".into())
    }
    pub fn create(&mut self, _: &str, _: &str, _: u32, _: u32, _: f32, _: f32) -> Result<u32, String> {
        match self.0 {}
    }
    pub fn resize(&mut self, _: u32, _: u32, _: u32) -> Result<(), String> {
        match self.0 {}
    }
    pub fn paint(&mut self, _: u32, _: &[u8], _: u32, _: u32, _: u32, _: u32) -> Result<(), String> {
        match self.0 {}
    }
    pub fn place(&mut self, _: u32, _: f32, _: f32, _: f32) -> Result<(), String> {
        match self.0 {}
    }
    pub fn recentre(&mut self, _: f32) -> Result<(), String> {
        match self.0 {}
    }
    pub fn show(&mut self, _: u32, _: bool) -> Result<(), String> {
        match self.0 {}
    }
    pub fn follow(&mut self, _: u32, _: bool) -> Result<(), String> {
        match self.0 {}
    }
    pub fn hide(&mut self, _: u32) -> Result<(), String> {
        match self.0 {}
    }
    pub fn poll(&mut self) -> Vec<OverlayEvent> {
        match self.0 {}
    }
    pub fn close(&mut self) {
        match self.0 {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_keep_their_code_or_fall_under_failed() {
        assert_eq!(coded("not-running: SteamVR is not running".into()), "not-running: SteamVR is not running");
        assert_eq!(coded("CreateTexture2D: out of memory".into()), "failed: CreateTexture2D: out of memory");
        assert_eq!(coded("no headset".into()), "failed: no headset");
    }
}
