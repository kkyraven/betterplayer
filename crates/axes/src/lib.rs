mod provider;
mod settings;

use std::sync::Arc;

use bp_script::{Axis, Interpolation, Script, expand, interp};

pub use provider::Provider;
pub use settings::{AxisSettings, SmartLimit};


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


pub type Frame = [f64; Axis::COUNT];


#[derive(Default)]
struct AxisState {

    last: f64,

    idle_ms: f64,

    home_from: f64,
    provider: provider::State,
    fallback: provider::State,

    ramp_from: f64,
    ramp_ms: f64,
    ramp_len_ms: f64,


    ramp_onset: bool,
}



pub const ONSET_MS: f64 = 1000.0;





pub struct ScriptTable {

    loaded: Vec<(Axis, Arc<Script>)>,
    scripts: [Option<Arc<Script>>; Axis::COUNT],
    derived: [bool; Axis::COUNT],
    expand_stroke: bool,
    electrodes: bool,
}

impl ScriptTable {


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

pub struct Mixer {
    scripts: [Option<Arc<Script>>; Axis::COUNT],

    extents: [Option<(f64, f64)>; Axis::COUNT],

    loaded: Vec<(Axis, Arc<Script>)>,


    derived: [bool; Axis::COUNT],

    expand_stroke: bool,


    electrodes: bool,


    electrode_contrast: f64,
    settings: [AxisSettings; Axis::COUNT],
    external: [Option<f64>; Axis::COUNT],
    fallback: [Fallback; Axis::COUNT],
    live: [Option<f64>; Axis::COUNT],
    state: [AxisState; Axis::COUNT],

    driven: [bool; Axis::COUNT],

    live_orbit: Orbit,
    pub global_offset_ms: f64,

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



    pub fn set_scripts(&mut self, scripts: impl IntoIterator<Item = (Axis, Script)>) {
        let loaded = scripts.into_iter().map(|(a, s)| (a, Arc::new(s))).collect();
        self.install(ScriptTable::build(loaded, self.expand_stroke));
        self.resync();
    }


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


    pub fn loaded(&self) -> &[(Axis, Arc<Script>)] {
        &self.loaded
    }

    pub fn expand_stroke(&self) -> bool {
        self.expand_stroke
    }




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


    pub fn set_expand_stroke(&mut self, on: bool) {
        if self.expand_stroke != on {
            self.expand_stroke = on;
            self.rebuild();
        }
    }


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


    pub fn is_live(&self, axis: Axis) -> bool {
        self.live[axis.index()].is_some()
    }


    pub fn has_external(&self, axis: Axis) -> bool {
        self.external[axis.index()].is_some()
    }


    pub fn driven(&self) -> &[bool; Axis::COUNT] {
        &self.driven
    }

    pub fn settings(&self, axis: Axis) -> &AxisSettings {
        &self.settings[axis.index()]
    }

    pub fn set_settings(&mut self, axis: Axis, settings: AxisSettings) {
        self.settings[axis.index()] = settings;
    }



    pub fn set_external(&mut self, axis: Axis, value: Option<f64>) {
        self.external[axis.index()] = value.map(|v| v.clamp(0.0, 1.0));
    }



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




    pub fn set_fallback(&mut self, axis: Axis, fallback: Fallback) {
        self.fallback[axis.index()] = match fallback {
            Fallback::Value(v) => Fallback::Value(v.clamp(0.0, 1.0)),
            other => other,
        };
    }

    pub fn fallback(&self, axis: Axis) -> &Fallback {
        &self.fallback[axis.index()]
    }



    pub fn set_live(&mut self, axis: Axis, value: Option<f64>) {
        self.live[axis.index()] = value.map(|v| v.clamp(0.0, 1.0));
    }


    pub fn resync(&mut self) {
        for s in &mut self.state {
            s.ramp_from = s.last;
            s.ramp_ms = 0.0;
            s.ramp_len_ms = self.sync_ms;
            s.ramp_onset = false;
        }
    }


