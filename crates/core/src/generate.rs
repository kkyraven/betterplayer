use std::cell::Cell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bp_model::{Heads, decode_axis};
use bp_script::{Action, Axis, Script, simplify};
use bp_tracking::{Motion, Phase, TrackOptions};

use crate::beat::MusicStatus;
use crate::hero::HeroState;
use crate::lookahead::bgra_to_rgb;
use crate::motion::{Cadence, MotionFeed};
use crate::pass::{Pass, PassProgress};
use crate::{Shared, TrackSource, smoothing, track_component};

#[derive(Clone, Debug, PartialEq)]
pub enum GenerateStatus {
    Idle,

    Loading,
    Running,

    Music,
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
            GenerateStatus::Music => "music",
            GenerateStatus::Done => "done",
            GenerateStatus::Cancelled => "cancelled",
            GenerateStatus::Error(_) => "error",
        }
    }

    fn busy(&self) -> bool {
        matches!(
            self,
            GenerateStatus::Loading | GenerateStatus::Running | GenerateStatus::Music
        )
    }
}

#[derive(Clone, Debug)]
pub struct GenerateProgress {
    pub status: GenerateStatus,

    pub time_ms: f64,
    pub duration_ms: f64,

    pub fps: f64,
    pub frames: u64,

    pub hits: u64,

    pub provider: Option<&'static str>,
    pub model_ms: f64,
}

impl GenerateProgress {
    pub fn idle() -> GenerateProgress {
        GenerateProgress {
            status: GenerateStatus::Idle,
            time_ms: 0.0,
            duration_ms: 0.0,
            fps: 0.0,
            frames: 0,
            hits: 0,
            provider: None,
            model_ms: 0.0,
        }
    }
}


pub struct State {
    pub progress: Mutex<GenerateProgress>,
    pub cancel: AtomicBool,
}

impl State {
    pub fn new() -> State {
        State {
            progress: Mutex::new(GenerateProgress::idle()),
            cancel: AtomicBool::new(false),
        }
    }

    pub fn busy(&self) -> bool {
        self.progress.lock().unwrap().status.busy()
    }
}



pub struct Generation {
    shared: Arc<Shared>,
    state: Arc<State>,
    path: String,
    hwdec: Option<String>,
}


const SIMPLIFY_EPS: f64 = 0.01;


#[derive(Default)]
struct Collected {
    motion: Vec<(f64, Motion)>,

    dense: Vec<Heads>,
}

impl Generation {
    pub(crate) fn new(
        shared: Arc<Shared>,
        state: Arc<State>,
        path: String,
        hwdec: Option<String>,
    ) -> Generation {
        state.cancel.store(false, Ordering::Relaxed);
        *state.progress.lock().unwrap() = GenerateProgress {
            status: GenerateStatus::Loading,
            ..GenerateProgress::idle()
        };
        Generation {
            shared,
            state,
            path,
            hwdec,
        }
    }



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
        let on = |source: TrackSource| {
            Axis::ALL
                .iter()
                .any(|a| axes[a.index()].source == source && track_component(*a).is_some())
        };
        let wants_video = on(TrackSource::Video);
        let wants_hero = axes.iter().any(|a| a.source == TrackSource::Hero);

        let mut hero = wants_hero
            .then(|| shared.hero.lock().unwrap().fresh())
            .filter(|h| h.zone.is_some());
        let model = on(TrackSource::AiMotion)
            .then(|| shared.motion_loaded())
            .flatten();

        let wants_video = wants_video || (on(TrackSource::AiMotion) && model.is_none());
        let mut collected = Collected::default();

