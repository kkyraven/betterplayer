//! Per-axis processing pipeline, run once per output tick (PLAN §4, research 01):
//! script sample, amplitude and invert, motion provider and gap fill, auto-home, range,
//! sync ramp, smart limit, speed limit. Pure: the caller supplies time and dt. A fallback
//! per axis (a fixed value or a provider) stands in where the script has no keyframe, which
//! is how restim's carrier and pulse parameters get a source without a script.

mod provider;
mod settings;

use std::sync::Arc;

use bp_script::{Action, Axis, Interpolation, Script, expand, interp};

pub use provider::Provider;
pub use settings::{AxisSettings, SmartLimit};

/// What an axis plays where its script has no keyframe and nothing external drives it.
#[derive(Clone, Debug, PartialEq, Default)]
pub enum Fallback {
    #[default]
    None,
    Value(f64),
    Provider(Provider),
}

impl Fallback {
    fn value(&self, st: &mut provider::State, dt_ms: f64) -> Option<f64> {
        match self {
            Fallback::None => None,
            Fallback::Value(v) => Some(*v),
            Fallback::Provider(p) => p.value(st, dt_ms),
        }
    }
}

/// Values for every axis after the pipeline, 0..1 in device units.
pub type Frame = [f64; Axis::COUNT];

/// One axis's running state between ticks.
#[derive(Default)]
struct AxisState {
    /// Last value handed out, the origin of ramps and the base of the speed limit.
    last: f64,
    /// ms since the script and provider last had a value; drives auto-home.
    idle_ms: f64,
    /// Value auto-home started easing from.
    home_from: f64,
    provider: provider::State,
    fallback: provider::State,
    /// Sync ramp: where it started, how far along it is and how long it runs.
    ramp_from: f64,
    ramp_ms: f64,
    ramp_len_ms: f64,
    /// An onset ramp (an external source starting) eases over its whole length; a sync ramp
    /// closes in exponentially.
    ramp_onset: bool,
    colour_speed_limited: bool,
}

/// An external source (the live tracker, a remote client) that starts driving an axis moves
/// it from where it rests to the first value over this long.
pub const ONSET_MS: f64 = 1000.0;

/// One slot per axis, with alpha and beta derived from the stroke and the electrode flags
/// worked out, for a set of loaded scripts. Building it resamples the whole stroke when
/// alpha and beta are derived, so a host on a tick thread builds it outside the mixer lock
/// and swaps it in with `Mixer::install`.
pub struct ScriptTable {
    /// Scripts as loaded, before any derivation.
    loaded: Vec<(Axis, Arc<Script>)>,
    scripts: [Option<Arc<Script>>; Axis::COUNT],
    derived: [bool; Axis::COUNT],
    expand_stroke: bool,
    electrodes: bool,
}

impl ScriptTable {
    /// `expand_stroke` derives alpha and beta from the stroke when no alpha or beta script
    /// exists, and electrodes 1 to 4 from those unless the media ships its own.
    pub fn build(loaded: Vec<(Axis, Arc<Script>)>, expand_stroke: bool) -> ScriptTable {
        let mut scripts: [Option<Arc<Script>>; Axis::COUNT] = std::array::from_fn(|_| None);
        let mut derived = [false; Axis::COUNT];
        for (axis, script) in &loaded {
            scripts[axis.index()] = Some(script.clone());
        }
        let has = |a: Axis| scripts[a.index()].is_some();
        if expand_stroke && has(Axis::L0) && !has(Axis::EA) && !has(Axis::EB) {
            let (alpha, beta) = expand::stroke_to_alpha_beta(scripts[Axis::L0.index()].as_ref().unwrap());
            scripts[Axis::EA.index()] = Some(Arc::new(alpha));
            scripts[Axis::EB.index()] = Some(Arc::new(beta));
            derived[Axis::EA.index()] = true;
            derived[Axis::EB.index()] = true;
        }
        let electrodes = expand_stroke && !ELECTRODES.iter().any(|a| scripts[a.index()].is_some());
        for a in ELECTRODES {
            derived[a.index()] = electrodes;
        }
        ScriptTable { loaded, scripts, derived, expand_stroke, electrodes }
    }
}

/// A temporary script-time and depth override, before the normal output limits.
#[derive(Clone, Copy, Debug)]
pub struct ScriptEffect {
    pub stroke_speed: Option<f64>,
    pub start_ms: f64,
    pub end_ms: f64,
    pub tempo: f64,
    pub intensity: f64,
    pub min: f64,
    pub max: f64,
}

pub struct Mixer {
    effects: [Option<ScriptEffect>; Axis::COUNT],
    /// A temporary output ceiling per axis over the settings' `max` (a zone raising the vibration).
    max_override: [Option<f64>; Axis::COUNT],
    scripts: [Option<Arc<Script>>; Axis::COUNT],
    /// Each script's lowest and highest position, for `extend_range`; measured once at install.
    extents: [Option<(f64, f64)>; Axis::COUNT],
    /// Scripts as loaded, before any derivation.
    loaded: Vec<(Axis, Arc<Script>)>,
    /// Axes whose value is derived from another: alpha and beta from the stroke, the
    /// electrodes from alpha and beta.
    derived: [bool; Axis::COUNT],
    /// Derive alpha and beta from the stroke script when no alpha/beta scripts exist.
    expand_stroke: bool,
    /// Derive electrodes 1 to 4 from alpha and beta every tick: on with `expand_stroke`
    /// unless the media ships its own `.e1`..`.e4` scripts.
    electrodes: bool,
    /// Relative balance of the derived electrodes (`expand::contrast`), 0..1. Scripted
    /// electrodes play as written.
    electrode_contrast: f64,
    settings: [AxisSettings; Axis::COUNT],
    external: [Option<f64>; Axis::COUNT],
    fallback: [Fallback; Axis::COUNT],
    live: [Option<f64>; Axis::COUNT],
    state: [AxisState; Axis::COUNT],
    /// Axes a script, provider or live value drove on the last tick.
    driven: [bool; Axis::COUNT],
    /// Half-circle state for alpha and beta derived from a live (external) stroke.
    live_orbit: Orbit,
    pub global_offset_ms: f64,
    /// Sync ramp length after a reset (media change, seek, play, pause, connect).
    pub sync_ms: f64,
    last_values: Frame,
}

impl Default for Mixer {
    fn default() -> Mixer {
        Mixer::new()
    }
}

impl Mixer {
    pub fn new() -> Mixer {
        let mut m = Mixer {
            effects: [None; Axis::COUNT],
            max_override: [None; Axis::COUNT],
            scripts: std::array::from_fn(|_| None),
            extents: [None; Axis::COUNT],
            loaded: Vec::new(),
            derived: [false; Axis::COUNT],
            expand_stroke: false,
            electrodes: false,
            electrode_contrast: 0.0,
            settings: std::array::from_fn(|i| AxisSettings::default_for(Axis::ALL[i])),
            external: [None; Axis::COUNT],
            fallback: std::array::from_fn(|_| Fallback::None),
            live: [None; Axis::COUNT],
            state: std::array::from_fn(|_| AxisState::default()),
            driven: [false; Axis::COUNT],
            live_orbit: Orbit::default(),
            global_offset_ms: 0.0,
            sync_ms: 4000.0,
            last_values: [0.0; Axis::COUNT],
        };
        for a in Axis::ALL {
            let s = &mut m.state[a.index()];
            s.last = a.default_value();
            s.home_from = s.last;
            s.ramp_len_ms = m.sync_ms;
        }
        m.last_values = std::array::from_fn(|i| m.state[i].last);
        m
    }

