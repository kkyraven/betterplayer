//! AI Motion in the engine: a feed that turns each frame into the movement model's row, runs
//! the window on a cadence and hands back the frames it scored. One feed per consumer: the
//! live worker (causal, every 4 frames), the lookahead (16 frames of future, every 8) and a
//! generation (`predict.py`'s own alignment: hop 64, scored 64..128). The whole-frame flow grid
//! is a second tracker with the full frame as its region, beside the region tracker the feed
//! is handed after its push, exactly as `spike/dump-features.mjs` builds the training rows.

use std::sync::Arc;

use bp_model::{
    ActiveGate, BoxRun, FUTURE, FrameInput, Heads, Loaded, MOVEMENT_WIDTH, Movement, PAST,
    SCORE_START, Smoother, WINDOW, movement_row, trim_step,
};
use bp_script::Axis;
use bp_tracking::{Motion, Region, Sample, TrackOptions, Tracker};

use crate::detect::Verdict;
use crate::track_component;

/// A detector verdict as the feature row reads it: the box, its kind's index in
/// `bp_detect::Kind::ALL` (none for a covered class), the confidence and this run's coverage.
pub(crate) fn box_run(v: &Verdict) -> BoxRun {
    BoxRun {
        time_ms: v.time_ms,
        rect: v.found.map(|f| {
            [
                f.rect.x as f32,
                f.rect.y as f32,
                f.rect.w as f32,
                f.rect.h as f32,
            ]
        }),
        kind: v
            .found
            .and_then(|f| bp_detect::Kind::ALL.iter().position(|k| k.matches(f.class))),
        confidence: v.found.map_or(0.0, |f| f.confidence),
        coverage: std::array::from_fn(|i| v.coverage[i] as f32),
    }
}

/// How often a feed runs the window, how much future the present has, and after how many rows
/// the first run happens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Cadence {
    pub hop: usize,
    pub future: usize,
    pub first_run: usize,
}

impl Cadence {
    /// Every 4 frames, no future: 0.6 ms a frame and 130 ms of added latency.
    pub const LIVE: Cadence = Cadence {
        hop: 4,
        future: 0,
        first_run: 4,
    };
    /// The lookahead is ahead of the playhead, so it hops by 8 and reads 8.
    pub const LOOKAHEAD: Cadence = Cadence {
        hop: 8,
        future: FUTURE,
        first_run: 8,
    };
    /// `predict.py`: windows hop by the scored width, the first starting 64 frames before the
    /// title, so every frame is scored once with the same context it had in evaluation.
    pub const GENERATE: Cadence = Cadence {
        hop: PAST - SCORE_START,
        future: FUTURE,
        first_run: PAST + FUTURE - (PAST - SCORE_START),
    };
}

pub(crate) struct MotionFeed {
    pub loaded: Arc<Loaded>,
    frame: Tracker,
    runner: Movement,
    cadence: Cadence,
    row: Vec<f32>,
    smoothers: [Smoother; 6],
    /// The depth trim's running centre per head, `decoder::dense_signal` one frame at a time.
    centres: [Smoother; 6],
    gates: [ActiveGate; 6],
    /// Head index to motion component index, from the metadata's axis order.
    components: [Option<usize>; 6],
    /// The region tracker's last motion, held across frames that produced none.
    chain: Motion,
    cuts_seen: u64,
    last_time: Option<f64>,
    interval_ms: f64,
    /// The last run's cost.
    pub run_ms: f64,
}

impl MotionFeed {
    pub fn new(loaded: Arc<Loaded>, options: TrackOptions, cadence: Cadence) -> MotionFeed {
        let mut frame = Tracker::new(options);
        frame.set_region(Some(Region {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        }));
        let components = std::array::from_fn(|i| {
            loaded
                .meta
                .axes
                .get(i)
                .and_then(|id| Axis::from_id(id))
                .and_then(track_component)
                .map(|c| c.index())
        });
        let runner = Movement::new(loaded.session.clone(), loaded.meta.clone());
        MotionFeed {
            loaded,
            frame,
            runner,
            cadence,
            row: vec![0.0; MOVEMENT_WIDTH],
            smoothers: Default::default(),
            centres: Default::default(),
            gates: Default::default(),
            components,
            chain: [0.5; 6],
            cuts_seen: 0,
            last_time: None,
            interval_ms: 1000.0 / 30.0,
            run_ms: 0.0,
        }
    }

