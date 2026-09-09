//! libmpv player that renders offscreen and hands BGRA frames to the host, and reports
//! clock events (time, pause, speed, seeks) to an optional sink.

mod enhance;
mod frames;
mod gl_context;
mod mpv;
mod render;
mod stats;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub use enhance::{DlssOptions, DlssRate, EnhanceCapabilities, EnhanceOptions, EnhanceState, GuideQuality, ModelPreset, NrPreset, NrStyle, Upscaler};
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
    VideoFps(f64),
}

pub type EventSink = Arc<dyn Fn(PlayerEvent) + Send + Sync>;

/// Decoder metadata before mpv guesses a color matrix from the frame dimensions.
pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    pub color_matrix: String,
}

/// Inspect a local file without a render context, so analysis can choose its output size and
/// conversion before the first frame. The null output also avoids a render/core wait cycle.
pub fn probe_video(path: &str) -> Result<VideoInfo, String> {
    let mpv = Mpv::create()?;
    for (key, value) in [("vo", "null"), ("aid", "no"), ("sid", "no"), ("pause", "yes"), ("idle", "yes")] {
        mpv.set_option(key, value)?;
    }
    mpv.initialize()?;
    load_file(&mpv, path, None)?;
    let started = std::time::Instant::now();
    loop {
        match mpv.wait_event(0.1) {
            Event::FileLoaded | Event::PlaybackRestart => {
                let width = mpv.get_double("video-dec-params/w").unwrap_or(0.0) as u32;
                let height = mpv.get_double("video-dec-params/h").unwrap_or(0.0) as u32;
                if width == 0 || height == 0 { continue; }
                return Ok(VideoInfo { width, height, color_matrix: mpv.get_string("video-dec-params/colormatrix").unwrap_or_else(|| "auto".into()) });
            }
            Event::EndFile { error } => return Err(error.unwrap_or_else(|| "the file has no video".into())),
            _ => {}
        }
        if started.elapsed() > Duration::from_secs(60) { return Err("the file did not open".into()); }
    }
}

pub struct PlayerOptions {
    /// mpv `hwdec` value. Defaults to the platform's zero-copy decoder.
    pub hwdec: Option<String>,
    /// Collect mpv log lines at "v" instead of "warn".
    pub verbose: bool,
    /// Frame bytes come out as BGRA instead of RGBA.
    pub bgra: bool,
    /// Fenced readback: published as soon as the GPU has copied, without blocking the render thread.
    pub async_readback: bool,
    /// Each decoded frame carries the latest observed position (`Acquired::pts`).
    pub stamp_frames: bool,
    /// No frame is replaced unread: the render thread waits for the reader, which paces an
    /// untimed decode to it. For a reader on its own thread, never the on-screen player.
    pub hold_frames: bool,
    /// Extra mpv options applied before init, for experiments like `scale=bilinear`.
    pub mpv_options: Vec<(String, String)>,
}

impl Default for PlayerOptions {
    fn default() -> PlayerOptions {
        // ANGLE has no packed BGRA read type: `GL_BGRA` with plain bytes is swizzled on the CPU
        // inside `glReadPixels`, three to six times the cost of an RGBA read (28 ms against 8 ms
        // at 1440p, 90 ms against 15 ms at 4K on an RTX 4090). Windows reads RGBA and the host's
        // shader and tracker feed swizzle instead, cued by `Player::bgra()`.
        PlayerOptions { hwdec: None, verbose: false, bgra: !cfg!(windows), async_readback: true, stamp_frames: false, hold_frames: false, mpv_options: Vec::new() }
    }
}

pub struct Player {
    mpv: Arc<Mpv>,
    /// Restore the configured extractor after loading a direct media URL.
    ytdl: String,
    frames: Arc<Frames>,
    stats: Arc<RenderStats>,
    log: Arc<Mutex<Vec<String>>>,
    tx: Option<Sender<Msg>>,
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
    /// The `ytdl` option as configured, put back after a library server stream turned it off.
    ytdl: String,
}