    pub fn set_script_effect(&mut self, axis: Axis, effect: Option<ScriptEffect>) {
        self.effects[axis.index()] = effect;
    }

    /// Puts the axis's output ceiling at `max` (clamped to its range) until `None`.
    pub fn set_max_override(&mut self, axis: Axis, max: Option<f64>) {
        self.max_override[axis.index()] = max;
    }

    /// Loads scripts and starts the sync ramp. Builds the table in place; a host that must
    /// not hold the mixer for long builds a `ScriptTable` first and calls `install`.
    pub fn set_scripts(&mut self, scripts: impl IntoIterator<Item = (Axis, Script)>) {
        let loaded = scripts.into_iter().map(|(a, s)| (a, Arc::new(s))).collect();
        self.install(ScriptTable::build(loaded, self.expand_stroke));
        self.resync();
    }

    /// Swaps a prebuilt table in. No resync: the caller decides.
    pub fn install(&mut self, table: ScriptTable) {
        let ScriptTable { loaded, scripts, derived, expand_stroke, electrodes } = table;
        self.loaded = loaded;
        self.extents = std::array::from_fn(|i| scripts[i].as_ref().and_then(|s| s.extent()));
        self.scripts = scripts;
        self.derived = derived;
        self.expand_stroke = expand_stroke;
        self.electrodes = electrodes;
        if !electrodes {
            for a in ELECTRODES {
                self.external[a.index()] = None;
            }
        }
    }

    /// The scripts as loaded, for rebuilding the table with another `expand_stroke`.
    pub fn loaded(&self) -> &[(Axis, Arc<Script>)] {
        &self.loaded
    }

    pub fn expand_stroke(&self) -> bool {
        self.expand_stroke
    }

    /// Replaces one axis's script without a resync, for a script that grows while it plays
    /// (the Hero source adds keyframes as notes approach). A slot swap, except that a new
    /// stroke re-derives alpha and beta when they come from it.
    pub fn set_script_live(&mut self, axis: Axis, script: Option<Arc<Script>>) {
        self.loaded.retain(|(a, _)| *a != axis);
        if let Some(s) = &script {
            self.loaded.push((axis, s.clone()));
        }
        if axis == Axis::L0 && self.expand_stroke {
            self.rebuild();
        } else {
            self.extents[axis.index()] = script.as_ref().and_then(|s| s.extent());
            self.scripts[axis.index()] = script;
        }
    }

    /// Turns the stroke to alpha/beta derivation on or off; applies to the loaded scripts.
    pub fn set_expand_stroke(&mut self, on: bool) {
        if self.expand_stroke != on {
            self.expand_stroke = on;
            self.rebuild();
        }
    }

    /// Contrast on the derived electrodes, 0..1; 0 is restim's decomposition as is.
    pub fn set_electrode_contrast(&mut self, contrast: f64) {
        self.electrode_contrast = contrast.clamp(0.0, 1.0);
    }

    pub fn electrode_contrast(&self) -> f64 {
        self.electrode_contrast
    }

    fn rebuild(&mut self) {
        let loaded = std::mem::take(&mut self.loaded);
        self.install(ScriptTable::build(loaded, self.expand_stroke));
    }

    pub fn has_script(&self, axis: Axis) -> bool {
        self.scripts[axis.index()].is_some()
    }

    pub fn is_derived(&self, axis: Axis) -> bool {
        self.derived[axis.index()]
    }

    /// Whether "find my range" is driving the axis by hand.
    pub fn is_live(&self, axis: Axis) -> bool {
        self.live[axis.index()].is_some()
    }

    /// Whether an outside source (the live tracker, a remote client) is driving the axis.
    pub fn has_external(&self, axis: Axis) -> bool {
        self.external[axis.index()].is_some()
    }

    /// Whether a script, provider or live value drove the axis on the last tick.
    pub fn driven(&self) -> &[bool; Axis::COUNT] {
        &self.driven
    }

    pub fn settings(&self, axis: Axis) -> &AxisSettings {
        &self.settings[axis.index()]
    }

    /// The top of the axis's range this tick: the settings' `max` under any override.
    fn range_max(&self, axis: Axis) -> f64 {
        let cfg = &self.settings[axis.index()];
        self.max_override[axis.index()].map_or(cfg.max, |m| m.clamp(cfg.min, 1.0))
    }

    /// The keyframe the axis is heading for at `media_ms`: its time with the offsets applied
    /// and its position through extent, amplitude, invert and range, as `tick` plays it. A
    /// device that takes timed moves is sent this once per keyframe instead of samples.
    /// `None` while the axis is not playing its script as written (no script, before its
    /// first or after its last action, an external or live source, an effect, a provider, a
    /// smart or speed limit), so the caller samples instead.
    pub fn next_keyframe(&self, axis: Axis, media_ms: f64) -> Option<Action> {
        let i = axis.index();
        let cfg = &self.settings[i];
        if !cfg.enabled
            || self.external[i].is_some()
            || self.live[i].is_some()
            || cfg.provider != Provider::None
            || cfg.smart_limit.is_some()
            || cfg.speed_limit > 0.0
        {
            return None;
        }
        let offset = self.global_offset_ms + cfg.offset_ms;
        let t = media_ms - offset;
        if self.effects[i].is_some_and(|e| t >= e.start_ms && t < e.end_ms) {
            return None;
        }
        let source = cfg.link.unwrap_or(axis);
        let script = self.scripts[source.index()].as_deref()?;
        let next = script.actions.get(script.index_at(t)? + 1)?;
        let extent = self.extents[source.index()].filter(|(lo, hi)| cfg.extend_range && hi - lo > 1e-6);
        let v = extent.map_or(next.pos, |(lo, hi)| ((next.pos - lo) / (hi - lo)).clamp(0.0, 1.0));
        let v = shape(cfg, axis.default_value(), v);
        Some(Action { at: next.at + offset, pos: cfg.min + v * (self.range_max(axis) - cfg.min) })
    }

    pub fn set_settings(&mut self, axis: Axis, settings: AxisSettings) {
        self.settings[axis.index()] = settings;
    }

    /// An outside source (the live tracker) standing in for the script sample, so amplitude,
    /// invert, range, ramp, smart limit and speed limit all still apply. `None` releases it.
    pub fn set_external(&mut self, axis: Axis, value: Option<f64>) {
        self.external[axis.index()] = value.map(|v| v.clamp(0.0, 1.0));
    }

