//! Dense head output to keyframes, ported function for function from `ml/decoder.py`: smooth
//! by the pace's time constant, take troughs and peaks from the event logits with non-maximum
//! suppression, keyframe them at the smoothed position, keep whatever the simplification says
//! is left of the drift between them, and emit nothing inside a long inactive run. The two
//! must agree keyframe for keyframe; the fixture test holds them to it.
//!
//! `Smoother` and `ActiveGate` are the same smoothing and gate one frame at a time, for the
//! live path, which plays the smoothed position and releases the axis when it goes quiet.

use bp_script::{Action, rdp_indices};

/// Ramer-Douglas-Peucker tolerance in position units, the engine's `SIMPLIFY_EPS`.
pub const RDP_EPS: f64 = 0.01;

/// Everything the decoder can be tuned by. `Meta::decode_config` fills it from an export.
#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(serde::Deserialize))]
pub struct DecodeConfig {
    pub tau_ms: f64,
    /// Probability an event logit must reach.
    pub event_threshold: f64,
    /// Half width of the suppression window, in frames.
    pub nms_frames: usize,
    pub rdp_eps: f64,
    /// An axis under this active probability for longer than the hold emits nothing there.
    pub active_threshold: f64,
    pub active_hold_ms: f64,
    /// Depth trim: the position is stretched about its own running centre by this gain and
    /// clipped to 0..1. 1.0 is the model's own depth. An export publishes it as
    /// `decode.amplitude`; a five-way average strokes shallower than its members and ships 1.5.
    pub amplitude: f64,
    /// Time constant of the running centre the trim stretches about.
    pub centre_tau_ms: f64,
}

/// The running centre's time constant when the export does not say.
pub const CENTRE_TAU_MS: f64 = 4000.0;

impl Default for DecodeConfig {
    fn default() -> DecodeConfig {
        DecodeConfig {
            tau_ms: 0.0,
            event_threshold: 0.5,
            nms_frames: 4,
            rdp_eps: RDP_EPS,
            active_threshold: 0.3,
            active_hold_ms: 2000.0,
            amplitude: 1.0,
            centre_tau_ms: CENTRE_TAU_MS,
        }
    }
}

/// Lowest energy the row's intensity is read at, so a stepper at 0 does not divide by zero.
pub const ENERGY_MIN: f64 = 0.25;

impl DecodeConfig {
    /// The row's Intensity applied as energy, 1.0 being this config unchanged: how willing the
    /// axis is to move fast and to keep moving. Twice the energy halves the output smoothing,
    /// so a stroke keeps its edges instead of gliding; holds the axis twice as long after the
    /// model goes quiet; and asks half the evidence before calling it active. It never touches
    /// depth. Kept moderate on purpose: it is not a speed control.
    pub fn energised(self, intensity: f64) -> DecodeConfig {
        let e = intensity.max(ENERGY_MIN);
        DecodeConfig {
            tau_ms: self.tau_ms / e,
            active_hold_ms: self.active_hold_ms * e,
            active_threshold: (self.active_threshold * (1.5 - 0.5 * e)).clamp(0.05, 0.95),
            ..self
        }
    }
}

/// Numerically stable logistic.
pub fn sigmoid(x: f64) -> f64 {
    if x >= 0.0 { 1.0 / (1.0 + (-x).exp()) } else { x.exp() / (1.0 + x.exp()) }
}

/// One-pole smoothing stepped by the real frame interval, so a variable frame rate smooths by
/// time and not by frame count. `tau_ms` 0 returns the input untouched.
pub fn smooth(time_ms: &[f64], pos: &[f64], tau_ms: f64) -> Vec<f64> {
    if tau_ms <= 0.0 || pos.is_empty() {
        return pos.to_vec();
    }
    let mut out = Vec::with_capacity(pos.len());
    let mut acc = pos[0];
    let mut last = time_ms[0];
    for (t, p) in time_ms.iter().zip(pos) {
        let alpha = 1.0 - (-(t - last).max(0.0) / tau_ms).exp();
        acc += alpha * (p - acc);
        out.push(acc);
        last = *t;
    }
    out
}

