//! libmpv player that renders offscreen and hands BGRA frames to the host, and reports
//! clock events (time, pause, speed, seeks) to an optional sink.

mod enhance;
mod frames;
mod gl_context;
mod mpv;
mod render;
mod stats;
#[cfg(windows)]
mod windows;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub use enhance::{EnhanceCapabilities, EnhanceOptions, EnhanceState, Upscaler};
pub use frames::{Acquired, External, FrameSlot};
pub use stats::{Percentiles, RenderSnapshot};

use enhance::Enhance;
use frames::Frames;
use mpv::{Event, Mpv, Property};
use render::{Msg, RenderConfig};
use stats::RenderStats;

/// What the host needs to keep a media clock and know when to resync.
#[derive(Clone, Debug, PartialEq)]
pub enum PlayerEvent {
    FileLoaded,
    /// Playback ended; `error` when the file or page could not be opened.
    EndFile { error: Option<String> },
    Seek,
    PlaybackRestart,
    TimePos(f64),
    Duration(f64),
    Pause(bool),
    /// mpv's `core-idle`: true whenever the position is not advancing (paused, seeking,
    /// buffering, nothing loaded). The clock should run only while this is false.
    Idle(bool),
    Speed(f64),
    /// The decoded picture size, 0 by 0 when nothing is loaded.
    VideoSize(u32, u32),
}

pub type EventSink = Arc<dyn Fn(PlayerEvent) + Send + Sync>;

pub struct PlayerOptions {
    /// mpv `hwdec` value. Defaults to the platform's zero-copy decoder.
    pub hwdec: Option<String>,
    /// Collect mpv log lines at "v" instead of "warn".
    pub verbose: bool,
    /// Frame bytes come out as BGRA instead of RGBA.
    pub bgra: bool,
    /// Fenced readback: published as soon as the GPU has copied, without blocking the render thread.
    pub async_readback: bool,
    /// Each frame carries mpv's position when it was rendered (`Acquired::pts`).
    pub stamp_frames: bool,
    /// No frame is replaced unread: the render thread waits for the reader, which paces an
    /// untimed decode to it. For a reader on its own thread, never the on-screen player.
    pub hold_frames: bool,
    /// Extra mpv options applied before init, for experiments like `scale=bilinear`.
    pub mpv_options: Vec<(String, String)>,
}

impl Default for PlayerOptions {
    fn default() -> PlayerOptions {
        PlayerOptions { hwdec: None, verbose: false, bgra: true, async_readback: true, stamp_frames: false, hold_frames: false, mpv_options: Vec::new() }
    }
}

pub struct Player {
    mpv: Arc<Mpv>,
    frames: Arc<Frames>,
    stats: Arc<RenderStats>,
    log: Arc<Mutex<Vec<String>>>,
    /// Boxed so the pointer mpv holds for the update callback stays stable.
    tx: Option<Box<Sender<Msg>>>,
    render: Option<JoinHandle<()>>,
    events: Option<JoinHandle<()>>,
    stop_events: Arc<AtomicBool>,
    bgra: bool,
    /// Upscaling and frame generation; shared with the events thread, which feeds it the source size.
    enhance: Arc<Mutex<Enhance>>,
    /// A picture is configured (both dimensions known). Off between files, so the render
    /// thread skips mpv's blank redraws and the host keeps the last frame across a load.
    has_video: Arc<AtomicBool>,
}

/// Loads files on a player from any thread, for a host that scans scripts on a worker and
/// wants the file and its scripts to swap in together.
#[derive(Clone)]
pub struct MediaLoader {
    mpv: Arc<Mpv>,
}

impl MediaLoader {
    /// Same as `Player::load`.
    pub fn load(&self, path: &str, start_seconds: Option<f64>) -> Result<(), String> {
        load_file(&self.mpv, path, start_seconds)
    }

    pub fn hwdec_current(&self) -> String {
        self.mpv.get_string("hwdec-current").unwrap_or_default()
    }
}

fn load_file(mpv: &Mpv, path: &str, start_seconds: Option<f64>) -> Result<(), String> {
    match start_seconds {
        Some(s) if s > 0.0 => mpv.command(&["loadfile", path, "replace", "-1", &format!("start={s}")]),
        _ => mpv.command(&["loadfile", path]),
    }
}

