use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bp_model::{BoxRun, Heads, decode_axis};
use bp_player::{Player, PlayerEvent};
use bp_script::{Action, Axis};
use bp_tracking::{Motion, Phase, Region, TrackOptions, Tracker};

use crate::detect::Detect;
use crate::lookahead::{WIDTH, bgra_to_gray, bgra_to_rgb, silent_player};
use crate::motion::{Cadence, MotionFeed, box_run};
use crate::{
    AutoRegion, RegionSource, Shared, is_local, next_auto_region, smoothing, track_component,
};


const WARMUP_MS: f64 = 3000.0;

pub const MODEL_TAIL_MS: f64 = 700.0;
const FRAME_WAIT: Duration = Duration::from_millis(100);
const LOAD_TIMEOUT: Duration = Duration::from_secs(60);

const QUIET_TIMEOUT: Duration = Duration::from_millis(1500);
const REPORT_EVERY: Duration = Duration::from_millis(200);

#[derive(Clone, Debug, PartialEq)]
pub enum RangeStatus {
    Idle,
    Running,
    Done,
    Cancelled,
    Error(String),
}

impl RangeStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            RangeStatus::Idle => "idle",
            RangeStatus::Running => "running",
            RangeStatus::Done => "done",
            RangeStatus::Cancelled => "cancelled",
            RangeStatus::Error(_) => "error",
        }
    }
}

#[derive(Clone, Debug)]
pub struct RangeProgress {
    pub status: RangeStatus,
    pub start_ms: f64,
    pub end_ms: f64,

    pub time_ms: f64,
}


pub struct State {
    pub progress: Mutex<RangeProgress>,
    pub cancel: AtomicBool,
}

impl State {
    pub fn new() -> State {
        State {
            progress: Mutex::new(RangeProgress {
                status: RangeStatus::Idle,
                start_ms: 0.0,
                end_ms: 0.0,
                time_ms: 0.0,
            }),
            cancel: AtomicBool::new(false),
        }
    }

    pub fn busy(&self) -> bool {
        self.progress.lock().unwrap().status == RangeStatus::Running
    }
}

#[derive(Clone, Debug)]
pub struct RangeOptions {
    pub start_ms: f64,
    pub end_ms: f64,


    pub region: Option<Region>,

    pub model: bool,

    pub hero: bool,

    pub thumbs_every_ms: Option<f64>,
    pub thumb_width: u32,
}


pub struct Thumb {
    pub time_ms: f64,
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

#[derive(Default)]
pub struct RangeResult {
    pub fps: f64,

    pub motion: Vec<(f64, Motion)>,
    pub cuts: Vec<f64>,

    pub boxes: Vec<(f64, Region)>,

    pub model: Vec<(Axis, Vec<Action>)>,

    pub hero: Vec<(Axis, Vec<Action>)>,
    pub thumbs: Vec<Thumb>,
}



pub(crate) struct Analyser {
    player: Player,
    path: String,
    loaded: Arc<AtomicBool>,
    ended: Arc<AtomicBool>,
    size: Arc<Mutex<(u32, u32)>>,
    fitted: (u32, u32),
    fps: f64,
    detect: Option<Detect>,
    detector_id: Option<&'static str>,
    auto_box: Arc<Mutex<AutoRegion>>,
    latest: Arc<Mutex<Option<BoxRun>>>,
}

impl Analyser {
    fn open(path: &str, hwdec: Option<String>) -> Result<Analyser, String> {
        let loaded = Arc::new(AtomicBool::new(false));
        let ended = Arc::new(AtomicBool::new(false));
        let size = Arc::new(Mutex::new((0u32, 0u32)));
        let sink: bp_player::EventSink = {
            let (loaded, ended, size) = (loaded.clone(), ended.clone(), size.clone());
            Arc::new(move |e| match e {
                PlayerEvent::VideoSize(w, h) => *size.lock().unwrap() = (w, h),
                PlayerEvent::FileLoaded => loaded.store(true, Ordering::Relaxed),
                PlayerEvent::EndFile { .. } => ended.store(true, Ordering::Relaxed),
                _ => {}
            })
        };

        let player = silent_player(path, hwdec, true, sink)?;
        player.load(path, None)?;
        Ok(Analyser {
            player,
            path: path.to_string(),
            loaded,
            ended,
            size,
            fitted: (0, 0),
            fps: 0.0,
            detect: None,
            detector_id: None,
            auto_box: Arc::new(Mutex::new(AutoRegion::default())),
            latest: Arc::new(Mutex::new(None)),
        })
    }


