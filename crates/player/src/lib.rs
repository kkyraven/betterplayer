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


#[derive(Clone, Debug, PartialEq)]
pub enum PlayerEvent {
    FileLoaded,

    EndFile { error: Option<String> },
    Seek,
    PlaybackRestart,
    TimePos(f64),
    Duration(f64),
    Pause(bool),


    Idle(bool),
    Speed(f64),

    VideoSize(u32, u32),
}

pub type EventSink = Arc<dyn Fn(PlayerEvent) + Send + Sync>;


pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    pub color_matrix: String,
}



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

    pub hwdec: Option<String>,

    pub verbose: bool,

    pub bgra: bool,

    pub async_readback: bool,

    pub stamp_frames: bool,


    pub hold_frames: bool,

    pub mpv_options: Vec<(String, String)>,
}

impl Default for PlayerOptions {
    fn default() -> PlayerOptions {




        PlayerOptions { hwdec: None, verbose: false, bgra: !cfg!(windows), async_readback: true, stamp_frames: false, hold_frames: false, mpv_options: Vec::new() }
    }
}

pub struct Player {
    mpv: Arc<Mpv>,
    frames: Arc<Frames>,
    stats: Arc<RenderStats>,
    log: Arc<Mutex<Vec<String>>>,

    tx: Option<Box<Sender<Msg>>>,
    render: Option<JoinHandle<()>>,
    events: Option<JoinHandle<()>>,
    stop_events: Arc<AtomicBool>,
    bgra: bool,

    enhance: Arc<Mutex<Enhance>>,


    has_video: Arc<AtomicBool>,
}



#[derive(Clone)]
pub struct MediaLoader {
    mpv: Arc<Mpv>,

    ytdl: String,
}

impl MediaLoader {




    pub fn load(&self, path: &str, start_seconds: Option<f64>, remote: Option<&str>) -> Result<(), String> {
        self.mpv.set_property("http-header-fields", remote.unwrap_or(""))?;

        let _ = self.mpv.set_property("ytdl", if remote.is_some() { "no" } else { &self.ytdl });
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
                                (name @ ("video-params/w" | "video-params/h"), v) => {
                                    let this = dimension(v);
                                    let other = if name == "video-params/w" { "video-params/h" } else { "video-params/w" };
                                    let other = mpv.get_double(other).map_or(0, |d| if d > 0.0 { d as u32 } else { 0 });
                                    let next = if name == "video-params/w" { (this, other) } else { (other, this) };

                                    let next = if next.0 > 0 && next.1 > 0 { next } else { (0, 0) };
                                    if next != size {
                                        size = next;
                                        has_video.store(size.0 > 0, Ordering::Relaxed);
                                        emit(PlayerEvent::VideoSize(size.0, size.1));

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


                stop_events.store(true, Ordering::Relaxed);
                let _ = events.join();
                return Err(e);
            }
        };
        push_log(&log, format!("render context: {context}"));

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



    pub fn load(&self, path: &str, start_seconds: Option<f64>) -> Result<(), String> {
        load_file(&self.mpv, path, start_seconds)
    }


    pub fn media_loader(&self) -> MediaLoader {
        MediaLoader { mpv: self.mpv.clone(), ytdl: self.mpv.get_string("ytdl").unwrap_or_else(|| "no".into()) }
    }


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


    pub fn stop(&self) -> Result<(), String> {
        self.mpv.command(&["stop"])
    }

    pub fn set_rate(&self, rate: f64) -> Result<(), String> {
        self.mpv.set_property("speed", &rate.clamp(0.1, 4.0).to_string())
    }

    pub fn rate(&self) -> f64 {
        self.mpv.get_double("speed").unwrap_or(1.0)
    }


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


    pub fn set_hwdec(&self, value: &str) -> Result<(), String> {
        self.mpv.set_property("hwdec", value)
    }

    pub fn hwdec_current(&self) -> String {
        self.mpv.get_string("hwdec-current").unwrap_or_default()
    }



    pub fn video_size(&self) -> (u32, u32) {
        let w = self.mpv.get_double("video-params/w").unwrap_or(0.0) as u32;
        let h = self.mpv.get_double("video-params/h").unwrap_or(0.0) as u32;
        (w, h)
    }



    pub fn set_presenting(&self, on: bool) -> Result<(), String> {
        let tx = self.tx.as_ref().ok_or("player closed")?;
        tx.send(Msg::Presenting(on)).map_err(|_| "render thread gone".to_string())
    }




    pub fn resize(&self, width: u32, height: u32, external: Option<External>) -> Result<(), String> {
        let tx = self.tx.as_ref().ok_or("player closed")?;
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        tx.send(Msg::Resize(width, height, external, done_tx)).map_err(|_| "render thread gone".to_string())?;
        done_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "resize timed out".to_string())?;
        self.enhance.lock().unwrap().set_output(&self.mpv, (width, height))?;
        #[cfg(any(target_os = "macos", windows))]
        tx.send(Msg::Redraw).map_err(|_| "render thread gone".to_string())?;
        Ok(())
    }


    pub fn enhance_capabilities(&self) -> EnhanceCapabilities {
        self.enhance.lock().unwrap().capabilities()
    }



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


    pub fn enhance_state(&self) -> EnhanceState {
        self.enhance.lock().unwrap().state()
    }

    pub fn size(&self) -> (u32, u32) {
        self.frames.size()
    }

    pub fn bgra(&self) -> bool {
        self.bgra
    }


    pub fn acquire(&self) -> Option<usize> {
        let a = self.frames.acquire()?;
        self.stats.acquired(a.waited);
        Some(a.index)
    }



    pub fn acquire_wait(&self, timeout: Duration) -> Option<Acquired> {
        let a = self.frames.acquire_wait(timeout)?;
        self.stats.acquired(a.waited);
        Some(a)
    }


    pub fn slot(&self, index: usize) -> Arc<FrameSlot> {
        self.frames.slot(index)
    }

    pub fn stats(&self) -> RenderSnapshot {
        self.stats.snapshot()
    }

    pub fn take_log(&self) -> Vec<String> {
        std::mem::take(&mut *self.log.lock().unwrap())
    }


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