    /// A live source (the tracker, a remote client) as `set_external`, except that a source
    /// beginning to drive a resting axis eases it into the first value over `ONSET_MS`.
    pub fn set_source(&mut self, axis: Axis, value: Option<f64>) {
        let i = axis.index();
        if value.is_some() && self.external[i].is_none() {
            let st = &mut self.state[i];
            st.ramp_from = st.last;
            st.ramp_ms = 0.0;
            st.ramp_len_ms = ONSET_MS;
            st.ramp_onset = true;
        }
        self.set_external(axis, value);
    }

    /// What the axis plays where its script has no keyframe: a fixed value or a provider,
    /// through the same pipeline as a script sample. The axis counts as driven while it
    /// applies. `Fallback::None` clears it.
    pub fn set_fallback(&mut self, axis: Axis, fallback: Fallback) {
        self.fallback[axis.index()] = match fallback {
            Fallback::Value(v) => Fallback::Value(v.clamp(0.0, 1.0)),
            other => other,
        };
    }

    pub fn fallback(&self, axis: Axis) -> &Fallback {
        &self.fallback[axis.index()]
    }

    /// Manual drive for "find my range": a raw device position that replaces the script
    /// until released with `None`.
    pub fn set_live(&mut self, axis: Axis, value: Option<f64>) {
        self.live[axis.index()] = value.map(|v| v.clamp(0.0, 1.0));
    }

    /// Starts the sync ramp on every axis from its last output.
    pub fn resync(&mut self) {
        for s in &mut self.state {
            s.ramp_from = s.last;
            s.ramp_ms = 0.0;
            s.ramp_len_ms = self.sync_ms;
            s.ramp_onset = false;
        }
    }

    /// Advances every axis by `dt_ms` at media time `media_ms`.
    pub fn tick(&mut self, media_ms: f64, dt_ms: f64) -> Frame {
        self.expand_live(dt_ms);
        let previous = self.last_values;
        let mut out = previous;
        for axis in Axis::ALL {
            // Alpha and beta have ticked by now, so the electrodes see them after their own
            // range, invert, ramp and speed limit, and then get the same pipeline themselves.
            if axis == Axis::E1 && self.electrodes {
                let e = expand::contrast(expand::electrodes(out[Axis::EA.index()], out[Axis::EB.index()]), self.electrode_contrast);
                let active = self.driven[Axis::EA.index()] || self.driven[Axis::EB.index()];
                for (a, v) in ELECTRODES.into_iter().zip(e) {
                    self.external[a.index()] = active.then_some(v);
                }
            }
            out[axis.index()] = self.tick_axis(axis, media_ms, dt_ms, &previous);
        }
        self.last_values = out;
        out
    }

    /// A live stroke (the tracker) has no script to derive alpha and beta from ahead of time,
    /// so alpha is the stroke and beta is the live sway when the tracker sends one, else it
    /// orbits: a half circle whose phase follows the previous half-stroke's length, direction
    /// flipping now and then.
    fn expand_live(&mut self, dt_ms: f64) {
        let wants = self.expand_stroke
            && [Axis::EA, Axis::EB].into_iter().all(|a| {
                self.scripts[a.index()].is_none() || self.derived[a.index()]
            });
        let Some(v) = self.external[Axis::L0.index()].filter(|_| wants) else {
            if self.live_orbit.active {
                self.live_orbit = Orbit::default();
                self.external[Axis::EA.index()] = None;
                self.external[Axis::EB.index()] = None;
            }
            return;
        };
        let o = &mut self.live_orbit;
        if !o.active {
            *o = Orbit { active: true, last: v, start: v, dir: 0.0, orbit: 1.0, elapsed_ms: 0.0, half_ms: 500.0, seed: 0 };
        }
        let d = v - o.last;
        if d.abs() > 0.005 {
            let dir = d.signum();
            if dir != o.dir && o.dir != 0.0 {
                o.half_ms = o.elapsed_ms.max(100.0);
                o.elapsed_ms = 0.0;
                o.start = o.last;
                if provider::next_random(&mut o.seed) < 0.1 {
                    o.orbit = -o.orbit;
                }
            }
            o.dir = dir;
            // Keep the reference until enough motion accumulates to establish direction.
            o.last = v;
        }
        o.elapsed_ms += dt_ms;
        let theta = std::f64::consts::PI * (o.elapsed_ms / o.half_ms).min(1.0);
        let r = (v - o.start).abs() / 2.0;
        let orbit = (0.5 + r * o.orbit * theta.sin()).clamp(0.0, 1.0);
        // A live sway (the tracker's horizontal motion) is a real second dimension; the orbit
        // is only for a lone stroke.
        let beta = self.external[Axis::L2.index()].unwrap_or(orbit);
        self.external[Axis::EA.index()] = Some(v);
        self.external[Axis::EB.index()] = Some(beta);
    }

