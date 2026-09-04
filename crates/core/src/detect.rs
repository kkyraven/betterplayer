//! The region detector's home in the engine: a thread that owns the loaded model, takes the
//! newest RGB frame the tracker hands it, and reports the box the tracker should follow.
//! Loading happens on the thread too, so a slow first CoreML compile never blocks the host.

use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use bp_detect::{Detector, Kind, ModelSpec};

/// How much of each run's coverage replaces the last: half, so a flicker in one run does
/// not swing a parameter.
const COVERAGE_EMA: f64 = 0.5;

/// What the detector is doing, for the bar and Settings.
#[derive(Clone, Debug, PartialEq)]
pub enum DetectStatus {
    /// No model chosen.
    None,
    Loading,
    Ready,
    Error(String),
}

/// The box chosen from the last run, in 0..1 of the frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Found {
    pub rect: bp_detect::Rect,
    pub class: &'static str,
    pub confidence: f32,
}

#[derive(Clone, Debug)]
pub struct DetectSnapshot {
    pub status: DetectStatus,
    pub model: Option<&'static str>,
    /// `coreml` or `cpu` once loaded.
    pub provider: Option<&'static str>,
    /// The last run's chosen box, `None` when it found nothing worth following.
    pub found: Option<Found>,
    /// How long the last run took.
    pub run_ms: f64,
    pub runs: u64,
    /// Share of the frame each `Kind` covers, smoothed across runs.
    pub coverage: [f64; Kind::COUNT],
}

impl DetectSnapshot {
    pub fn empty() -> DetectSnapshot {
        DetectSnapshot { status: DetectStatus::None, model: None, provider: None, found: None, run_ms: 0.0, runs: 0, coverage: [0.0; Kind::COUNT] }
    }
}

#[derive(Default)]
struct Slot {
    frame: Option<Frame>,
    load: Option<Option<(&'static ModelSpec, PathBuf, Option<PathBuf>)>>,
    stop: bool,
}

struct Frame {
    rgb: Vec<u8>,
    width: usize,
    height: usize,
    /// The frame followed a scene cut, so a miss means "nothing here", not "still there".
    after_cut: bool,
    /// The kind to follow, or `None` for the rule (genitals, else a face).
    target: Option<Kind>,
}

struct Inner {
    slot: Mutex<Slot>,
    ready: Condvar,
    state: Mutex<DetectSnapshot>,
}

/// A running detector thread. `on_result` gets every run's choice, with whether the frame
/// followed a cut.
pub struct Detect {
    inner: Arc<Inner>,
    thread: Option<JoinHandle<()>>,
}

impl Detect {
    pub fn start(on_result: impl Fn(Option<Found>, bool) + Send + 'static) -> Detect {
        let inner = Arc::new(Inner {
            slot: Mutex::new(Slot::default()),
            ready: Condvar::new(),
            state: Mutex::new(DetectSnapshot::empty()),
        });
        let thread = {
            let inner = inner.clone();
            std::thread::Builder::new()
                .name("bp-detect".into())
                .spawn(move || {
                    let mut detector: Option<Detector> = None;
                    loop {
                        let (load, frame) = {
                            let mut slot = inner.slot.lock().unwrap();
                            while slot.frame.is_none() && slot.load.is_none() && !slot.stop {
                                slot = inner.ready.wait(slot).unwrap();
                            }
                            if slot.stop {
                                return;
                            }
                            (slot.load.take(), slot.frame.take())
                        };
                        if let Some(load) = load {
                            detector = None;
                            match load {
                                None => {
                                    let mut s = inner.state.lock().unwrap();
                                    *s = DetectSnapshot::empty();
                                }
                                Some((spec, path, cache)) => match Detector::load(spec, &path, cache.as_deref()) {
                                    Ok(d) => {
                                        let mut s = inner.state.lock().unwrap();
                                        s.status = DetectStatus::Ready;
                                        s.provider = Some(d.provider());
                                        s.model = Some(spec.id);
                                        detector = Some(d);
                                    }
                                    Err(e) => {
                                        let mut s = inner.state.lock().unwrap();
                                        s.status = DetectStatus::Error(e);
                                        s.provider = None;
                                    }
                                },
                            }
                        }
                        let (Some(d), Some(f)) = (detector.as_mut(), frame) else { continue };
                        let t0 = Instant::now();
                        let dets = d.detect(&f.rgb, f.width, f.height).unwrap_or_default();
                        let found = bp_detect::choose(&dets, f.target).map(|c| Found { rect: c.rect, class: c.class, confidence: c.confidence });
                        let coverage = bp_detect::coverage(&dets);
                        {
                            let mut s = inner.state.lock().unwrap();
                            s.found = found;
                            s.run_ms = t0.elapsed().as_secs_f64() * 1000.0;
                            s.runs += 1;
                            for (c, new) in s.coverage.iter_mut().zip(coverage) {
                                *c = if f.after_cut { new } else { *c + (new - *c) * COVERAGE_EMA };
                            }
                        }
                        on_result(found, f.after_cut);
                    }
                })
                .ok()
        };
        Detect { inner, thread }
    }

    /// Loads a model (or unloads with `None`) on the thread. Status goes to Loading at once.
    pub fn load(&self, model: Option<(&'static ModelSpec, PathBuf, Option<PathBuf>)>) {
        {
            let mut s = self.inner.state.lock().unwrap();
            s.status = if model.is_some() { DetectStatus::Loading } else { DetectStatus::None };
            s.model = model.as_ref().map(|m| m.0.id);
            s.provider = None;
            s.found = None;
            s.coverage = [0.0; Kind::COUNT];
        }
        let mut slot = self.inner.slot.lock().unwrap();
        slot.load = Some(model);
        slot.frame = None;
        drop(slot);
        self.inner.ready.notify_one();
    }

    pub fn ready(&self) -> bool {
        self.inner.state.lock().unwrap().status == DetectStatus::Ready
    }

    /// Hands over a packed RGB frame; one that arrives before the last was taken replaces it.
    /// `target` is the kind to follow in it, or `None` for the rule.
    pub fn put(&self, rgb: &[u8], width: usize, height: usize, after_cut: bool, target: Option<Kind>) {
        let mut slot = self.inner.slot.lock().unwrap();
        if slot.stop {
            return;
        }
        // A cut's frame must not be overwritten by an ordinary one before it runs.
        let after_cut = after_cut || slot.frame.as_ref().is_some_and(|f| f.after_cut);
        slot.frame = Some(Frame { rgb: rgb.to_vec(), width, height, after_cut, target });
        drop(slot);
        self.inner.ready.notify_one();
    }

    pub fn snapshot(&self) -> DetectSnapshot {
        self.inner.state.lock().unwrap().clone()
    }

    /// The smoothed coverage per kind, `None` until a model is ready.
    pub fn coverage(&self) -> Option<[f64; Kind::COUNT]> {
        let s = self.inner.state.lock().unwrap();
        (s.status == DetectStatus::Ready).then_some(s.coverage)
    }
}

impl Drop for Detect {
    fn drop(&mut self) {
        self.inner.slot.lock().unwrap().stop = true;
        self.inner.ready.notify_all();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