fn default_hwdec() -> &'static str {
    if cfg!(target_os = "macos") {
        "videotoolbox"
    } else if cfg!(target_os = "windows") {
        "d3d11va"
    } else {
        "auto-safe"
    }
}

impl Player {
    pub fn new(width: u32, height: u32, opts: PlayerOptions, sink: Option<EventSink>) -> Result<Player, String> {
        let mpv = Mpv::create()?;
        mpv.set_option("vo", "libmpv")?;
        mpv.set_option("hwdec", opts.hwdec.as_deref().unwrap_or(default_hwdec()))?;
        mpv.set_option("idle", "yes")?;
        mpv.set_option("keep-open", "yes")?;
        mpv.set_option("pause", "yes")?;
        for (k, v) in &opts.mpv_options {
            mpv.set_option(k, v)?;
        }
        mpv.request_log(if opts.verbose { "v" } else { "warn" })?;
        mpv.initialize()?;
        mpv.observe("time-pos", mpv::MPV_FORMAT_DOUBLE)?;
        mpv.observe("duration", mpv::MPV_FORMAT_DOUBLE)?;
        mpv.observe("pause", mpv::MPV_FORMAT_FLAG)?;
        mpv.observe("core-idle", mpv::MPV_FORMAT_FLAG)?;
        mpv.observe("speed", mpv::MPV_FORMAT_DOUBLE)?;
        mpv.observe("video-params/w", mpv::MPV_FORMAT_DOUBLE)?;
        mpv.observe("video-params/h", mpv::MPV_FORMAT_DOUBLE)?;
        let mpv = Arc::new(mpv);

        let log = Arc::new(Mutex::new(Vec::new()));
        let stop_events = Arc::new(AtomicBool::new(false));
        let enhance = Arc::new(Mutex::new(Enhance::new(enhance_capabilities(), (width, height))));
        let has_video = Arc::new(AtomicBool::new(false));
        let events = {
            let mpv = mpv.clone();
            let log = log.clone();
            let stop = stop_events.clone();
            let enhance = enhance.clone();
            let has_video = has_video.clone();
            thread::Builder::new()
                .name("bp-mpv-events".into())
                .spawn(move || {
                    let emit = |e: PlayerEvent| {
                        if let Some(s) = &sink {
                            s(e);
                        }
                    };
                    // The picture size is two properties that change together; the other one is
                    // read when either is reported, so the size never goes out half updated
                    // (the new width with the old height would refit the host's output twice).
                    let mut size = (0u32, 0u32);
                    while !stop.load(Ordering::Relaxed) {
                        match mpv.wait_event(0.25) {
                            Event::Shutdown => break,
                            Event::EndFile { error } => {
                                if let Some(e) = &error {
                                    push_log(&log, format!("end-file error: {e}"));
                                }
                                emit(PlayerEvent::EndFile { error });
                            }
                            Event::FileLoaded => emit(PlayerEvent::FileLoaded),
                            Event::Seek => emit(PlayerEvent::Seek),
                            Event::PlaybackRestart => emit(PlayerEvent::PlaybackRestart),
                            Event::Property { name, value } => match (name.as_str(), value) {
                                ("time-pos", Some(Property::Double(t))) => emit(PlayerEvent::TimePos(t)),
                                ("duration", Some(Property::Double(d))) => emit(PlayerEvent::Duration(d)),
                                ("pause", Some(Property::Flag(p))) => emit(PlayerEvent::Pause(p)),
                                ("core-idle", Some(Property::Flag(i))) => emit(PlayerEvent::Idle(i)),
                                ("speed", Some(Property::Double(s))) => emit(PlayerEvent::Speed(s)),
                                (name @ ("video-params/w" | "video-params/h"), v) => {
                                    let this = dimension(v);
                                    let other = if name == "video-params/w" { "video-params/h" } else { "video-params/w" };
                                    let other = mpv.get_double(other).map_or(0, |d| if d > 0.0 { d as u32 } else { 0 });
                                    let next = if name == "video-params/w" { (this, other) } else { (other, this) };
                                    // Both dimensions or neither: nothing is configured until both are known.
                                    let next = if next.0 > 0 && next.1 > 0 { next } else { (0, 0) };
                                    if next != size {
                                        size = next;
                                        has_video.store(size.0 > 0, Ordering::Relaxed);
                                        emit(PlayerEvent::VideoSize(size.0, size.1));
                                        // The RTX factor depends on the source size, so it is refitted here.
                                        if let Err(e) = enhance.lock().unwrap().set_source(&mpv, size) {
                                            push_log(&log, format!("enhance: {e}"));
                                        }
                                    }
                                }
                                _ => {}
                            },
                            Event::Log(line) => push_log(&log, line),
                            _ => {}
                        }
                    }
                })
                .map_err(|e| e.to_string())?
        };

        let frames = Arc::new(Frames::new(width, height, opts.hold_frames));
        let stats = Arc::new(RenderStats::new());
        let cfg = RenderConfig { bgra: opts.bgra, async_readback: opts.async_readback, stamp: opts.stamp_frames };
        let (tx, render) = render::spawn(mpv.clone(), frames.clone(), stats.clone(), cfg, has_video.clone())?;

        Ok(Player {
            mpv,
            frames,
            stats,
            log,
            tx: Some(tx),
            render: Some(render),
            events: Some(events),
            stop_events,
            bgra: opts.bgra,
            enhance,
            has_video,
        })
    }

