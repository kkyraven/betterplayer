use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bp_model::BoxRun;
use bp_player::PlayerEvent;
use bp_tracking::{Sample, TrackOptions, Tracker};

use crate::detect::Detect;
use crate::lookahead::{bgra_to_gray, bgra_to_rgb, silent_player};
use crate::motion::box_run;
use crate::{AutoRegion, RegionSource, Shared, next_auto_region};


const FRAME_WAIT: Duration = Duration::from_millis(100);

const LOAD_TIMEOUT: Duration = Duration::from_secs(60);

const QUIET_TIMEOUT: Duration = Duration::from_secs(5);

const REPORT_EVERY: Duration = Duration::from_millis(200);


pub(crate) struct PassFrame<'a> {
    pub bgra: &'a [u8],
    pub gray: &'a [u8],
    pub width: usize,
    pub height: usize,
    pub time_ms: f64,
    pub tracker: &'a Tracker,
    pub sample: Option<Sample>,

    pub detection: Option<BoxRun>,
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct PassProgress {
    pub time_ms: f64,
    pub duration_ms: f64,
    pub frames: u64,

    pub fps: f64,
}

pub(crate) struct Pass<'a> {
    pub shared: &'a Arc<Shared>,
    pub path: &'a str,
    pub hwdec: Option<String>,

    pub color: bool,
    pub track_options: TrackOptions,
    pub cancelled: &'a dyn Fn() -> bool,
}

impl Pass<'_> {



    pub fn run(
        &self,
        on_loaded: &mut dyn FnMut(f64),
        on_progress: &mut dyn FnMut(PassProgress),
        on_frame: &mut dyn FnMut(PassFrame) -> Result<(), String>,
    ) -> Result<PassProgress, String> {
        let shared = self.shared;
        let duration = Arc::new(Mutex::new(0.0f64));
        let loaded = Arc::new(AtomicBool::new(false));
        let ended = Arc::new(AtomicBool::new(false));
        let sink: bp_player::EventSink = {
            let (duration, loaded, ended) = (duration.clone(), loaded.clone(), ended.clone());
            Arc::new(move |e| match e {
                PlayerEvent::Duration(d) => *duration.lock().unwrap() = d * 1000.0,
                PlayerEvent::FileLoaded => loaded.store(true, Ordering::Relaxed),
                PlayerEvent::EndFile { .. } => ended.store(true, Ordering::Relaxed),
                _ => {}
            })
        };
        let detector_model = (shared.region.lock().unwrap().source == RegionSource::Auto)
            .then(|| shared.detector_model.lock().unwrap().clone())
            .flatten();
        let player = silent_player(
            self.path,
            self.hwdec.clone(),
            self.color || detector_model.is_some(),
            sink,
        )?;
        player.load(self.path, None)?;



        let auto_box: Arc<Mutex<AutoRegion>> = Arc::new(Mutex::new(AutoRegion::default()));
        let latest: Arc<Mutex<Option<BoxRun>>> = Arc::new(Mutex::new(None));
        let detect = detector_model.map(|model| {
            let d = Detect::start({
                let (auto_box, latest, shared) = (auto_box.clone(), latest.clone(), shared.clone());
                move |v| {
                    let padding = shared.detect_options.lock().unwrap().padding;
                    let mut b = auto_box.lock().unwrap();
                    *b = next_auto_region(*b, v.found, v.after_cut, v.time_ms, padding);
                    *latest.lock().unwrap() = Some(box_run(&v));
                }
            });
            d.load(Some(model));
            d
        });



        let began = Instant::now();
        loop {
            if (self.cancelled)() {
                return Err("cancelled".into());
            }
            if ended.load(Ordering::Relaxed) && !loaded.load(Ordering::Relaxed) {
                return Err("the file could not be opened".into());
            }
            let model_pending = detect.as_ref().is_some_and(|d| {
                !d.ready() && !matches!(d.snapshot().status, crate::DetectStatus::Error(_))
            });
            if loaded.load(Ordering::Relaxed) && !model_pending {
                break;
            }
            if began.elapsed() > LOAD_TIMEOUT {
                return Err(if loaded.load(Ordering::Relaxed) {
                    "the detector did not load".into()
                } else {
                    "the file did not open".into()
                });
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let detect = detect.filter(|d| d.ready());
        let mut tracker = Tracker::new(self.track_options);
        on_loaded(*duration.lock().unwrap());
        let fps = player.video_fps();
        if !fps.is_finite() || fps <= 0.0 {
            return Err("the file has no video frame rate".into());
        }
        let step = (fps / 30.0 - 1e-6).ceil().max(1.0) as u64;
        let mut decoded = 0u64;
        player.play()?;

        let mut cuts_seen = 0;
        let mut last_detect_ms = f64::NEG_INFINITY;
        let mut progress = PassProgress::default();
        let mut last_frame_at = Instant::now();
        let mut last_report = Instant::now();
        let started = Instant::now();
        let mut gray = Vec::new();
        let mut rgb = Vec::new();

        loop {
            if (self.cancelled)() {
                return Err("cancelled".into());
            }
            let Some(frame) = player.acquire_wait(FRAME_WAIT) else {
                if ended.load(Ordering::Relaxed) || last_frame_at.elapsed() > QUIET_TIMEOUT {
                    break;
                }
                continue;
            };
            last_frame_at = Instant::now();

            if frame.pts.is_none() {
                continue;
            }


            let index = decoded;
            decoded += 1;
            if index % step != 0 {
                continue;
            }
            let time = index as f64 * 1000.0 / fps;

            let slot = player.slot(frame.index);
            let bytes = unsafe { slot.as_slice() };
            let (w, h) = player.size();
            let (w, h) = (w as usize, h as usize);
            if bytes.len() < w * h * 4 {
                continue;
            }
            progress.frames += 1;

            bgra_to_gray(bytes, w * h, &mut gray);
            let region = {
                let r = shared.region.lock().unwrap();
                match r.source {
                    RegionSource::Auto if detect.is_some() => auto_box.lock().unwrap().region,
                    RegionSource::Auto => r.auto.region,
                    RegionSource::Centre => None,
                    RegionSource::Pick(p) => Some(p),
                }
            };
            if region != tracker.region() {
                tracker.set_region(region);
            }
            let sample = tracker.push(&gray, w, h, time);
            if let Some(d) = detect.as_ref() {
                let interval = shared.detect_options.lock().unwrap().interval_ms;
                let cuts = tracker.cuts();
                let after_cut = cuts != cuts_seen;
                cuts_seen = cuts;
                if after_cut || time - last_detect_ms >= interval {
                    last_detect_ms = time;
                    bgra_to_rgb(bytes, w * h, &mut rgb);
                    let floor = if after_cut {
                        None
                    } else {
                        auto_box.lock().unwrap().floor(time)
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
            }
            let detection = detect.as_ref().and_then(|_| *latest.lock().unwrap());
            on_frame(PassFrame {
                bgra: bytes,
                gray: &gray,
                width: w,
                height: h,
                time_ms: time,
                tracker: &tracker,
                sample,
                detection,
            })?;

            progress.time_ms = time;
            progress.duration_ms = duration.lock().unwrap().max(time);
            progress.fps = progress.frames as f64 / started.elapsed().as_secs_f64().max(1e-3);
            if last_report.elapsed() > REPORT_EVERY {
                last_report = Instant::now();
                on_progress(progress);
            }
        }
        drop(detect);
        let _ = player.stop();
        on_progress(progress);
        Ok(progress)
    }
}