    fn wait_ready(&self, cancelled: &dyn Fn() -> bool) -> Result<(), String> {
        let began = Instant::now();
        loop {
            if cancelled() {
                return Err("cancelled".into());
            }
            if self.ended.load(Ordering::Relaxed) && !self.loaded.load(Ordering::Relaxed) {
                return Err("the file could not be opened".into());
            }
            let model_pending = self.detect.as_ref().is_some_and(|d| {
                !d.ready() && !matches!(d.snapshot().status, crate::DetectStatus::Error(_))
            });
            if self.loaded.load(Ordering::Relaxed) && !model_pending {
                return Ok(());
            }
            if began.elapsed() > LOAD_TIMEOUT {
                return Err(if self.loaded.load(Ordering::Relaxed) {
                    "the detector did not load".into()
                } else {
                    "the file did not open".into()
                });
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }


    fn fit(&mut self) -> Result<(), String> {
        let s = *self.size.lock().unwrap();
        if s != self.fitted && s.0 > 0 && s.1 > 0 {
            self.fitted = s;
            let h = ((WIDTH as f64 * s.1 as f64 / s.0 as f64 / 2.0).round() as u32 * 2).max(2);
            self.player.resize(WIDTH, h, None)?;
        }
        self.fps = self.player.video_fps();
        if !self.fps.is_finite() || self.fps <= 0.0 {
            return Err("the file has no video frame rate".into());
        }
        Ok(())
    }


    fn sync_detector(&mut self, shared: &Arc<Shared>) {
        let model = shared.detector_model.lock().unwrap().clone();
        let id = model.as_ref().map(|m| m.0.id);
        if id == self.detector_id {
            return;
        }
        self.detector_id = id;
        self.detect = None;
        self.detect = model.map(|m| {
            let d = Detect::start({
                let (auto_box, latest, shared) =
                    (self.auto_box.clone(), self.latest.clone(), shared.clone());
                move |v| {
                    let padding = shared.detect_options.lock().unwrap().padding;
                    let mut b = auto_box.lock().unwrap();
                    *b = next_auto_region(*b, v.found, v.after_cut, v.time_ms, padding);
                    *latest.lock().unwrap() = Some(box_run(&v));
                }
            });
            d.load(Some(m));
            d
        });
    }
}



#[derive(Clone)]
pub struct RangeAnalyser {
    shared: Arc<Shared>,
    hwdec: Option<String>,
}

impl RangeAnalyser {
    pub(crate) fn new(shared: Arc<Shared>, hwdec: Option<String>) -> RangeAnalyser {
        RangeAnalyser { shared, hwdec }
    }


    pub fn run(self, options: RangeOptions) -> Result<RangeResult, String> {
        {
            let mut p = self.shared.range.progress.lock().unwrap();
            p.start_ms = options.start_ms;
            p.end_ms = options.end_ms;
            p.time_ms = options.start_ms;
        }
        let result = self.decode(&options);
        let mut p = self.shared.range.progress.lock().unwrap();
        p.status = match &result {
            Ok(_) => RangeStatus::Done,
            Err(_) if self.shared.range.cancel.load(Ordering::Relaxed) => RangeStatus::Cancelled,
            Err(e) => RangeStatus::Error(e.clone()),
        };
        result
    }

    fn decode(&self, o: &RangeOptions) -> Result<RangeResult, String> {
        let shared = &self.shared;
        let path = shared
            .media_path
            .lock()
            .unwrap()
            .clone()
            .filter(|p| is_local(p))
            .ok_or("only a local file can be analysed")?;
        let cancelled = || shared.range.cancel.load(Ordering::Relaxed);
        let mut slot = shared.analyser.lock().unwrap();
        if slot.as_ref().is_none_or(|a| a.path != path) {
            *slot = None;
            *slot = Some(Analyser::open(&path, self.hwdec.clone())?);
        }
        let a = slot.as_mut().expect("opened above");
        let source = shared.region.lock().unwrap().source;

        if o.region.is_none() && source == RegionSource::Auto {
            a.sync_detector(shared);
        }
        a.wait_ready(&cancelled)?;
        a.fit()?;
        let fps = a.fps;
        let detect = a
            .detect
            .as_ref()
            .filter(|d| d.ready() && o.region.is_none() && source == RegionSource::Auto);
        let duration_ms = a.player.duration() * 1000.0;

        let axes = *shared.track_axes.lock().unwrap();
        let track_options = TrackOptions {
            smoothing_ms: smoothing(&axes),
            ..*shared.track_options.lock().unwrap()
        };
        let model = o.model.then(|| shared.motion_loaded()).flatten();
        let mut feed = model.map(|m| MotionFeed::new(m, track_options, Cadence::GENERATE));

        let mut watcher = o
            .hero
            .then(|| shared.hero.lock().unwrap().fresh())
            .filter(|h| h.zone.is_some());
        let tail = if feed.is_some() { MODEL_TAIL_MS } else { 0.0 };
        let end = if duration_ms > 0.0 {
            (o.end_ms + tail).min(duration_ms)
        } else {
            o.end_ms + tail
        };
        let from = (o.start_ms - WARMUP_MS).max(0.0);

        let mut tracker = Tracker::new(track_options);
        *a.auto_box.lock().unwrap() = AutoRegion::default();
        *a.latest.lock().unwrap() = None;
        a.player.seek(from / 1000.0)?;
        a.player.play()?;

        let step = (fps / 30.0 - 1e-6).ceil().max(1.0) as u64;
        let pace = shared.pace();
        let mut result = RangeResult {
            fps,
            ..Default::default()
        };
        let mut dense: Vec<Heads> = Vec::new();
        let mut last_head = f64::NEG_INFINITY;
        let mut expect_from = Some(from);
        let mut last_time: Option<f64> = None;
        let mut decoded = 0u64;
        let mut cuts_seen = tracker.cuts();
        let mut last_detect_ms = f64::NEG_INFINITY;
        let mut last_box: Option<Region> = None;
        let mut next_thumb = o.start_ms;
        let mut last_frame_at = Instant::now();
        let mut last_report = Instant::now();
        let mut gray = Vec::new();
        let mut rgb = Vec::new();

        loop {
            if cancelled() {
                let _ = a.player.pause();
                return Err("cancelled".into());
            }
            let Some(frame) = a.player.acquire_wait(FRAME_WAIT) else {
                if last_frame_at.elapsed() > QUIET_TIMEOUT {
                    break;
                }
                continue;
            };
            last_frame_at = Instant::now();

            let Some(pts) = frame.pts else { continue };
            let mut time = pts * 1000.0;

            if let Some(f) = expect_from {
                if time < f - 100.0 || time > f + 5000.0 {
                    continue;
                }
                expect_from = None;
            }
            if let Some(l) = last_time {
                if time <= l {
                    time = l + 1000.0 / fps;
                }
            }
            last_time = Some(time);
            let index = decoded;
            decoded += 1;
            if index % step != 0 {
                if time >= end {
                    break;
                }
                continue;
            }

            let slot = a.player.slot(frame.index);
            let bytes = unsafe { slot.as_slice() };
            let (w, h) = a.player.size();
            let (w, h) = (w as usize, h as usize);
            if bytes.len() < w * h * 4 {
                continue;
            }
            bgra_to_gray(bytes, w * h, &mut gray);
            let region = match o.region {
                Some(r) => Some(r),
                None => match source {
                    RegionSource::Auto if detect.is_some() => a.auto_box.lock().unwrap().region,
                    RegionSource::Auto => shared.region.lock().unwrap().auto.region,
                    RegionSource::Centre => None,
                    RegionSource::Pick(p) => Some(p),
                },
            };
            if region != tracker.region() {
                tracker.set_region(region);
            }
            let sample = tracker.push(&gray, w, h, time);
            let in_range = time >= o.start_ms && time <= o.end_ms;
            let cuts = tracker.cuts();
            let after_cut = cuts != cuts_seen;
            cuts_seen = cuts;
            if after_cut && in_range {
                result.cuts.push(time);
            }
            if in_range && tracker.phase() == Phase::Tracking {
                if let Some(s) = sample {
                    result.motion.push((s.time_ms, s.motion));
                }
            }
            if let Some(d) = detect {
                let interval = shared.detect_options.lock().unwrap().interval_ms;
                if after_cut || time - last_detect_ms >= interval {
                    last_detect_ms = time;
                    bgra_to_rgb(bytes, w * h, &mut rgb);
                    let floor = if after_cut {
                        None
                    } else {
                        a.auto_box.lock().unwrap().floor(time)
                    };
                    d.put(
                        &rgb,
                        w,
                        h,
                        after_cut,
                        shared.region.lock().unwrap().target,
                        floor,
                        time,
                    );
                }
                let current = a.auto_box.lock().unwrap().region;
                if let Some(r) = current {
                    if in_range && Some(r) != last_box {
                        result.boxes.push((time, r));
                    }
                }
                last_box = current;
            }
            if let Some(f) = feed.as_mut() {
                let detection = *a.latest.lock().unwrap();
                let heads = f.push(
                    &gray,
                    w,
                    h,
                    time,
                    &tracker,
                    sample,
                    detection.as_ref(),
                    time,
                    pace,
                )?;
                for h in heads {
                    if h.time_ms > last_head {
                        last_head = h.time_ms;
                        dense.push(h);
                    }
                }
            }
            if let Some(hw) = watcher.as_mut() {
                bgra_to_rgb(bytes, w * h, &mut rgb);
                hw.push(&rgb, w, h, time);
            }
            if let Some(every) = o.thumbs_every_ms.filter(|e| *e > 0.0) {
                if time >= next_thumb && in_range {
                    result.thumbs.push(thumb(bytes, w, h, o.thumb_width, time));
                    next_thumb = time + every;
                }
            }
            if last_report.elapsed() > REPORT_EVERY {
                last_report = Instant::now();
                shared.range.progress.lock().unwrap().time_ms = time;
            }
            if time >= end {
                break;
            }
        }
        let _ = a.player.pause();

        if let Some(f) = feed.as_mut() {
            if let Some(end) = dense
                .last()
                .map(|h| h.time_ms)
                .or(result.motion.last().map(|m| m.0))
            {
                f.flush(end, &mut |h| {
                    if h.time_ms > last_head {
                        last_head = h.time_ms;
                        dense.push(h);
                    }
                })?;
            }
            let meta = &f.loaded.meta;
            let time: Vec<f64> = dense.iter().map(|h| h.time_ms).collect();
            for axis in Axis::ALL {
                if track_component(axis).is_none() {
                    continue;
                }
                let Some(i) = meta.axes.iter().position(|id| id == axis.id()) else {
                    continue;
                };
                let column =
                    |g: fn(&Heads) -> [f64; 6]| dense.iter().map(|h| g(h)[i]).collect::<Vec<f64>>();
                let config = meta
                    .decode_config(pace)
                    .energised(axes[axis.index()].intensity);
                let actions: Vec<Action> = decode_axis(
                    &time,
                    &column(|h| h.pos),
                    &column(|h| h.trough),
                    &column(|h| h.peak),
                    Some(&column(|h| h.active)),
                    &config,
                )
                .into_iter()
                .filter(|a| a.at >= o.start_ms && a.at <= o.end_ms)
                .collect();
                if !actions.is_empty() {
                    result.model.push((axis, actions));
                }
            }
        }
        if let Some(hw) = watcher.as_ref() {
            for axis in Axis::ALL {
                if track_component(axis).is_none() {
                    continue;
                }
                let alternate =
                    matches!(axis, Axis::R0 | Axis::R1 | Axis::R2 | Axis::L1 | Axis::L2);
                let actions: Vec<Action> = hw
                    .script(axis, 1.0, false, alternate)
                    .actions
                    .into_iter()
                    .filter(|a| a.at >= o.start_ms && a.at <= o.end_ms)
                    .collect();
                if !actions.is_empty() {
                    result.hero.push((axis, actions));
                }
            }
        }
        Ok(result)
    }
}


fn thumb(bgra: &[u8], w: usize, h: usize, width: u32, time_ms: f64) -> Thumb {
    let tw = (width as usize).clamp(8, w.max(8));
    let th = (h * tw / w.max(1)).max(2);
    let mut rgb = Vec::with_capacity(tw * th * 3);
    for y in 0..th {
        let sy = (y * h / th).min(h.saturating_sub(1));
        for x in 0..tw {
            let sx = (x * w / tw).min(w.saturating_sub(1));
            let p = (sy * w + sx) * 4;
            rgb.extend_from_slice(&[bgra[p + 2], bgra[p + 1], bgra[p]]);
        }
    }
    Thumb {
        time_ms,
        width: tw as u32,
        height: th as u32,
        rgb,
    }
}