    /// Loads `path`, starting at `start_seconds` when given (resume). Loading is asynchronous:
    /// `FileLoaded` arrives when seeks and properties become valid.
    pub fn load(&self, path: &str, start_seconds: Option<f64>) -> Result<(), String> {
        load_file(&self.mpv, path, start_seconds)
    }

    /// A handle that loads files from any thread.
    pub fn media_loader(&self) -> MediaLoader {
        MediaLoader { mpv: self.mpv.clone() }
    }

    /// Whether a picture is configured right now: false between files and with nothing loaded.
    pub fn has_video(&self) -> bool {
        self.has_video.load(Ordering::Relaxed)
    }

    pub fn play(&self) -> Result<(), String> {
        self.mpv.set_property("pause", "no")
    }

    pub fn pause(&self) -> Result<(), String> {
        self.mpv.set_property("pause", "yes")
    }

    pub fn seek(&self, seconds: f64) -> Result<(), String> {
        self.mpv.command(&["seek", &seconds.to_string(), "absolute"])
    }

    /// Unloads the current file; the last frame stays on screen until the next load.
    pub fn stop(&self) -> Result<(), String> {
        self.mpv.command(&["stop"])
    }

    pub fn set_rate(&self, rate: f64) -> Result<(), String> {
        self.mpv.set_property("speed", &rate.clamp(0.1, 4.0).to_string())
    }

    pub fn rate(&self) -> f64 {
        self.mpv.get_double("speed").unwrap_or(1.0)
    }

    /// 0..1, mapped onto mpv's 0..100.
    pub fn set_volume(&self, volume: f64) -> Result<(), String> {
        self.mpv.set_property("volume", &(volume.clamp(0.0, 1.0) * 100.0).to_string())
    }

    pub fn volume(&self) -> f64 {
        self.mpv.get_double("volume").unwrap_or(100.0) / 100.0
    }

    pub fn set_muted(&self, muted: bool) -> Result<(), String> {
        self.mpv.set_property("mute", if muted { "yes" } else { "no" })
    }

    pub fn muted(&self) -> bool {
        self.mpv.get_flag("mute").unwrap_or(false)
    }

    pub fn time_pos(&self) -> f64 {
        self.mpv.get_double("time-pos").unwrap_or(0.0)
    }

    pub fn duration(&self) -> f64 {
        self.mpv.get_double("duration").unwrap_or(0.0)
    }

    pub fn paused(&self) -> bool {
        self.mpv.get_flag("pause").unwrap_or(true)
    }

    pub fn video_fps(&self) -> f64 {
        self.mpv.get_double("container-fps").unwrap_or(0.0)
    }

    /// mpv `hwdec` value (`auto-safe`, `videotoolbox`, `no`); takes effect on the next decoder init.
    pub fn set_hwdec(&self, value: &str) -> Result<(), String> {
        self.mpv.set_property("hwdec", value)
    }

    pub fn hwdec_current(&self) -> String {
        self.mpv.get_string("hwdec-current").unwrap_or_default()
    }