impl MediaLoader {
    /// Same as `Player::load`. `remote` is set for a library server's stream: its HTTP headers
    /// (`Field: value`, comma separated, empty for none), which mpv sends with every request.
    /// Such a stream is a plain file URL, so the yt-dlp hook stays out of its way; any other
    /// URL gets the hook back as configured.
    pub fn load(&self, path: &str, start_seconds: Option<f64>, remote: Option<&str>) -> Result<(), String> {
        self.mpv.set_property("http-header-fields", remote.unwrap_or(""))?;
        // Best effort: a build whose hook ignores the runtime value still plays the stream.
        let _ = self.mpv.set_property("ytdl", if remote.is_some() { "no" } else { &self.ytdl });
        load_file(&self.mpv, path, start_seconds)
    }

    pub fn hwdec_current(&self) -> String {
        self.mpv.get_string("hwdec-current").unwrap_or_default()
    }
}

fn load_file(mpv: &Mpv, path: &str, start_seconds: Option<f64>) -> Result<(), String> {
    match start_seconds {
        Some(s) if s > 0.0 => {
            let start = format!("start={s}");
            // mpv 0.38 added the playlist index before per-file options. Ubuntu 24.04
            // ships 0.37, whose loadfile command still expects options in position four.
            if unsafe { mpv::mpv_client_api_version() } < (2 << 16 | 3) {
                mpv.command(&["loadfile", path, "replace", &start])
            } else {
                mpv.command(&["loadfile", path, "replace", "-1", &start])
            }
        },
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
        frames::frame_len(width, height)?;
        let mpv = Mpv::create()?;
        mpv.set_option("vo", "libmpv")?;
        mpv.set_option("hwdec", opts.hwdec.as_deref().unwrap_or(default_hwdec()))?;
        mpv.set_option("idle", "yes")?;
        mpv.set_option("keep-open", "yes")?;
        mpv.set_option("pause", "yes")?;
        #[cfg(target_os = "linux")]
        for scaler in ["scale", "cscale", "dscale"] {
            mpv.set_option(scaler, enhance::DEFAULT_SCALE)?;
        }
        for (k, v) in &opts.mpv_options {
            mpv.set_option(k, v)?;
        }
        mpv.request_log(if opts.verbose { "v" } else { "warn" })?;
        mpv.initialize()?;
        let ytdl = mpv.get_string("ytdl").unwrap_or_else(|| "no".into());
        mpv.observe("time-pos", mpv::MPV_FORMAT_DOUBLE)?;
        mpv.observe("duration", mpv::MPV_FORMAT_DOUBLE)?;
        mpv.observe("pause", mpv::MPV_FORMAT_FLAG)?;
        mpv.observe("core-idle", mpv::MPV_FORMAT_FLAG)?;
        mpv.observe("speed", mpv::MPV_FORMAT_DOUBLE)?;
        mpv.observe("video-params/w", mpv::MPV_FORMAT_DOUBLE)?;
        mpv.observe("video-params/h", mpv::MPV_FORMAT_DOUBLE)?;
        mpv.observe("container-fps", mpv::MPV_FORMAT_DOUBLE)?;
        let mpv = Arc::new(mpv);

        let log = Arc::new(Mutex::new(Vec::new()));
        let stop_events = Arc::new(AtomicBool::new(false));
        let enhance = Arc::new(Mutex::new(Enhance::new(enhance_capabilities(), (width, height))));
        let has_video = Arc::new(AtomicBool::new(false));
        // The render thread's sender, filled in once it exists, so the events thread can ask
        // for a redraw when the picture comes back.
        let picture_back: Arc<Mutex<Option<Sender<Msg>>>> = Arc::new(Mutex::new(None));
        let events = {
            let mpv = mpv.clone();
            let log = log.clone();
            let stop = stop_events.clone();
            let enhance = enhance.clone();
            let has_video = has_video.clone();
            let picture_back = picture_back.clone();
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
                                ("time-pos", Some(Property::Double(t))) => {
                                    mpv.observed_time.store(t.to_bits(), Ordering::Relaxed);
                                    emit(PlayerEvent::TimePos(t));
                                }
                                ("duration", Some(Property::Double(d))) => emit(PlayerEvent::Duration(d)),
                                ("pause", Some(Property::Flag(p))) => emit(PlayerEvent::Pause(p)),
                                ("core-idle", Some(Property::Flag(i))) => emit(PlayerEvent::Idle(i)),
                                ("speed", Some(Property::Double(s))) => emit(PlayerEvent::Speed(s)),
                                ("container-fps", value) => emit(PlayerEvent::VideoFps(match value {
                                    Some(Property::Double(fps)) => fps,
                                    _ => 0.0,
                                })),
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
                                        if size.0 == 0 {
                                            mpv.picture_ready.store(false, Ordering::Relaxed);
                                        }
                                        if size.0 > 0 {
                                            if let Some(tx) = picture_back.lock().unwrap().as_ref() {
                                                let _ = tx.send(Msg::PictureBack);
                                            }
                                        }
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
        let (tx, render, context) = match render::spawn(
            mpv.clone(),
            frames.clone(),
            stats.clone(),
            cfg,
            has_video.clone(),
            #[cfg(target_os = "macos")]
            enhance.lock().unwrap().apple(),
            #[cfg(windows)]
            enhance.lock().unwrap().dlss(),
        ) {
            Ok(r) => r,
            Err(e) => {
                // No context (no ANGLE on Windows, say): the events thread holds the core, so it
                // stops here or the core, its thread and the host's sink live on with no Player.
                stop_events.store(true, Ordering::Relaxed);
                let _ = events.join();
                return Err(e);
            }
        };
        #[cfg(target_os = "linux")]
        enhance.lock().unwrap().set_gpu(context.clone());
        push_log(&log, format!("render context: {context}"));
        *picture_back.lock().unwrap() = Some(tx.clone());

        Ok(Player {
            mpv,
            ytdl,
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
        MediaLoader { mpv: self.mpv.clone(), ytdl: self.ytdl.clone() }
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

    /// Seeks to the exact time rather than the nearest keyframe, for frame-accurate editing.
    pub fn seek_exact(&self, seconds: f64) -> Result<(), String> {
        self.mpv.command(&["seek", &seconds.to_string(), "absolute+exact"])
    }

    /// Steps one frame forward or back; mpv leaves the player paused after the step.
    pub fn frame_step(&self, forward: bool) -> Result<(), String> {
        self.mpv.command(&[if forward { "frame-step" } else { "frame-back-step" }])
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
        frames::validate_size(width, height, external)?;
        let tx = self.tx.as_ref().ok_or("player closed")?;
        let done = Arc::new(render::ResizeReply::default());
        tx.send(Msg::Resize(width, height, external, done.clone())).map_err(|_| "render thread gone".to_string())?;
        done.wait(Duration::from_secs(2))?;
        // The slots have changed. An enhancement failure cannot turn this into a failed
        // resize: the host must retain the new buffers and release the old ones.
        if let Err(e) = self.enhance.lock().unwrap().set_output(&self.mpv, (width, height)) {
            push_log(&self.log, format!("enhance after resize: {e}"));
        }
        #[cfg(any(target_os = "macos", windows))]
        let _ = tx.send(Msg::Redraw);
        Ok(())
    }

    /// What this machine can do for upscaling and frame generation, probed at start.
    pub fn enhance_capabilities(&self) -> EnhanceCapabilities {
        self.enhance.lock().unwrap().capabilities()
    }

    /// Applies upscaling and frame generation to the current video, no reload. Options this
    /// machine cannot honour are kept but left inert; `enhance_state` says why.
    pub fn set_enhance(&self, options: EnhanceOptions) -> Result<(), String> {
        self.enhance.lock().unwrap().set_options(&self.mpv, options)?;
        #[cfg(any(target_os = "macos", windows))]
        if let Some(tx) = &self.tx {
            tx.send(Msg::Redraw).map_err(|_| "render thread gone".to_string())?;
        }
        Ok(())
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

#[cfg(target_os = "macos")]
fn enhance_capabilities() -> EnhanceCapabilities {
    macos::capabilities()
}

#[cfg(not(any(windows, target_os = "macos")))]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_load_restores_extractor_after_direct_stream() {
        for configured in ["yes", "no"] {
            let player = Player::new(2, 2, PlayerOptions {
                mpv_options: vec![("ytdl".into(), configured.into())],
                ..PlayerOptions::default()
            }, None).unwrap();
            player.media_loader().load("memory://direct", None, Some("")).unwrap();
            assert_eq!(player.mpv.get_string("ytdl").as_deref(), Some("no"));
            player.media_loader().load("memory://page", None, None).unwrap();
            assert_eq!(player.mpv.get_string("ytdl").as_deref(), Some(configured));
        }
    }
}