/// One step of the depth trim: the position stretched about its running centre by `gain` and
/// clipped, `scale_amplitude` one frame at a time for the live path.
pub fn trim_step(centre: f64, pos: f64, gain: f64) -> f64 {
    (centre + gain * (pos - centre)).clamp(0.0, 1.0)
}

/// Stretch a dense position about its own slow centre by `gain`, clipped to 0..1: the centre is
/// the signal smoothed over `centre_tau_ms`, so a stroke gets deeper without the axis drifting
/// off its resting level. `gain` 1.0 is the identity. Mirrors `decoder.scale_amplitude`.
pub fn scale_amplitude(time_ms: &[f64], pos: &[f64], gain: f64, centre_tau_ms: f64) -> Vec<f64> {
    if gain == 1.0 || pos.is_empty() {
        return pos.to_vec();
    }
    let centre = smooth(time_ms, pos, centre_tau_ms);
    centre.iter().zip(pos).map(|(&c, &p)| trim_step(c, p, gain)).collect()
}

/// The position the decoder works on and the device plays: the depth trim, then the pace's
/// output smoothing. Mirrors `decoder.dense_signal`, so events and keyframes never come off
/// different signals.
pub fn dense_signal(time_ms: &[f64], pos: &[f64], config: &DecodeConfig) -> Vec<f64> {
    let scaled = scale_amplitude(time_ms, pos, config.amplitude, config.centre_tau_ms);
    smooth(time_ms, &scaled, config.tau_ms)
}

/// Frames where an event logit passes the threshold, thinned by non-maximum suppression over
/// plus or minus `nms` frames: the strongest frame wins its neighbourhood, ties to the earlier
/// frame, so a broad bump becomes one event. Sorted.
pub fn pick_events(logits: &[f64], threshold: f64, nms: usize) -> Vec<usize> {
    let p: Vec<f64> = logits.iter().map(|&l| sigmoid(l)).collect();
    let mut candidates: Vec<usize> = (0..p.len()).filter(|&i| p[i] >= threshold).collect();
    if candidates.is_empty() {
        return candidates;
    }
    candidates.sort_by(|&a, &b| p[b].total_cmp(&p[a]).then(a.cmp(&b)));
    let mut blocked = vec![false; p.len()];
    let mut kept = Vec::new();
    for i in candidates {
        if blocked[i] {
            continue;
        }
        kept.push(i);
        for b in blocked.iter_mut().take((i + nms + 1).min(p.len())).skip(i.saturating_sub(nms)) {
            *b = true;
        }
    }
    kept.sort_unstable();
    kept
}

/// Frames inside a run where the active probability stayed under the threshold for longer
/// than the hold. Shorter dips are not silence, they are the top of a slow stroke.
fn inactive_runs(time_ms: &[f64], active: &[f64], config: &DecodeConfig) -> Vec<bool> {
    let quiet: Vec<bool> = active.iter().map(|&a| sigmoid(a) < config.active_threshold).collect();
    let mut out = vec![false; quiet.len()];
    let mut lo = 0;
    while lo < quiet.len() {
        let mut hi = lo + 1;
        while hi < quiet.len() && quiet[hi] == quiet[lo] {
            hi += 1;
        }
        if quiet[lo] && time_ms[hi - 1] - time_ms[lo] > config.active_hold_ms {
            out[lo..hi].fill(true);
        }
        lo = hi;
    }
    out
}