    pub fn tick(&mut self, media_ms: f64, dt_ms: f64) -> Frame {
        self.expand_live(dt_ms);
        let previous = self.last_values;
        let mut out = previous;
        for axis in Axis::ALL {


            if axis == Axis::E1 && self.electrodes {
                let e = expand::contrast(expand::electrodes(out[Axis::EA.index()], out[Axis::EB.index()]), self.electrode_contrast);
                for (a, v) in ELECTRODES.into_iter().zip(e) {
                    self.external[a.index()] = Some(v);
                }
            }
            out[axis.index()] = self.tick_axis(axis, media_ms, dt_ms, &previous);
        }
        self.last_values = out;
        out
    }





    fn expand_live(&mut self, dt_ms: f64) {
        let wants = self.expand_stroke && self.scripts[Axis::EA.index()].is_none() && self.scripts[Axis::EB.index()].is_none();
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
        }
        o.elapsed_ms += dt_ms;
        o.last = v;
        let theta = std::f64::consts::PI * (o.elapsed_ms / o.half_ms).min(1.0);
        let r = (v - o.start).abs() / 2.0;
        let orbit = (0.5 + r * o.orbit * theta.sin()).clamp(0.0, 1.0);


        let beta = self.external[Axis::L2.index()].unwrap_or(orbit);
        self.external[Axis::EA.index()] = Some(v);
        self.external[Axis::EB.index()] = Some(beta);
    }

    fn tick_axis(&mut self, axis: Axis, media_ms: f64, dt_ms: f64, previous: &Frame) -> f64 {
        let i = axis.index();
        let cfg = &self.settings[i];
        let default = axis.default_value();
        if !cfg.enabled {
            return default;
        }
        let t = media_ms - self.global_offset_ms - cfg.offset_ms;



        let source = cfg.link.unwrap_or(axis);
        let script = self.scripts[source.index()].as_deref();
        let external = self.external[i];

        let extent = self.extents[source.index()].filter(|(lo, hi)| cfg.extend_range && hi - lo > 1e-6);
        let sampled = external.or_else(|| script.and_then(|s| interp::sample(s, t, cfg.interpolation)).map(|v| extent.map_or(v, |(lo, hi)| ((v - lo) / (hi - lo)).clamp(0.0, 1.0))));


        let in_gap = external.is_none() && cfg.provider != Provider::None && script.is_some_and(|s| gap_at(s, t) > cfg.fill_gaps_over_ms);
        let sampled = sampled.filter(|_| !in_gap).or_else(|| self.fallback[i].value(&mut self.state[i].fallback, dt_ms));
        let scripted = sampled.map(|v| {
            let v = default + (v - default) * cfg.amplitude;
            let v = if cfg.invert { 1.0 - v } else { v };
            v.clamp(0.0, 1.0)
        });


        let st = &mut self.state[i];
        let provided = cfg.provider.value(&mut st.provider, dt_ms);
        let mut value = match (scripted, provided) {
            (Some(s), Some(p)) => Some(s + (p - s) * cfg.provider_blend),
            (Some(s), None) => Some(s),
            (None, p) => p,
        };

        self.driven[i] = value.is_some() || self.live[i].is_some();


        if value.is_some() {
            st.idle_ms = 0.0;
            st.home_from = st.last;
        } else {
            st.idle_ms += dt_ms;
        }
        let mut in_range = value.map(|v| cfg.min + v * (cfg.max - cfg.min));
        let target_home = cfg.min + default * (cfg.max - cfg.min);
        if in_range.is_none() && cfg.auto_home_delay_ms > 0.0 && st.idle_ms >= cfg.auto_home_delay_ms {
            let u = ((st.idle_ms - cfg.auto_home_delay_ms) / cfg.auto_home_duration_ms.max(1.0)).clamp(0.0, 1.0);
            in_range = Some(st.home_from + (target_home - st.home_from) * smoothstep(u));
        }
        if in_range.is_none() && st.home_from != st.last {
            st.home_from = st.last;
        }


        if let Some(live) = self.live[i] {
            value = Some(live);
            in_range = Some(live);
        }
        let _ = value;
        let mut out = in_range.unwrap_or(st.last);



        if st.ramp_ms < st.ramp_len_ms {
            st.ramp_ms += dt_ms;
            let u = (st.ramp_ms / st.ramp_len_ms).min(1.0);
            let k = if st.ramp_onset { 1.0 - smoothstep(u) } else { (2f64).powf(-10.0 * u) };
            out = out + (st.ramp_from - out) * k;
        }


        if let Some(sl) = &cfg.smart_limit {
            let factor = sl.factor(previous[sl.input.index()] * 100.0);
            out = target_home + (out - target_home) * factor;
        }


        if cfg.speed_limit > 0.0 {
            let max_step = cfg.speed_limit * dt_ms / 1000.0;
            out = st.last + (out - st.last).clamp(-max_step, max_step);
        }

        let out = out.clamp(0.0, 1.0);
        st.last = out;
        out
    }
}