    fn tick_axis(&mut self, axis: Axis, media_ms: f64, dt_ms: f64, previous: &Frame) -> f64 {
        let i = axis.index();
        let cfg = &self.settings[i];
        let default = axis.default_value();
        if !cfg.enabled {
            self.driven[i] = false;
            return default;
        }
        let t = media_ms - self.global_offset_ms - cfg.offset_ms;
        if axis == Axis::S0 {
            let value = self.scripts[i].as_deref().and_then(|script| interp::sample(script, t, cfg.interpolation));
            self.driven[i] = value.is_some();
            return value.map_or(0.0, |v| cfg.min + shape(cfg, 0.0, v) * (cfg.max - cfg.min));
        }
        let effect = self.effects[i].filter(|e| t >= e.start_ms && t < e.end_ms);


        // 1. Script (own or linked) or the external source, else the fallback, shaped by
        //    amplitude and invert.
        let source = cfg.link.unwrap_or(axis);
        let script = self.scripts[source.index()].as_deref();
        let external = self.external[i];
        // The range extender stretches the script's own extent to 0..1 before amplitude.
        let extent = self.extents[source.index()].filter(|(lo, hi)| cfg.extend_range && hi - lo > 1e-6);
        let sampled = external.or_else(|| {
            let script = script?;
            let base = interp::sample(script, t, cfg.interpolation)?;
            let value = effect.map_or(base, |e| {
                let shifted = e.start_ms + (t - e.start_ms) * e.tempo;
                let target = interp::sample(script, shifted, cfg.interpolation).unwrap_or(base);
                let centre = (e.min + e.max) / 2.0;
                let target = (centre + (target - centre) * e.intensity).clamp(e.min, e.max);
                // Ease back onto the media clock so expiry cannot cause a full-range jump.
                let fade = 150.0_f64.min((e.end_ms - e.start_ms) / 2.0);
                let weight = smoothstep(((t - e.start_ms).min(e.end_ms - t) / fade).clamp(0.0, 1.0));
                base + (target - base) * weight
            });
            Some(extent.map_or(value, |(lo, hi)| ((value - lo) / (hi - lo)).clamp(0.0, 1.0)))
        });
        // A long keyframe gap only counts as a gap when a provider can fill it.
        let in_gap = external.is_none() && cfg.provider != Provider::None && script.is_some_and(|s| gap_at(s, t) > cfg.fill_gaps_over_ms);
        let sampled = sampled.filter(|_| !in_gap).or_else(|| self.fallback[i].value(&mut self.state[i].fallback, dt_ms));
        let scripted = sampled.map(|v| shape(cfg, default, v));

        // 2. Motion provider, blended with the script or filling where the script is silent.
        let max = self.range_max(axis);
        let st = &mut self.state[i];
        let provided = cfg.provider.value(&mut st.provider, dt_ms);
        let mut value = match (scripted, provided) {
            (Some(s), Some(p)) => Some(s + (p - s) * cfg.provider_blend),
            (Some(s), None) => Some(s),
            (None, p) => p,
        };

        self.driven[i] = value.is_some() || self.live[i].is_some();

        // 3. Auto-home once nothing has driven the axis for a while.
        if value.is_some() {
            st.idle_ms = 0.0;
            st.home_from = st.last;
        } else {
            st.idle_ms += dt_ms;
        }
        let mut in_range = value.map(|v| cfg.min + v * (max - cfg.min));
        let target_home = cfg.min + default * (max - cfg.min);
        if in_range.is_none() && cfg.auto_home_delay_ms > 0.0 && st.idle_ms >= cfg.auto_home_delay_ms {
            let u = ((st.idle_ms - cfg.auto_home_delay_ms) / cfg.auto_home_duration_ms.max(1.0)).clamp(0.0, 1.0);
            in_range = Some(st.home_from + (target_home - st.home_from) * smoothstep(u));
        }
        if in_range.is_none() && st.home_from != st.last {
            st.home_from = st.last;
        }

        // 4. Live override is a raw device position.
        if let Some(live) = self.live[i] {
            value = Some(live);
            in_range = Some(live);
        }
        let _ = value;
        let mut out = in_range.unwrap_or(st.last);

        let colour_speed = effect.and_then(|e| e.stroke_speed);
        if st.colour_speed_limited && colour_speed.is_none() && st.ramp_len_ms - st.ramp_ms <= 150.0 {
            // Catch up without replacing a longer seek, pause or connection ramp.
            st.ramp_from = st.last;
            st.ramp_ms = 0.0;
            st.ramp_len_ms = 150.0;
            st.ramp_onset = true;
        }
        st.colour_speed_limited = colour_speed.is_some();

        // 5. Sync ramp from the last output toward the new target: an onset eases across its
        //    whole length, a resync closes in exponentially.
        // Restim volume has its own output fade. A positional resync would mask scripted silence.
        if axis != Axis::EV && st.ramp_ms < st.ramp_len_ms {
            st.ramp_ms += dt_ms;
            let u = (st.ramp_ms / st.ramp_len_ms).min(1.0);
            let k = if st.ramp_onset { 1.0 - smoothstep(u) } else { (2f64).powf(-10.0 * u) };
            out = out + (st.ramp_from - out) * k;
        }

        // 6. Smart limit: another axis's last value pulls this one toward its home.
        if let Some(sl) = &cfg.smart_limit {
            let factor = sl.factor(previous[sl.input.index()] * 100.0);
            out = target_home + (out - target_home) * factor;
        }

        // 7. Speed limit in full-range units per second.
        let speed_limit = match colour_speed {
            Some(speed) if cfg.speed_limit > 0.0 => speed.min(cfg.speed_limit),
            Some(speed) => speed,
            None => cfg.speed_limit,
        };
        if speed_limit > 0.0 {
            let max_step = speed_limit * dt_ms / 1000.0;
            out = st.last + (out - st.last).clamp(-max_step, max_step);
        }

        let out = out.clamp(0.0, 1.0);
        st.last = out;
        out
    }
}

/// Amplitude about the axis's default, then invert, in 0..1.
fn shape(cfg: &AxisSettings, default: f64, v: f64) -> f64 {
    let v = default + (v - default) * cfg.amplitude;
    let v = if cfg.invert { 1.0 - v } else { v };
    v.clamp(0.0, 1.0)
}

const ELECTRODES: [Axis; 4] = [Axis::E1, Axis::E2, Axis::E3, Axis::E4];

#[derive(Default)]
struct Orbit {
    active: bool,
    last: f64,
    /// Stroke position where the current half-stroke began.
    start: f64,
    /// Current stroke direction, 0 before the first move.
    dir: f64,
    /// Which way beta swings, flipped with probability 0.1 per half-stroke.
    orbit: f64,
    elapsed_ms: f64,
    /// Length of the previous half-stroke, the phase reference for this one.
    half_ms: f64,
    seed: u64,
}

/// Length of the keyframe gap around `t`, 0 when `t` is outside the script.
fn gap_at(script: &Script, t: f64) -> f64 {
    match script.index_at(t) {
        Some(i) => script.actions.get(i + 1).map_or(0.0, |n| n.at - script.actions[i].at),
        None => 0.0,
    }
}

fn smoothstep(u: f64) -> f64 {
    u * u * (3.0 - 2.0 * u)
}