/// Dense head output to keyframes for one axis. `trough`, `peak` and `active` are logits;
/// `active` is `None` to gate nothing. (The Python's no-logit path, a tracker's extrema through
/// scipy's `find_peaks`, is for baselines and has no twin here: both models emit the logits.)
pub fn decode_axis(time_ms: &[f64], pos: &[f64], trough: &[f64], peak: &[f64], active: Option<&[f64]>, config: &DecodeConfig) -> Vec<Action> {
    let n = pos.len();
    if n == 0 {
        return Vec::new();
    }
    let y = dense_signal(time_ms, pos, config);
    let mut edges: Vec<usize> = vec![0, n - 1];
    edges.extend(pick_events(trough, config.event_threshold, config.nms_frames));
    edges.extend(pick_events(peak, config.event_threshold, config.nms_frames));
    edges.sort_unstable();
    edges.dedup();
    let mut keep = vec![false; n];
    for &e in &edges {
        keep[e] = true;
    }
    for w in edges.windows(2) {
        let (a, b) = (w[0], w[1]);
        if b > a + 1 {
            for i in rdp_indices(&time_ms[a..=b], &y[a..=b], config.rdp_eps) {
                keep[a + i] = true;
            }
        }
    }
    let quiet = active.map(|a| inactive_runs(time_ms, a, config));
    (0..n).filter(|&i| keep[i] && !quiet.as_ref().is_some_and(|q| q[i])).map(|i| Action { at: time_ms[i], pos: y[i] }).collect()
}

/// The decoder's smoothing one frame at a time: the same one-pole filter by real time.
#[derive(Clone, Copy, Debug, Default)]
pub struct Smoother {
    state: Option<(f64, f64)>,
}

impl Smoother {
    pub fn reset(&mut self) {
        self.state = None;
    }

    pub fn push(&mut self, time_ms: f64, pos: f64, tau_ms: f64) -> f64 {
        let out = match self.state {
            Some((last_t, acc)) if tau_ms > 0.0 => {
                let alpha = 1.0 - (-(time_ms - last_t).max(0.0) / tau_ms).exp();
                acc + alpha * (pos - acc)
            }
            _ => pos,
        };
        self.state = Some((time_ms, out));
        out
    }
}

/// The active gate one frame at a time: released once the probability has been under the
/// threshold for longer than the hold, back the moment it rises. Mirrors `inactive_runs` as
/// far as a causal reading can: the batch decoder knows a run's whole length, this only its
/// past, so the live path holds through the first `active_hold_ms` of a quiet run.
#[derive(Clone, Copy, Debug, Default)]
pub struct ActiveGate {
    quiet_since: Option<f64>,
}

impl ActiveGate {
    pub fn reset(&mut self) {
        self.quiet_since = None;
    }

