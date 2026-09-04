//! Whole-file generation: a second, silent decode runs through the loaded local file at full
//! speed, the flow tracker, the detector and the Hero watcher see every frame, and the
//! tracking table turns what they found into one script per axis. Beat axes take the
//! analysed audio's script. Playback and the live tracker are not touched; the host waits
//! on `Generation::run` off its UI thread and polls the progress meanwhile.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bp_player::{Player, PlayerEvent};
use bp_script::{Action, Axis, Script};
use bp_tracking::{Motion, Phase, Region, TrackOptions, Tracker};

use crate::detect::Detect;
use crate::hero::HeroState;
use crate::lookahead::{WIDTH, bgra_to_gray, bgra_to_rgb, silent_options};
use crate::{RegionSource, Shared, TrackSource, next_auto_region, smoothing, track_component};

#[derive(Clone, Debug, PartialEq)]
pub enum GenerateStatus {
    Idle,
    /// Opening the file and, with a model on Auto, loading the detector.
    Loading,
    Running,
    Done,
    Cancelled,
    Error(String),
}

impl GenerateStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            GenerateStatus::Idle => "idle",
            GenerateStatus::Loading => "loading",
            GenerateStatus::Running => "running",
            GenerateStatus::Done => "done",
            GenerateStatus::Cancelled => "cancelled",
            GenerateStatus::Error(_) => "error",
        }
    }

    fn busy(&self) -> bool {
        matches!(self, GenerateStatus::Loading | GenerateStatus::Running)
    }
}

#[derive(Clone, Debug)]
pub struct GenerateProgress {
    pub status: GenerateStatus,
    /// Media time reached and the file's length.
    pub time_ms: f64,
    pub duration_ms: f64,
    /// Frames got through per wall second, once running.
    pub fps: f64,
    pub frames: u64,
    /// Hero hits seen so far.
    pub hits: u64,
}

impl GenerateProgress {
    pub fn idle() -> GenerateProgress {
        GenerateProgress { status: GenerateStatus::Idle, time_ms: 0.0, duration_ms: 0.0, fps: 0.0, frames: 0, hits: 0 }
    }
}

/// What the host polls and the cancel flag, kept on `Shared` so they outlive the run.
pub struct State {
    pub progress: Mutex<GenerateProgress>,
    pub cancel: AtomicBool,
}

impl State {
    pub fn new() -> State {
        State { progress: Mutex::new(GenerateProgress::idle()), cancel: AtomicBool::new(false) }
    }

    pub fn busy(&self) -> bool {
        self.progress.lock().unwrap().status.busy()
    }
}

/// A generation the host runs to completion with `run`. One at a time: `Shared::generate`
/// says Loading from the moment it is made.
pub struct Generation {
    shared: Arc<Shared>,
    state: Arc<State>,
    path: String,
    hwdec: Option<String>,
}

/// How long a frame is waited for before the loop looks at the flags again.
const FRAME_WAIT: Duration = Duration::from_millis(100);
/// Opening the file, and the detector's compile, are given this long.
const LOAD_TIMEOUT: Duration = Duration::from_secs(60);
/// A decode that has gone quiet this long without the end being reported is over.
const QUIET_TIMEOUT: Duration = Duration::from_secs(5);
/// Actions closer than this to the line between their neighbours are dropped, in 0..1.
const SIMPLIFY_EPS: f64 = 0.01;

impl Generation {
    pub(crate) fn new(shared: Arc<Shared>, state: Arc<State>, path: String, hwdec: Option<String>) -> Generation {
        state.cancel.store(false, Ordering::Relaxed);
        *state.progress.lock().unwrap() = GenerateProgress { status: GenerateStatus::Loading, ..GenerateProgress::idle() };
        Generation { shared, state, path, hwdec }
    }

    /// Runs the whole file through and builds the scripts, on the calling thread. The
    /// progress ends in Done, Cancelled or Error, whichever way this returns.
    pub fn run(self) -> Result<Vec<(Axis, Script)>, String> {
        let result = self.decode_and_build();
        let mut p = self.state.progress.lock().unwrap();
        p.status = match &result {
            Ok(_) => GenerateStatus::Done,
            Err(_) if self.state.cancel.load(Ordering::Relaxed) => GenerateStatus::Cancelled,
            Err(e) => GenerateStatus::Error(e.clone()),
        };
        result
    }