pub fn interpolation_from(s: &str) -> Interpolation {
    Interpolation::from_str(s).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(pts: &[(f64, f64)]) -> Script {
        Script { actions: pts.iter().map(|(at, pos)| Action { at: *at, pos: *pos }).collect(), ..Default::default() }
    }

    fn settled(m: &mut Mixer) {
        m.sync_ms = 0.0;
        m.resync();
    }

    #[test]
    fn shock_requires_its_own_script_and_releases_at_its_end() {
        let mut m = Mixer::new();
        m.set_scripts([(Axis::L0, script(&[(0.0, 1.0), (1000.0, 1.0)]))]);
        m.set_live(Axis::S0, Some(1.0));
        m.set_external(Axis::S0, Some(1.0));
        m.set_fallback(Axis::S0, Fallback::Value(1.0));
        m.settings[Axis::S0.index()].link = Some(Axis::L0);
        assert_eq!(m.tick(500.0, 10.0)[Axis::S0.index()], 0.0);
        assert!(!m.driven()[Axis::S0.index()]);
        m.set_scripts([(Axis::S0, script(&[(100.0, 0.2), (1000.0, 0.8)]))]);
        assert!((m.tick(550.0, 10.0)[Axis::S0.index()] - 0.5).abs() < 1e-9);
        assert!(m.driven()[Axis::S0.index()]);
        assert_eq!(m.tick(1001.0, 10.0)[Axis::S0.index()], 0.0);
        assert!(!m.driven()[Axis::S0.index()]);
        assert_eq!(m.tick(0.0, 10.0)[Axis::S0.index()], 0.0);
        m.set_scripts([]);
        assert_eq!(m.tick(550.0, 10.0)[Axis::S0.index()], 0.0);
    }

    #[test]
    fn next_keyframe_carries_offsets_and_shaping() {
        let mut m = Mixer::new();
        m.set_scripts([(Axis::L0, script(&[(0.0, 0.0), (1000.0, 1.0), (2000.0, 0.5)]))]);
        m.global_offset_ms = 100.0;
        let mut cfg = m.settings(Axis::L0).clone();
        cfg.offset_ms = 50.0;
        cfg.invert = true;
        cfg.min = 0.2;
        cfg.max = 0.8;
        m.set_settings(Axis::L0, cfg);
        // Before the first action there is no segment to play.
        assert_eq!(m.next_keyframe(Axis::L0, 100.0), None);
        // Inside the first segment: the second action, 150 ms later in video time, inverted
        // into the 0.2..0.8 range.
        let k = m.next_keyframe(Axis::L0, 500.0).unwrap();
        assert_eq!(k.at, 1150.0);
        assert!((k.pos - 0.2).abs() < 1e-9, "{}", k.pos);
        let k = m.next_keyframe(Axis::L0, 1150.0).unwrap();
        assert_eq!((k.at, k.pos), (2150.0, 0.5));
        // Past the last action, and when something else owns the axis, the caller samples.
        assert_eq!(m.next_keyframe(Axis::L0, 2150.0), None);
        m.set_source(Axis::L0, Some(0.3));
        assert_eq!(m.next_keyframe(Axis::L0, 500.0), None);
    }

    #[test]
    fn colour_stroke_speed_caps_travel_and_releases_at_expiry() {
        let mut m = Mixer::new();
        m.sync_ms = 0.0;
        m.set_scripts([(Axis::L0, script(&[(0.0, 1.0), (3000.0, 1.0)]))]);
        m.set_script_effect(Axis::L0, Some(ScriptEffect {
            start_ms: 0.0, end_ms: 1000.0, tempo: 1.0, intensity: 1.0,
            min: 0.0, max: 1.0, stroke_speed: Some(0.5),
        }));
        let before = Axis::L0.default_value();
        let limited = m.tick(500.0, 100.0)[Axis::L0.index()];
        assert!((limited - before).abs() <= 0.050001);
        let release = m.tick(1000.0, 1.0)[Axis::L0.index()];
        assert!((release - limited).abs() < 0.001);
        let restored = m.tick(1150.0, 150.0)[Axis::L0.index()];
        assert!((restored - 1.0).abs() < 1e-6);
    }

    #[test]
    fn colour_speed_release_preserves_seek_and_pause_resync() {
        let mut m = Mixer::new();
        m.sync_ms = 0.0;
        m.set_scripts([(Axis::L0, script(&[(0.0, 1.0), (3000.0, 1.0)]))]);
        m.set_script_effect(Axis::L0, Some(ScriptEffect {
            start_ms: 0.0, end_ms: 1000.0, tempo: 1.0, intensity: 1.0,
            min: 0.0, max: 1.0, stroke_speed: Some(0.5),
        }));
        m.tick(500.0, 100.0);
        m.sync_ms = 4000.0;
        m.resync();
        m.set_script_effect(Axis::L0, None);
        let value = m.tick(500.0, 200.0)[Axis::L0.index()];
        assert!(value < 0.75, "the pause ramp was replaced by the shorter colour release");
        assert_eq!(m.state[Axis::L0.index()].ramp_len_ms, 4000.0);
    }

    #[test]
    fn timed_script_effect_respects_offsets_limits_and_expiry() {
        let mut m = Mixer::new();
        m.sync_ms = 0.0;
        m.set_scripts([(Axis::L0, script(&[(0.0, 0.2), (1000.0, 0.8), (2000.0, 0.2), (3000.0, 0.8)]))]);
        m.global_offset_ms = 100.0;
        m.set_script_effect(Axis::L0, Some(ScriptEffect {
            start_ms: 1000.0, end_ms: 2000.0, tempo: 2.0, intensity: 2.0, min: 0.2, max: 0.8, stroke_speed: None,
        }));
        let unaffected = m.tick(600.0, 10.0)[Axis::L0.index()];
        assert!((unaffected - 0.5).abs() < 1e-6);
        let boosted = m.tick(1100.0, 10.0)[Axis::L0.index()];
        assert!((boosted - 0.8).abs() < 1e-6);
        let accelerated = m.tick(1350.0, 10.0)[Axis::L0.index()];
        assert!((accelerated - 0.5).abs() < 1e-6);
        let before_expiry = m.tick(2099.9, 10.0)[Axis::L0.index()];
        let expired = m.tick(2100.0, 10.0)[Axis::L0.index()];
        assert!((expired - 0.2).abs() < 1e-6);
        assert!((before_expiry - expired).abs() < 0.001);
        m.set_script_effect(Axis::L0, None);
        let restored = m.tick(1350.0, 10.0)[Axis::L0.index()];
        assert!((restored - 0.65).abs() < 1e-6);
    }

    #[test]
    fn max_override_moves_the_ceiling_and_lets_go() {
        let mut m = Mixer::new();
        settled(&mut m);
        m.set_scripts([(Axis::V0, script(&[(0.0, 1.0), (1000.0, 1.0)]))]);
        let mut s = AxisSettings::default_for(Axis::V0);
        s.max = 0.5;
        s.speed_limit = 0.0;
        m.set_settings(Axis::V0, s);
        assert!((m.tick(100.0, 10.0)[Axis::V0.index()] - 0.5).abs() < 1e-9);
        m.set_max_override(Axis::V0, Some(1.0));
        assert!((m.tick(110.0, 10.0)[Axis::V0.index()] - 1.0).abs() < 1e-9);
        // An override cannot go under the floor.
        m.set_max_override(Axis::V0, Some(-1.0));
        assert!((m.tick(120.0, 10.0)[Axis::V0.index()] - 0.0).abs() < 1e-9);
        m.set_max_override(Axis::V0, None);
        assert!((m.tick(130.0, 10.0)[Axis::V0.index()] - 0.5).abs() < 1e-9);
    }

    #[test]
    fn script_flows_through_range_and_invert() {
        let mut m = Mixer::new();
        settled(&mut m);
        m.set_scripts([(Axis::L0, script(&[(0.0, 0.0), (1000.0, 1.0)]))]);
        let mut s = AxisSettings::default();
        s.min = 0.2;
        s.max = 0.8;
        s.invert = true;
        s.speed_limit = 0.0;
        s.interpolation = Interpolation::Linear;
        m.set_settings(Axis::L0, s);
        let f = m.tick(250.0, 10.0);
        // script 0.25, inverted 0.75, in 0.2..0.8 -> 0.65
        assert!((f[Axis::L0.index()] - 0.65).abs() < 1e-9, "{}", f[0]);
        // an axis without a script rests at its default
        assert_eq!(f[Axis::R0.index()], 0.5);
    }

    #[test]
    fn speed_limit_caps_the_step() {
        let mut m = Mixer::new();
        settled(&mut m);
        m.set_scripts([(Axis::L0, script(&[(0.0, 0.0), (1.0, 1.0), (5000.0, 1.0)]))]);
        let mut s = AxisSettings::default();
        s.speed_limit = 2.0; // full range in 500 ms
        m.set_settings(Axis::L0, s);
        let a = m.tick(100.0, 10.0)[0];
        assert!((a - 0.52).abs() < 1e-9, "{a}");
    }

    #[test]
    fn sync_ramp_eases_from_last_value() {
        let mut m = Mixer::new();
        m.set_scripts([(Axis::L0, script(&[(0.0, 1.0), (10_000.0, 1.0)]))]);
        let mut s = AxisSettings::default();
        s.speed_limit = 0.0;
        m.set_settings(Axis::L0, s);
        let first = m.tick(0.0, 10.0)[0];
        assert!(first > 0.5 && first < 0.6, "starts near the rest value: {first}");
        for _ in 0..500 {
            m.tick(0.0, 10.0);
        }
        assert!((m.tick(0.0, 10.0)[0] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn external_onset_eases_in_over_a_second() {
        let mut m = Mixer::new();
        settled(&mut m);
        let mut s = AxisSettings::default();
        s.speed_limit = 0.0;
        m.set_settings(Axis::L0, s);
        // Resting at 0.5; the tracker starts at 1.0.
        m.set_source(Axis::L0, Some(1.0));
        assert!(m.has_external(Axis::L0) && !m.has_external(Axis::R0));
        let first = m.tick(0.0, 10.0)[0];
        assert!(first < 0.51, "barely moved on the first tick: {first}");
        for _ in 0..49 {
            m.tick(0.0, 10.0);
        }
        let half = m.tick(0.0, 10.0)[0];
        assert!((half - 0.75).abs() < 0.02, "halfway at 500 ms: {half}");
        for _ in 0..50 {
            m.tick(0.0, 10.0);
        }
        assert!((m.tick(0.0, 10.0)[0] - 1.0).abs() < 1e-9, "there after a second");
        // Once it is driving, values pass straight through.
        m.set_source(Axis::L0, Some(0.2));
        assert!((m.tick(0.0, 10.0)[0] - 0.2).abs() < 1e-9);
        // Released and driven again: a new onset.
        m.set_source(Axis::L0, None);
        assert!(!m.has_external(Axis::L0));
        m.tick(0.0, 10.0);
        m.set_source(Axis::L0, Some(0.9));
        let again = m.tick(0.0, 10.0)[0];
        assert!(again < 0.21, "eases from where it was: {again}");
    }

    #[test]
    fn range_extender_stretches_a_narrow_script() {
        let mut m = Mixer::new();
        settled(&mut m);
        m.set_scripts([(Axis::L0, script(&[(0.0, 0.3), (100.0, 0.7), (200.0, 0.5)]))]);
        let mut s = AxisSettings::default();
        s.speed_limit = 0.0;
        m.set_settings(Axis::L0, s.clone());
        assert!((m.tick(0.0, 10.0)[0] - 0.3).abs() < 1e-9, "plays as written");
        s.extend_range = true;
        m.set_settings(Axis::L0, s);
        assert!((m.tick(0.0, 10.0)[0] - 0.0).abs() < 1e-9);
        assert!((m.tick(100.0, 10.0)[0] - 1.0).abs() < 1e-9);
        assert!((m.tick(200.0, 10.0)[0] - 0.5).abs() < 1e-9);
    }

    #[test]
    fn auto_home_after_script_ends() {
        let mut m = Mixer::new();
        settled(&mut m);
        m.set_scripts([(Axis::L0, script(&[(0.0, 1.0), (100.0, 1.0)]))]);
        let mut s = AxisSettings::default();
        s.speed_limit = 0.0;
        s.auto_home_delay_ms = 1000.0;
        s.auto_home_duration_ms = 1000.0;
        m.set_settings(Axis::L0, s);
        assert_eq!(m.tick(50.0, 10.0)[0], 1.0);
        assert_eq!(m.tick(500.0, 10.0)[0], 1.0, "holds after the script ends");
        for _ in 0..100 {
            m.tick(500.0, 10.0);
        }
        let mid = m.tick(500.0, 500.0)[0];
        assert!(mid < 1.0 && mid > 0.5, "easing home: {mid}");
        for _ in 0..10 {
            m.tick(500.0, 500.0);
        }
        assert!((m.tick(500.0, 10.0)[0] - 0.5).abs() < 1e-9);
    }

    #[test]
    fn provider_fills_gaps_and_live_overrides() {
        let mut m = Mixer::new();
        settled(&mut m);
        m.set_scripts([(Axis::L0, script(&[(0.0, 0.0), (100.0, 0.0), (20_000.0, 0.0)]))]);
        let mut s = AxisSettings::default();
        s.speed_limit = 0.0;
        s.provider = Provider::Sine { period_ms: 1000.0 };
        s.fill_gaps_over_ms = 5000.0;
        m.set_settings(Axis::L0, s);
        assert_eq!(m.tick(50.0, 10.0)[0], 0.0, "script wins where it has keyframes");
        let mut moved = false;
        for _ in 0..50 {
            if (m.tick(5000.0, 10.0)[0] - 0.0).abs() > 0.05 {
                moved = true;
            }
        }
        assert!(moved, "sine fills the 20 s gap");
        m.set_live(Axis::L0, Some(0.9));
        assert_eq!(m.tick(50.0, 10.0)[0], 0.9);
    }

    #[test]
    fn live_stroke_orbits_alpha_and_beta() {
        let mut m = Mixer::new();
        settled(&mut m);
        m.set_expand_stroke(true);
        let mut plain = AxisSettings::default();
        plain.speed_limit = 0.0;
        for a in [Axis::L0, Axis::EA, Axis::EB] {
            m.set_settings(a, plain.clone());
        }
        // Two full strokes at 1 Hz, then read the third.
        let mut beta_swing: f64 = 0.0;
        let mut alpha_err: f64 = 0.0;
        for i in 0..300 {
            let t = i as f64 * 10.0;
            let v = 0.5 + 0.4 * (t / 1000.0 * std::f64::consts::TAU).sin();
            m.set_external(Axis::L0, Some(v));
            let f = m.tick(t, 10.0);
            if i >= 200 {
                alpha_err = alpha_err.max((f[Axis::EA.index()] - v).abs());
                beta_swing = beta_swing.max((f[Axis::EB.index()] - 0.5).abs());
            }
        }
        assert!(alpha_err < 1e-6, "alpha is the stroke: {alpha_err}");
        assert!(beta_swing > 0.15, "beta swings out mid-stroke: {beta_swing}");
        m.set_external(Axis::L0, None);
        m.tick(3000.0, 10.0);
        assert!(!m.driven()[Axis::EB.index()], "beta released with the stroke");
    }

    #[test]
    fn slow_stroke_keeps_orbiting_at_different_tick_rates() {
        for hz in [100.0, 200.0, 500.0] {
            let mut m = Mixer::new();
            settled(&mut m);
            plain_estim(&mut m);
            m.set_expand_stroke(true);
            let mut swing: f64 = 0.0;
            for i in 0..(hz * 12.0) as usize {
                let t = i as f64 / hz;
                let phase = t % 4.0;
                let v = if phase < 2.0 { 0.1 + 0.4 * phase } else { 0.9 - 0.4 * (phase - 2.0) };
                m.set_external(Axis::L0, Some(v));
                let f = m.tick(t * 1000.0, 1000.0 / hz);
                if t > 8.0 {
                    swing = swing.max((f[Axis::EB.index()] - 0.5).abs());
                    assert!((f[Axis::EA.index()] - v).abs() < 1e-6);
                }
            }
            assert!(swing > 0.15, "beta stalled at {hz} Hz: {swing}");
        }
    }

    #[test]
    fn tracked_stroke_overrides_derived_scripts_and_releases_them() {
        let mut m = Mixer::new();
        settled(&mut m);
        plain_estim(&mut m);
        m.set_expand_stroke(true);
        m.set_scripts([(Axis::L0, script(&[(0.0, 0.0), (1000.0, 1.0)]))]);
        m.set_external(Axis::L0, Some(0.9));
        m.set_external(Axis::L2, Some(0.3));
        let f = m.tick(0.0, 10.0);
        assert_eq!(f[Axis::EA.index()], 0.9);
        assert_eq!(f[Axis::EB.index()], 0.3);
        m.set_external(Axis::L0, None);
        let f = m.tick(0.0, 10.0);
        assert_eq!(f[Axis::EA.index()], 0.0);
        assert_eq!(f[Axis::EB.index()], 0.5);
    }

    #[test]
    fn tracked_stroke_preserves_explicit_estim_scripts() {
        let mut m = Mixer::new();
        settled(&mut m);
        plain_estim(&mut m);
        m.set_expand_stroke(true);
        m.set_scripts([(Axis::EA, script(&[(0.0, 0.2), (1000.0, 0.2)]))]);
        m.set_external(Axis::L0, Some(0.9));
        assert_eq!(m.tick(0.0, 10.0)[Axis::EA.index()], 0.2);
    }

    /// Electrode settings without a speed limit, so the tests read the decomposition directly.
    fn plain_estim(m: &mut Mixer) {
        for a in [Axis::L0, Axis::EA, Axis::EB, Axis::E1, Axis::E2, Axis::E3, Axis::E4] {
            let mut s = AxisSettings::default_for(a);
            s.speed_limit = 0.0;
            m.set_settings(a, s);
        }
    }

    fn electrodes_of(f: &Frame) -> [f64; 4] {
        [f[Axis::E1.index()], f[Axis::E2.index()], f[Axis::E3.index()], f[Axis::E4.index()]]
    }

    #[test]
    fn electrodes_follow_scripted_alpha_and_beta() {
        let mut m = Mixer::new();
        settled(&mut m);
        plain_estim(&mut m);
        m.set_expand_stroke(true);
        m.set_scripts([(Axis::EA, script(&[(0.0, 1.0), (1000.0, 1.0)])), (Axis::EB, script(&[(0.0, 0.5), (1000.0, 0.5)]))]);
        let f = m.tick(500.0, 10.0);
        let e = electrodes_of(&f);
        assert!((e[0] - 1.0).abs() < 1e-9 && e[1..].iter().all(|v| v.abs() < 1e-9), "{e:?}");
        assert!(m.driven()[Axis::E1.index()] && m.driven()[Axis::E4.index()]);
        assert!(m.is_derived(Axis::E1) && !m.is_derived(Axis::EA), "scripted alpha is not derived; the electrodes are");
        // Electrodes get their own pipeline: a range clamp caps one of them.
        let mut s = AxisSettings::default_for(Axis::E1);
        s.speed_limit = 0.0;
        s.max = 0.4;
        m.set_settings(Axis::E1, s);
        assert!((m.tick(500.0, 10.0)[Axis::E1.index()] - 0.4).abs() < 1e-9);
    }

    #[test]
    fn electrodes_follow_the_pair_derived_from_a_stroke() {
        let mut m = Mixer::new();
        settled(&mut m);
        plain_estim(&mut m);
        m.set_expand_stroke(true);
        m.set_scripts([(Axis::L0, script(&[(0.0, 1.0), (1000.0, 0.0), (2000.0, 1.0)]))]);
        assert!(m.is_derived(Axis::EA) && m.is_derived(Axis::E2));
        let f = m.tick(500.0, 10.0);
        let e = electrodes_of(&f);
        assert_eq!(e, expand::contrast(expand::electrodes(f[Axis::EA.index()], f[Axis::EB.index()]), 0.0));
        assert!(e.iter().any(|v| *v > 0.3), "mid-stroke beta swings out, so an electrode is on: {e:?}");
        assert!(e.iter().any(|v| *v == 0.0), "one electrode is always zero");
    }

    #[test]
    fn electrodes_follow_the_live_orbit() {
        let mut m = Mixer::new();
        settled(&mut m);
        plain_estim(&mut m);
        m.set_expand_stroke(true);
        let mut max_e2: f64 = 0.0;
        for i in 0..300 {
            let t = i as f64 * 10.0;
            let v = 0.5 + 0.4 * (t / 1000.0 * std::f64::consts::TAU).sin();
            m.set_external(Axis::L0, Some(v));
            let f = m.tick(t, 10.0);
            assert_eq!(electrodes_of(&f), expand::contrast(expand::electrodes(f[Axis::EA.index()], f[Axis::EB.index()]), 0.0));
            max_e2 = max_e2.max(f[Axis::E2.index()].max(f[Axis::E3.index()]));
        }
        assert!(max_e2 > 0.1, "beta's orbit reaches electrodes 2 to 4: {max_e2}");
    }

    #[test]
    fn contrast_shapes_relative_balance_but_not_scripted_electrodes() {
        let mut m = Mixer::new();
        settled(&mut m);
        plain_estim(&mut m);
        m.set_expand_stroke(true);
        // Electrode 1 is weaker than electrodes 3 and 4 at this point.
        m.set_scripts([(Axis::EA, script(&[(0.0, 0.75), (1000.0, 0.75)])), (Axis::EB, script(&[(0.0, 0.75), (1000.0, 0.75)]))]);
        let plain = m.tick(500.0, 10.0)[Axis::E1.index()];
        assert!(plain > 0.0 && plain < 1.0, "{plain}");
        assert_eq!(m.tick(500.0, 10.0)[Axis::E3.index()], 1.0);
        m.set_electrode_contrast(1.0);
        let lifted = m.tick(500.0, 10.0)[Axis::E1.index()];
        assert!((lifted - plain.powf(0.25)).abs() < 1e-9, "{lifted}");
        assert_eq!(m.tick(500.0, 10.0)[Axis::E3.index()], 1.0);
        assert_eq!(m.tick(500.0, 10.0)[Axis::E2.index()], 0.0, "the silent electrode stays silent");
        // A file's own electrode is not touched.
        m.set_scripts([(Axis::E1, script(&[(0.0, 0.2), (1000.0, 0.2)]))]);
        assert!((m.tick(500.0, 10.0)[Axis::E1.index()] - 0.2).abs() < 1e-9);
    }

    #[test]
    fn volume_resync_keeps_scripted_silence_for_the_output_envelope() {
        let mut m = Mixer::new();
        m.set_scripts([(Axis::EV, script(&[(0.0, 0.8), (1000.0, 0.8), (1100.0, 0.0), (2000.0, 0.0)]))]);
        assert_eq!(m.tick(500.0, 10.0)[Axis::EV.index()], 0.8);
        m.resync();
        assert_eq!(m.tick(1500.0, 10.0)[Axis::EV.index()], 0.0);
        assert!(m.driven()[Axis::EV.index()]);
        m.resync();
        assert_eq!(m.tick(500.0, 10.0)[Axis::EV.index()], 0.8, "the output envelope owns the next fade");
    }

    #[test]
    fn derived_electrodes_release_when_the_position_source_stops() {
        let mut m = Mixer::new();
        settled(&mut m);
        m.set_expand_stroke(true);
        m.tick(0.0, 10.0);
        assert!(ELECTRODES.iter().all(|a| !m.driven()[a.index()]));
        m.set_external(Axis::EA, Some(0.8));
        m.tick(0.0, 10.0);
        assert!(ELECTRODES.iter().all(|a| m.driven()[a.index()]));
        let mut settings = m.settings(Axis::EA).clone();
        settings.enabled = false;
        m.set_settings(Axis::EA, settings);
        m.tick(0.0, 10.0);
        assert!(!m.driven()[Axis::EA.index()]);
        assert!(ELECTRODES.iter().all(|a| !m.driven()[a.index()]));
    }

    #[test]
    fn electrodes_are_left_alone_when_a_script_ships_them_or_without_restim() {
        let mut m = Mixer::new();
        settled(&mut m);
        plain_estim(&mut m);
        m.set_expand_stroke(true);
        m.set_scripts([(Axis::EA, script(&[(0.0, 1.0), (1000.0, 1.0)])), (Axis::E3, script(&[(0.0, 0.2), (1000.0, 0.2)]))]);
        let f = m.tick(500.0, 10.0);
        assert!((f[Axis::E3.index()] - 0.2).abs() < 1e-9, "the file's e3 plays as written");
        assert_eq!(f[Axis::E1.index()], 0.0, "and nothing is derived beside it");
        assert!(!m.is_derived(Axis::E1) && !m.driven()[Axis::E1.index()]);
        // The restim output goes away: derivation stops and the electrodes are released.
        m.set_scripts([(Axis::EA, script(&[(0.0, 1.0), (1000.0, 1.0)]))]);
        assert!(m.tick(500.0, 10.0)[Axis::E1.index()] > 0.99);
        m.set_expand_stroke(false);
        m.tick(500.0, 10.0);
        assert!(!m.driven()[Axis::E1.index()] && !m.is_derived(Axis::E1));
    }

    #[test]
    fn external_replaces_the_script_and_keeps_the_pipeline() {
        let mut m = Mixer::new();
        settled(&mut m);
        m.set_scripts([(Axis::L0, script(&[(0.0, 0.0), (1000.0, 0.0)]))]);
        let mut s = AxisSettings::default();
        s.min = 0.2;
        s.max = 0.8;
        s.invert = true;
        s.speed_limit = 0.0;
        m.set_settings(Axis::L0, s);
        m.set_external(Axis::L0, Some(0.25));
        // inverted 0.75, in 0.2..0.8 -> 0.65
        assert!((m.tick(500.0, 10.0)[0] - 0.65).abs() < 1e-9);
        assert!(m.driven()[Axis::L0.index()]);
        m.set_external(Axis::L0, None);
        // script 0, inverted 1, in 0.2..0.8 -> 0.8
        assert!((m.tick(500.0, 10.0)[0] - 0.8).abs() < 1e-9, "back to the script");
    }

    #[test]
    fn fallback_fills_where_the_script_has_no_keyframe() {
        let mut m = Mixer::new();
        settled(&mut m);
        m.set_scripts([(Axis::C0, script(&[(1000.0, 0.0), (2000.0, 0.0)]))]);
        let mut s = AxisSettings::default_for(Axis::C0);
        s.speed_limit = 0.0;
        s.min = 0.2;
        s.max = 0.8;
        s.invert = true;
        m.set_settings(Axis::C0, s);
        m.tick(0.0, 10.0);
        assert!(!m.driven()[Axis::C0.index()], "nothing drives the carrier before its script");
        m.set_fallback(Axis::C0, Fallback::Value(0.25));
        // Before the script: fallback 0.25, inverted 0.75, in 0.2..0.8 -> 0.65.
        assert!((m.tick(0.0, 10.0)[Axis::C0.index()] - 0.65).abs() < 1e-9);
        assert!(m.driven()[Axis::C0.index()], "a fallback counts as driven");
        // Inside the script it wins: 0, inverted 1, in range -> 0.8.
        assert!((m.tick(1500.0, 10.0)[Axis::C0.index()] - 0.8).abs() < 1e-9);
        // After it, the fallback again.
        assert!((m.tick(3000.0, 10.0)[Axis::C0.index()] - 0.65).abs() < 1e-9);
        // A sweep moves inside the range.
        m.set_fallback(Axis::P0, Fallback::Provider(Provider::Sine { period_ms: 1000.0 }));
        let mut p = AxisSettings::default_for(Axis::P0);
        p.speed_limit = 0.0;
        p.min = 0.4;
        p.max = 0.6;
        m.set_settings(Axis::P0, p);
        let (mut lo, mut hi) = (1.0f64, 0.0f64);
        for _ in 0..100 {
            let v = m.tick(3000.0, 10.0)[Axis::P0.index()];
            lo = lo.min(v);
            hi = hi.max(v);
        }
        assert!(lo >= 0.4 - 1e-9 && hi <= 0.6 + 1e-9 && hi - lo > 0.15, "{lo} {hi}");
        m.set_fallback(Axis::P0, Fallback::None);
        m.tick(3000.0, 10.0);
        assert!(!m.driven()[Axis::P0.index()], "cleared: not sent");
    }

    #[test]
    fn smart_limit_pulls_toward_home() {
        let mut m = Mixer::new();
        settled(&mut m);
        m.set_scripts([(Axis::L0, script(&[(0.0, 1.0), (1000.0, 1.0)])), (Axis::R1, script(&[(0.0, 1.0), (1000.0, 1.0)]))]);
        let mut s = AxisSettings::default();
        s.speed_limit = 0.0;
        s.smart_limit = Some(SmartLimit::default_for(Axis::L0));
        m.set_settings(Axis::R1, s);
        let mut l0 = AxisSettings::default();
        l0.speed_limit = 0.0;
        m.set_settings(Axis::L0, l0);
        m.tick(500.0, 10.0);
        let f = m.tick(500.0, 10.0);
        assert_eq!(f[Axis::L0.index()], 1.0);
        assert!((f[Axis::R1.index()] - 0.5).abs() < 1e-9, "stroke at 100 zeroes roll: {}", f[Axis::R1.index()]);
    }
}