    /// Whether the axis is active on this frame.
    pub fn push(&mut self, time_ms: f64, active_logit: f64, config: &DecodeConfig) -> bool {
        if sigmoid(active_logit) >= config.active_threshold {
            self.quiet_since = None;
            return true;
        }
        let since = *self.quiet_since.get_or_insert(time_ms);
        time_ms - since <= config.active_hold_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[test]
    fn energy_scales_smoothing_and_the_gate_but_never_depth() {
        let base = DecodeConfig { tau_ms: 120.0, ..DecodeConfig::default() };
        let same = base.energised(1.0);
        assert_eq!(same, base);
        let lively = base.energised(2.0);
        assert_eq!(lively.tau_ms, 60.0);
        assert_eq!(lively.active_hold_ms, 4000.0);
        assert!((lively.active_threshold - 0.15).abs() < 1e-12);
        let lazy = base.energised(0.5);
        assert_eq!(lazy.tau_ms, 240.0);
        assert_eq!(lazy.active_hold_ms, 1000.0);
        // Zero on the stepper is read at the floor rather than dividing by it.
        assert_eq!(base.energised(0.0).tau_ms, 120.0 / ENERGY_MIN);
        assert_eq!(lively.event_threshold, base.event_threshold);
    }

    #[test]
    fn the_trim_stretches_about_the_running_centre_and_clips() {
        let t: Vec<f64> = (0..200).map(|i| i as f64 * 33.0).collect();
        // A square wave 0.4..0.6 about 0.5: with a long centre the stretch is symmetric.
        let pos: Vec<f64> = t.iter().map(|&x| if (x / 500.0) as i64 % 2 == 0 { 0.4 } else { 0.6 }).collect();
        assert_eq!(scale_amplitude(&t, &pos, 1.0, CENTRE_TAU_MS), pos);
        let deep = scale_amplitude(&t, &pos, 2.0, 1.0e12);
        // The centre is pinned at the first sample (0.4) by the huge time constant, so the
        // stretch is about 0.4: 0.4 stays, 0.6 becomes 0.8.
        assert!((deep[0] - 0.4).abs() < 1e-6 && (deep[16] - 0.8).abs() < 1e-6, "{:?}", &deep[..20]);
        let clipped = scale_amplitude(&t, &pos, 10.0, 1.0e12);
        assert_eq!(clipped[16], 1.0);
        // Streaming form is the batch form.
        let mut centre = Smoother::default();
        let live: Vec<f64> = t.iter().zip(&pos).map(|(&t, &p)| trim_step(centre.push(t, p, 300.0), p, 1.5)).collect();
        assert_eq!(live, scale_amplitude(&t, &pos, 1.5, 300.0));
    }

    #[test]
    fn events_pass_the_threshold_and_survive_suppression() {
        let mut logits = vec![-5.0; 40];
        logits[10] = 1.0;
        logits[11] = 3.0;
        logits[12] = 2.0;
        logits[30] = 0.5;
        assert_eq!(pick_events(&logits, 0.5, 3), vec![11, 30]);
        assert!(pick_events(&vec![-5.0; 40], 0.5, 3).is_empty());
    }

    #[test]
    fn smoothing_follows_a_step_by_its_time_constant() {
        let t: Vec<f64> = (0..100).map(|i| i as f64 * 10.0).collect();
        let step: Vec<f64> = t.iter().map(|&x| if x >= 100.0 { 1.0 } else { 0.0 }).collect();
        let y = smooth(&t, &step, 100.0);
        // The frame the step arrives on is itself smoothed: 11 steps of 10 ms by 200 ms.
        assert!((y[20] - (1.0 - (-1.1f64).exp())).abs() < 1e-12);
        assert_eq!(smooth(&t, &step, 0.0), step);
        let mut s = Smoother::default();
        let live: Vec<f64> = t.iter().zip(&step).map(|(&t, &p)| s.push(t, p, 100.0)).collect();
        assert_eq!(live, y, "the streaming filter is the batch one");
    }

    #[test]
    fn the_gate_releases_after_the_hold_and_returns_at_once() {
        let config = DecodeConfig::default();
        let mut g = ActiveGate::default();
        assert!(g.push(0.0, 5.0, &config));
        assert!(g.push(100.0, -5.0, &config), "a dip is not silence yet");
        assert!(g.push(2000.0, -5.0, &config));
        assert!(!g.push(2101.0, -5.0, &config));
        assert!(g.push(2200.0, 5.0, &config));
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        config: DecodeConfig,
        time_ms: Vec<f64>,
        pos: Vec<f64>,
        trough: Vec<f64>,
        peak: Vec<f64>,
        active: Option<Vec<f64>>,
        expected: Vec<[f64; 2]>,
    }

    /// `ml/fixtures.py` writes the cases; the keyframes must match to the millisecond and the
    /// position to 1e-9.
    #[test]
    fn matches_the_python_decoder_keyframe_for_keyframe() {
        let cases: Vec<Case> = serde_json::from_str(include_str!("../fixtures/decoder.json")).unwrap();
        assert!(cases.len() >= 10);
        for c in cases {
            let got = decode_axis(&c.time_ms, &c.pos, &c.trough, &c.peak, c.active.as_deref(), &c.config);
            assert_eq!(got.len(), c.expected.len(), "{}: {} keyframes, expected {}", c.name, got.len(), c.expected.len());
            for (g, e) in got.iter().zip(&c.expected) {
                assert!((g.at - e[0]).abs() < 1e-6 && (g.pos - e[1]).abs() < 1e-9, "{}: {:?} vs {:?}", c.name, g, e);
            }
        }
    }
}