    /// Whether this feed runs the given model.
    pub fn same(&self, loaded: &Arc<Loaded>) -> bool {
        Arc::ptr_eq(&self.loaded, loaded)
    }

    pub fn set_options(&mut self, options: TrackOptions) {
        if options != self.frame.options() {
            self.frame.set_options(options);
        }
    }

    /// The measured frame interval, for spacing live samples.
    pub fn interval_ms(&self) -> f64 {
        self.interval_ms
    }

    /// One frame after the region tracker has seen it. `detection` and `now_ms` share a clock;
    /// `time_ms` is the frame's media time. Returns the frames this push scored, oldest first,
    /// or nothing between hops.
    #[allow(clippy::too_many_arguments)]
    pub fn push(
        &mut self,
        gray: &[u8],
        width: usize,
        height: usize,
        time_ms: f64,
        region: &Tracker,
        sample: Option<Sample>,
        detection: Option<&BoxRun>,
        now_ms: f64,
        pace: f64,
    ) -> Result<Vec<Heads>, String> {
        self.frame.push(gray, width, height, time_ms);
        if let Some(s) = sample {
            self.chain = s.motion;
        }
        let cuts = region.cuts();
        let cut = cuts != self.cuts_seen;
        self.cuts_seen = cuts;
        let interval_ms = match self.last_time {
            Some(t) => time_ms - t,
            None => self.interval_ms,
        };
        if interval_ms > 0.0 {
            self.interval_ms = interval_ms;
        }
        self.last_time = Some(time_ms);
        let r = region.region().unwrap_or_default();
        let input = FrameInput {
            frame_field: self.frame.field(),
            region_field: region.field(),
            region: [r.x as f32, r.y as f32, r.w as f32, r.h as f32],
            chain: self.chain,
            signals: region.signals(),
            cut,
            interval_ms,
            detection,
            now_ms,
            pace: pace as f32,
        };
        movement_row(&input, &mut self.row);
        self.runner.ring.push(&self.row, time_ms);
        self.run_if_due()
    }

    fn run_if_due(&mut self) -> Result<Vec<Heads>, String> {
        let pushed = self.runner.ring.pushed() as usize;
        let c = self.cadence;
        if pushed < c.first_run || (pushed - c.first_run) % c.hop != 0 {
            return Ok(Vec::new());
        }
        let out = self.runner.run(c.future, PAST - c.hop, PAST)?;
        self.run_ms = self.runner.run_ms();
        Ok(out)
    }

    /// The end of a file: the last frame repeated until every real frame has been scored, as
    /// `predict.py`'s clipped index does. `sink` sees frames in order and may see the last
    /// frame's time more than once.
    pub fn flush(&mut self, time_ms: f64, sink: &mut impl FnMut(Heads)) -> Result<(), String> {
        for _ in 0..WINDOW {
            self.runner.ring.push_repeat(time_ms);
            for h in self.run_if_due()? {
                sink(h);
            }
        }
        Ok(())
    }

    /// A scored frame as the live path plays it: the smoothed position per motion component,
    /// NaN where the gate has released the axis or the model has no head for it.
    ///
    /// `energy` is the rows' Intensity per motion component: it scales the smoothing and the
    /// gate through `DecodeConfig::energised`, and nothing else.
    pub fn live(&mut self, h: &Heads, pace: f64, energy: &[f64; 6]) -> Motion {
        let base = self.loaded.meta.decode_config(pace);
        let mut out = [f64::NAN; 6];
        for i in 0..6 {
            let Some(c) = self.components[i] else {
                continue;
            };
            let config = base.energised(energy[c]);
            let centre = self.centres[i].push(h.time_ms, h.pos[i], config.centre_tau_ms);
            let trimmed = trim_step(centre, h.pos[i], config.amplitude);
            let pos = self.smoothers[i].push(h.time_ms, trimmed, config.tau_ms);
            out[c] = if self.gates[i].push(h.time_ms, h.active[i], &config) {
                pos
            } else {
                f64::NAN
            };
        }
        out
    }
}