        if wants_video || hero.is_some() || model.is_some() {
            self.decode(&mut collected, hero.as_mut(), model)?;
        } else {
            self.state.progress.lock().unwrap().status = GenerateStatus::Running;
        }
        if on(TrackSource::AiMusic) {
            self.wait_for_music()?;
        }
        Ok(self.build(&axes, &collected, hero.as_ref()))
    }



    fn decode(
        &self,
        collected: &mut Collected,
        mut hero: Option<&mut HeroState>,
        model: Option<Arc<bp_model::Loaded>>,
    ) -> Result<(), String> {
        let shared = &self.shared;
        let axes = *shared.track_axes.lock().unwrap();
        let track_options = TrackOptions {
            smoothing_ms: smoothing(&axes),
            ..*shared.track_options.lock().unwrap()
        };
        let mut feed = model.map(|m| MotionFeed::new(m, track_options, Cadence::GENERATE));
        let pace = shared.pace();
        let provider = feed
            .as_ref()
            .map(|f| f.loaded.session.lock().unwrap().provider);
        let mut rgb = Vec::new();
        let mut last_time = f64::NEG_INFINITY;
        let cancelled = || self.cancelled();
        let pass = Pass {
            shared,
            path: &self.path,
            hwdec: self.hwdec.clone(),
            color: hero.is_some(),
            track_options,
            cancelled: &cancelled,
        };

        let hits = Cell::new(0u64);
        let model_ms = Cell::new(0.0f64);
        let mut report = |p: PassProgress| {
            let mut s = self.state.progress.lock().unwrap();
            s.time_ms = p.time_ms;
            s.duration_ms = p.duration_ms;
            s.frames = p.frames;
            s.fps = p.fps;
            s.hits = hits.get();
            s.provider = provider;
            s.model_ms = model_ms.get();
        };
        pass.run(
            &mut |duration_ms| {
                let mut p = self.state.progress.lock().unwrap();
                p.status = GenerateStatus::Running;
                p.duration_ms = duration_ms;
            },
            &mut report,
            &mut |f| {
                if f.tracker.phase() == Phase::Tracking {
                    if let Some(s) = f.sample {
                        collected.motion.push((s.time_ms, s.motion));
                    }
                }
                if let Some(feed) = feed.as_mut() {
                    let before = feed.run_ms;
                    let heads = feed.push(
                        f.gray,
                        f.width,
                        f.height,
                        f.time_ms,
                        f.tracker,
                        f.sample,
                        f.detection.as_ref(),
                        f.time_ms,
                        pace,
                    )?;
                    if feed.run_ms != before || !heads.is_empty() {
                        model_ms.set(model_ms.get() + feed.run_ms);
                    }
                    for h in heads {
                        if h.time_ms > last_time {
                            last_time = h.time_ms;
                            collected.dense.push(h);
                        }
                    }
                }
                if let Some(watcher) = hero.as_mut() {
                    bgra_to_rgb(f.bgra, f.width * f.height, &mut rgb);
                    watcher.push(&rgb, f.width, f.height, f.time_ms);
                    hits.set(watcher.snapshot().hits);
                }
                Ok(())
            },
        )?;
        if let Some(feed) = feed.as_mut() {
            if let Some(end) = collected
                .motion
                .last()
                .map(|m| m.0)
                .or(collected.dense.last().map(|h| h.time_ms))
            {
                feed.flush(end, &mut |h| {
                    if h.time_ms > last_time {
                        last_time = h.time_ms;
                        collected.dense.push(h);
                    }
                })?;
            }
        }
        Ok(())
    }



    fn wait_for_music(&self) -> Result<(), String> {
        self.shared.ensure_music();
        loop {
            if self.cancelled() {
                return Err("cancelled".into());
            }
            let status = self.shared.beat.lock().unwrap().music.clone();
            match status {
                MusicStatus::Watching { .. } | MusicStatus::Modelling => {
                    self.state.progress.lock().unwrap().status = GenerateStatus::Music;
                }
                MusicStatus::None | MusicStatus::Ready | MusicStatus::Error(_) => return Ok(()),
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }




    fn build(
        &self,
        axes: &crate::TrackAxes,
        collected: &Collected,
        hero: Option<&HeroState>,
    ) -> Vec<(Axis, Script)> {
        let beat = self.shared.beat.lock().unwrap();
        let model = self.shared.motion_loaded();
        let pace = self.shared.pace();
        let mut scripts = Vec::new();
        for axis in Axis::ALL {
            let a = axes[axis.index()];
            let alternate = matches!(axis, Axis::R0 | Axis::R1 | Axis::R2 | Axis::L1 | Axis::L2);
            let from_flow = || {
                track_component(axis).map(|c| {
                    let actions: Vec<Action> = collected
                        .motion
                        .iter()
                        .map(|(at, m)| Action {
                            at: *at,
                            pos: a.map(m[c.index()]),
                        })
                        .collect();
                    Script {
                        actions: simplify(&actions, SIMPLIFY_EPS),
                        ..Script::default()
                    }
                })
            };
            let script = match a.source {
                TrackSource::Video => from_flow(),
                TrackSource::AiMotion => match (&model, track_component(axis)) {
                    (Some(m), Some(_)) => {
                        m.meta.axes.iter().position(|id| id == axis.id()).map(|i| {
                            let time: Vec<f64> =
                                collected.dense.iter().map(|h| h.time_ms).collect();
                            let column = |f: fn(&Heads) -> [f64; 6]| {
                                collected
                                    .dense
                                    .iter()
                                    .map(|h| f(h)[i])
                                    .collect::<Vec<f64>>()
                            };
                            let mut actions = decode_axis(
                                &time,
                                &column(|h| h.pos),
                                &column(|h| h.trough),
                                &column(|h| h.peak),
                                Some(&column(|h| h.active)),
                                &m.meta.decode_config(pace).energised(a.intensity),
                            );
                            for action in &mut actions {
                                action.pos = a.map(action.pos);
                            }
                            Script {
                                actions,
                                ..Script::default()
                            }
                        })
                    }
                    (None, Some(_)) => from_flow(),
                    _ => None,
                },
                TrackSource::Beat => beat.script(1.0, a.invert, alternate).map(|mut s| {
                    for action in &mut s.actions {
                        action.pos = a.limit(action.pos);
                    }
                    s
                }),
                TrackSource::AiMusic => beat.music_script(axis).map(|mut s| {
                    for action in &mut s.actions {
                        action.pos = a.map(action.pos);
                    }
                    s
                }),
                TrackSource::Hero => hero.map(|h| {
                    let mut s = h.script(axis, 1.0, a.invert, alternate);
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