const ELECTRODES: [Axis; 4] = [Axis::E1, Axis::E2, Axis::E3, Axis::E4];

#[derive(Default)]
struct Orbit {
    active: bool,
    last: f64,

    start: f64,

    dir: f64,

    orbit: f64,
    elapsed_ms: f64,

    half_ms: f64,
    seed: u64,
}


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
    use bp_script::Action;

    fn script(pts: &[(f64, f64)]) -> Script {
        Script { actions: pts.iter().map(|(at, pos)| Action { at: *at, pos: *pos }).collect(), ..Default::default() }
    }

    fn settled(m: &mut Mixer) {
        m.sync_ms = 0.0;
        m.resync();
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

        assert!((f[Axis::L0.index()] - 0.65).abs() < 1e-9, "{}", f[0]);

        assert_eq!(f[Axis::R0.index()], 0.5);
    }

    #[test]
    fn speed_limit_caps_the_step() {
        let mut m = Mixer::new();
        settled(&mut m);
        m.set_scripts([(Axis::L0, script(&[(0.0, 0.0), (1.0, 1.0), (5000.0, 1.0)]))]);
        let mut s = AxisSettings::default();
        s.speed_limit = 2.0;
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

        m.set_source(Axis::L0, Some(0.2));
        assert!((m.tick(0.0, 10.0)[0] - 0.2).abs() < 1e-9);

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
        assert_eq!(e, expand::electrodes(f[Axis::EA.index()], f[Axis::EB.index()]));
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
            assert_eq!(electrodes_of(&f), expand::electrodes(f[Axis::EA.index()], f[Axis::EB.index()]));
            max_e2 = max_e2.max(f[Axis::E2.index()].max(f[Axis::E3.index()]));
        }
        assert!(max_e2 > 0.1, "beta's orbit reaches electrodes 2 to 4: {max_e2}");
    }

    #[test]
    fn contrast_lifts_derived_electrodes_but_not_scripted_ones() {
        let mut m = Mixer::new();
        settled(&mut m);
        plain_estim(&mut m);
        m.set_expand_stroke(true);

        m.set_scripts([(Axis::EA, script(&[(0.0, 0.65), (1000.0, 0.65)])), (Axis::EB, script(&[(0.0, 0.5), (1000.0, 0.5)]))]);
        let plain = m.tick(500.0, 10.0)[Axis::E1.index()];
        assert!((plain - 0.3).abs() < 1e-9, "{plain}");
        m.set_electrode_contrast(1.0);
        let lifted = m.tick(500.0, 10.0)[Axis::E1.index()];
        assert!((lifted - 0.3f64.powf(0.25)).abs() < 1e-9, "{lifted}");
        assert_eq!(m.tick(500.0, 10.0)[Axis::E2.index()], 0.0, "the silent electrode stays silent");

        m.set_scripts([(Axis::E1, script(&[(0.0, 0.2), (1000.0, 0.2)]))]);
        assert!((m.tick(500.0, 10.0)[Axis::E1.index()] - 0.2).abs() < 1e-9);
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

        assert!((m.tick(500.0, 10.0)[0] - 0.65).abs() < 1e-9);
        assert!(m.driven()[Axis::L0.index()]);
        m.set_external(Axis::L0, None);

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

        assert!((m.tick(0.0, 10.0)[Axis::C0.index()] - 0.65).abs() < 1e-9);
        assert!(m.driven()[Axis::C0.index()], "a fallback counts as driven");

        assert!((m.tick(1500.0, 10.0)[Axis::C0.index()] - 0.8).abs() < 1e-9);

        assert!((m.tick(3000.0, 10.0)[Axis::C0.index()] - 0.65).abs() < 1e-9);

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