    /// The decoded picture size by a synchronous property read. Hosts on a frame loop should
    /// keep the `VideoSize` event instead: this waits for mpv's core.
    pub fn video_size(&self) -> (u32, u32) {
        let w = self.mpv.get_double("video-params/w").unwrap_or(0.0) as u32;
        let h = self.mpv.get_double("video-params/h").unwrap_or(0.0) as u32;
        (w, h)
    }

    /// Whether anyone is looking at the frames. While false the render thread lets mpv skip
    /// drawing and reads nothing back; audio and the clock carry on.
    pub fn set_presenting(&self, on: bool) -> Result<(), String> {
        let tx = self.tx.as_ref().ok_or("player closed")?;
        tx.send(Msg::Presenting(on)).map_err(|_| "render thread gone".to_string())
    }

    /// Output size, and the host memory to write frames into (engine-owned when `None`).
    /// Blocks until the render thread has swapped the new slots in, so the old memory is
    /// free to release when this returns.
    pub fn resize(&self, width: u32, height: u32, external: Option<External>) -> Result<(), String> {
        let tx = self.tx.as_ref().ok_or("player closed")?;
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        tx.send(Msg::Resize(width, height, external, done_tx)).map_err(|_| "render thread gone".to_string())?;
        done_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "resize timed out".to_string())?;
        self.enhance.lock().unwrap().set_output(&self.mpv, (width, height))
    }

    /// What this machine can do for upscaling and frame generation, probed at start.
    pub fn enhance_capabilities(&self) -> EnhanceCapabilities {
        self.enhance.lock().unwrap().capabilities()
    }

    /// Applies upscaling and frame generation to the current video, no reload. Options this
    /// machine cannot honour are kept but left inert; `enhance_state` says why.
    pub fn set_enhance(&self, options: EnhanceOptions) -> Result<(), String> {
        self.enhance.lock().unwrap().set_options(&self.mpv, options)
    }

    pub fn enhance_options(&self) -> EnhanceOptions {
        self.enhance.lock().unwrap().options()
    }

    /// What is in effect right now, for the player chip.
    pub fn enhance_state(&self) -> EnhanceState {
        self.enhance.lock().unwrap().state()
    }

    pub fn size(&self) -> (u32, u32) {
        self.frames.size()
    }

    pub fn bgra(&self) -> bool {
        self.bgra
    }

    /// Index of the newest unread frame slot, if any.
    pub fn acquire(&self) -> Option<usize> {
        let a = self.frames.acquire()?;
        self.stats.acquired(a.waited);
        Some(a.index)
    }

    /// The newest unread frame, waiting up to `timeout` for one, for a reader on its own
    /// thread rather than a frame loop.
    pub fn acquire_wait(&self, timeout: Duration) -> Option<Acquired> {
        let a = self.frames.acquire_wait(timeout)?;
        self.stats.acquired(a.waited);
        Some(a)
    }

    /// The memory of a frame slot, for reading an acquired frame in engine-owned slots.
    pub fn slot(&self, index: usize) -> Arc<FrameSlot> {
        self.frames.slot(index)
    }

    pub fn stats(&self) -> RenderSnapshot {
        self.stats.snapshot()
    }

    pub fn take_log(&self) -> Vec<String> {
        std::mem::take(&mut *self.log.lock().unwrap())
    }

    /// Tears down in the order mpv requires: render context, then core, then handle.
    pub fn close(&mut self) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(Msg::Stop);
        }
        if let Some(h) = self.render.take() {
            let _ = h.join();
        }
        self.tx = None;
        let _ = self.mpv.command(&["quit"]);
        self.stop_events.store(true, Ordering::Relaxed);
        if let Some(h) = self.events.take() {
            let _ = h.join();
        }
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(windows)]
fn enhance_capabilities() -> EnhanceCapabilities {
    windows::capabilities()
}

#[cfg(not(windows))]
fn enhance_capabilities() -> EnhanceCapabilities {
    EnhanceCapabilities::none("Windows with an NVIDIA RTX card")
}

/// A picture dimension from an observed property, 0 once it is unavailable.
fn dimension(v: Option<Property>) -> u32 {
    match v {
        Some(Property::Double(d)) if d > 0.0 => d as u32,
        _ => 0,
    }
}

fn push_log(log: &Mutex<Vec<String>>, line: String) {
    let mut l = log.lock().unwrap();
    if l.len() < 500 {
        l.push(line);
    }
}