    fn cancelled(&self) -> bool {
        self.state.cancel.load(Ordering::Relaxed)
    }

    fn decode_and_build(&self) -> Result<Vec<(Axis, Script)>, String> {
        let shared = &self.shared;
        let axes = *shared.track_axes.lock().unwrap();
        let wants_video = Axis::ALL.iter().any(|a| axes[a.index()].source == TrackSource::Video && track_component(*a).is_some());
        let wants_hero = axes.iter().any(|a| a.source == TrackSource::Hero);
        // The Hero watcher's own copy: the live one must not see frames from another time.
        let mut hero = wants_hero.then(|| shared.hero.lock().unwrap().fresh()).filter(|h| h.zone.is_some());
        let mut motion: Vec<(f64, Motion)> = Vec::new();
        // Beat alone needs no frames: its scripts come from the analysed audio.
        if wants_video || hero.is_some() {
            self.decode(&mut motion, hero.as_mut())?;
        } else {
            self.state.progress.lock().unwrap().status = GenerateStatus::Running;
        }
        Ok(self.build(&axes, &motion, hero.as_ref()))
    }

    /// Runs every frame of the file through the tracker, the detector and the Hero watcher.
    fn decode(&self, motion: &mut Vec<(f64, Motion)>, mut hero: Option<&mut HeroState>) -> Result<(), String> {
        let shared = &self.shared;
        let axes = *shared.track_axes.lock().unwrap();
        let wants_video = Axis::ALL.iter().any(|a| axes[a.index()].source == TrackSource::Video && track_component(*a).is_some());

        let size = Arc::new(Mutex::new((0u32, 0u32)));
        let duration = Arc::new(Mutex::new(0.0f64));
        let loaded = Arc::new(AtomicBool::new(false));
        let ended = Arc::new(AtomicBool::new(false));
        let sink: bp_player::EventSink = {
            let (size, duration, loaded, ended) = (size.clone(), duration.clone(), loaded.clone(), ended.clone());
            Arc::new(move |e| match e {
                PlayerEvent::VideoSize(w, h) => *size.lock().unwrap() = (w, h),
                PlayerEvent::Duration(d) => *duration.lock().unwrap() = d * 1000.0,
                PlayerEvent::FileLoaded => loaded.store(true, Ordering::Relaxed),
                PlayerEvent::EndFile { .. } => ended.store(true, Ordering::Relaxed),
                _ => {}
            })
        };
        let player = Player::new(WIDTH, WIDTH * 9 / 16, silent_options(self.hwdec.clone()), Some(sink))?;
        player.load(&self.path, None)?;

        // The detector runs its own copy of the model when the region is Auto.
        let auto_box: Arc<Mutex<(Option<Region>, Option<bp_detect::Target>)>> = Arc::new(Mutex::new((None, None)));
        let detect = (shared.region.lock().unwrap().source == RegionSource::Auto)
            .then(|| shared.detector_model.lock().unwrap().clone())
            .flatten()
            .map(|model| {
                let d = Detect::start({
                    let (auto_box, shared) = (auto_box.clone(), shared.clone());
                    move |found, after_cut| {
                        let padding = shared.detect_options.lock().unwrap().padding;
                        let mut b = auto_box.lock().unwrap();
                        *b = next_auto_region(b.0, b.1, found, after_cut, padding);
                    }
                });
                d.load(Some(model));
                d
            });

        // Nothing can be asked of mpv before the file is in, and a model still compiling would
        // miss the opening scenes.
        let began = Instant::now();
        loop {
            if self.cancelled() {
                return Err("cancelled".into());
            }
            if ended.load(Ordering::Relaxed) && !loaded.load(Ordering::Relaxed) {
                return Err("the file could not be opened".into());
            }
            let model_pending = detect.as_ref().is_some_and(|d| !d.ready() && !matches!(d.snapshot().status, crate::DetectStatus::Error(_)));
            if loaded.load(Ordering::Relaxed) && !model_pending {
                break;
            }
            if began.elapsed() > LOAD_TIMEOUT {
                return Err(if loaded.load(Ordering::Relaxed) { "the detector did not load".into() } else { "the file did not open".into() });
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let detect = detect.filter(|d| d.ready());
        let track_options = TrackOptions { smoothing_ms: smoothing(&axes), ..*shared.track_options.lock().unwrap() };
        let mut tracker = Tracker::new(track_options);
        {
            let mut p = self.state.progress.lock().unwrap();
            p.status = GenerateStatus::Running;
            p.duration_ms = *duration.lock().unwrap();
        }
        player.play()?;

        let mut fitted = (0u32, 0u32);
        let mut fps = 0.0;
        let mut last_time: Option<f64> = None;
        let mut cuts_seen = 0;
        let mut last_detect_ms = f64::NEG_INFINITY;
        let mut frames: u64 = 0;
        let mut last_frame_at = Instant::now();
        let mut last_report = Instant::now();
        let started = Instant::now();
        let mut gray = Vec::new();
        let mut rgb = Vec::new();

        loop {
            if self.cancelled() {
                return Err("cancelled".into());
            }
            // The output takes the picture's shape once known, so regions mean the same here as
            // on screen.
            let s = *size.lock().unwrap();
            if s != fitted && s.0 > 0 && s.1 > 0 {
                fitted = s;
                let h = ((WIDTH as f64 * s.1 as f64 / s.0 as f64 / 2.0).round() as u32 * 2).max(2);
                player.resize(WIDTH, h, None)?;
                fps = player.video_fps();
            }
            let Some(frame) = player.acquire_wait(FRAME_WAIT) else {
                if ended.load(Ordering::Relaxed) || last_frame_at.elapsed() > QUIET_TIMEOUT {
                    break;
                }
                continue;
            };
            last_frame_at = Instant::now();
            // Redraws (a resize) carry no position; only decoded frames do.
            let Some(pts) = frame.pts else { continue };
            let mut time = pts * 1000.0;
            // The position is read before each frame is drawn and can repeat when it has not
            // advanced yet; a repeat is the next frame.
            if let Some(l) = last_time {
                if time <= l {
                    time = l + if fps > 0.0 { 1000.0 / fps } else { 1000.0 / 30.0 };
                }
            }
            last_time = Some(time);

            let slot = player.slot(frame.index);
            let bytes = unsafe { slot.as_slice() };
            let (w, h) = player.size();
            let (w, h) = (w as usize, h as usize);
            if bytes.len() < w * h * 4 {
                continue;
            }
            frames += 1;

            if wants_video || detect.is_some() {
                bgra_to_gray(bytes, w * h, &mut gray);
                let region = {
                    let r = shared.region.lock().unwrap();
                    match r.source {
                        RegionSource::Auto if detect.is_some() => auto_box.lock().unwrap().0,
                        RegionSource::Auto => r.auto,
                        RegionSource::Centre => None,
                        RegionSource::Pick(p) => Some(p),
                    }
                };
                if region != tracker.region() {
                    tracker.set_region(region);
                }
                let sample = tracker.push(&gray, w, h, time);
                if tracker.phase() == Phase::Tracking {
                    if let Some(s) = sample {
                        motion.push((s.time_ms, s.motion));
                    }
                }
            }
            if let Some(d) = detect.as_ref() {
                let interval = shared.detect_options.lock().unwrap().interval_ms;
                let cuts = tracker.cuts();
                let after_cut = cuts != cuts_seen;
                cuts_seen = cuts;
                if after_cut || time - last_detect_ms >= interval {
                    last_detect_ms = time;
                    bgra_to_rgb(bytes, w * h, &mut rgb);
                    d.put(&rgb, w, h, after_cut, shared.region.lock().unwrap().target);
                }
            }
            if let Some(watcher) = hero.as_mut() {
                bgra_to_rgb(bytes, w * h, &mut rgb);
                watcher.push(&rgb, w, h, time);
            }

            if last_report.elapsed() > Duration::from_millis(200) {
                last_report = Instant::now();
                let mut p = self.state.progress.lock().unwrap();
                p.time_ms = time;
                p.duration_ms = duration.lock().unwrap().max(time);
                p.frames = frames;
                p.fps = frames as f64 / started.elapsed().as_secs_f64().max(1e-3);
                p.hits = hero.as_deref().map_or(0, |h| h.snapshot().hits);
            }
        }
        drop(detect);
        let _ = player.stop();
        Ok(())
    }

    /// One script per axis on the table. Beat needs the analysed audio; without it the
    /// axis is left out, which the host can see coming from `beat_state`.
    fn build(&self, axes: &crate::TrackAxes, motion: &[(f64, Motion)], hero: Option<&HeroState>) -> Vec<(Axis, Script)> {
        let beat = self.shared.beat.lock().unwrap();
        let mut scripts = Vec::new();
        for axis in Axis::ALL {
            let a = axes[axis.index()];
            let alternate = matches!(axis, Axis::R0 | Axis::R1 | Axis::R2 | Axis::L1 | Axis::L2);
            let script = match a.source {
                TrackSource::Video => track_component(axis).map(|c| {
                    let actions: Vec<Action> = motion.iter().map(|(at, m)| Action { at: *at, pos: a.map(m[c.index()]) }).collect();
                    Script { actions: simplify(&actions, SIMPLIFY_EPS), ..Script::default() }
                }),
                TrackSource::Beat => beat.script(a.intensity, a.invert, alternate).map(|mut s| {
                    for action in &mut s.actions {
                        action.pos = a.limit(action.pos);
                    }
                    s
                }),
                TrackSource::Hero => hero.map(|h| {
                    let mut s = h.script(axis, a.intensity, a.invert, alternate);
                    for action in &mut s.actions {
                        action.pos = a.limit(action.pos);
                    }
                    s
                }),
                TrackSource::Off => None,
            };
            if let Some(s) = script.filter(|s| !s.actions.is_empty()) {
                scripts.push((axis, s));
            }
        }
        scripts
    }
}

/// Ramer-Douglas-Peucker on a time series: a point within `eps` of the line between the
/// kept points either side of it is dropped. Frame-rate samples become keyframes.
fn simplify(actions: &[Action], eps: f64) -> Vec<Action> {
    if actions.len() < 3 {
        return actions.to_vec();
    }
    let mut keep = vec![false; actions.len()];
    keep[0] = true;
    keep[actions.len() - 1] = true;
    let mut stack = vec![(0usize, actions.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let (pa, pb) = (actions[a], actions[b]);
        let span = pb.at - pa.at;
        let mut worst = (0.0f64, a);
        for i in a + 1..b {
            let p = actions[i];
            let u = if span > 0.0 { (p.at - pa.at) / span } else { 0.0 };
            let on_line = pa.pos + (pb.pos - pa.pos) * u;
            let d = (p.pos - on_line).abs();
            if d > worst.0 {
                worst = (d, i);
            }
        }
        if worst.0 > eps {
            keep[worst.1] = true;
            stack.push((a, worst.1));
            stack.push((worst.1, b));
        }
    }
    actions.iter().zip(keep).filter(|(_, k)| *k).map(|(a, _)| *a).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(at: f64, pos: f64) -> Action {
        Action { at, pos }
    }

    #[test]
    fn simplify_keeps_the_turns_and_drops_the_straights() {
        let ramp: Vec<Action> = (0..=10).map(|i| a(i as f64 * 100.0, i as f64 / 10.0)).collect();
        assert_eq!(simplify(&ramp, 0.01), vec![a(0.0, 0.0), a(1000.0, 1.0)]);
        let tri = vec![a(0.0, 0.0), a(100.0, 0.5), a(200.0, 1.0), a(300.0, 0.5), a(400.0, 0.0)];
        assert_eq!(simplify(&tri, 0.01), vec![a(0.0, 0.0), a(200.0, 1.0), a(400.0, 0.0)]);
        let wobble = vec![a(0.0, 0.0), a(100.0, 0.505), a(200.0, 1.0)];
        assert_eq!(simplify(&wobble, 0.01).len(), 2, "a wobble under the tolerance is noise");
    }
}
