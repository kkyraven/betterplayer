//! Keyframe interpolation. Pchip is the default because OSR firmware interpolates linearly
//! between the last two commands, so resampling a smooth curve at the tick rate is what
//! removes the jerk at fast keyframes (research 06).

use crate::funscript::{Action, Script};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Interpolation {
    Step,
    #[default]
    Linear,
    Pchip,
}

impl Interpolation {
    pub fn from_str(s: &str) -> Option<Interpolation> {
        match s {
            "step" => Some(Interpolation::Step),
            "linear" => Some(Interpolation::Linear),
            "pchip" => Some(Interpolation::Pchip),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Interpolation::Step => "step",
            Interpolation::Linear => "linear",
            Interpolation::Pchip => "pchip",
        }
    }
}

/// Script value at `t_ms`, or `None` outside the script (before the first or after the last
/// action), so the caller can fill with a provider or the axis default.
pub fn sample(script: &Script, t_ms: f64, kind: Interpolation) -> Option<f64> {
    let a = &script.actions;
    let i = script.index_at(t_ms)?;
    let p0 = a[i];
    if t_ms > script.duration_ms() {
        return None;
    }
    let Some(p1) = a.get(i + 1) else { return Some(p0.pos) };
    let h = p1.at - p0.at;
    if h <= 0.0 {
        return Some(p1.pos);
    }
    let u = (t_ms - p0.at) / h;
    Some(match kind {
        Interpolation::Step => p0.pos,
        Interpolation::Linear => p0.pos + (p1.pos - p0.pos) * u,
        Interpolation::Pchip => {
            let d0 = slope(i.checked_sub(1).map(|j| &a[j]), p0, *p1, a.get(i + 2).copied());
            let d1 = slope(Some(&p0), *p1, a.get(i + 2).copied().unwrap_or(*p1), None);
            hermite(p0.pos, p1.pos, d0 * h, d1 * h, u).clamp(0.0, 1.0)
        }
    })
}

/// Fritsch and Carlson monotone slope at `p` given its neighbours. Without a previous
/// keyframe the three-point end formula is used; without a second next one, the secant.
fn slope(prev: Option<&Action>, p: Action, next: Action, next2: Option<Action>) -> f64 {
    let delta = |a: Action, b: Action| {
        let h = b.at - a.at;
        if h > 0.0 { (b.pos - a.pos) / h } else { 0.0 }
    };
    match prev {
        Some(prev) => interior(prev.at, p.at, next.at, delta(*prev, p), delta(p, next)),
        None => {
            let d0 = delta(p, next);
            match next2 {
                Some(n2) => {
                    let h0 = next.at - p.at;
                    let h1 = n2.at - next.at;
                    let d1 = delta(next, n2);
                    endpoint(h0, h1, d0, d1)
                }
                None => d0,
            }
        }
    }
}

fn interior(x0: f64, x1: f64, x2: f64, d0: f64, d1: f64) -> f64 {
    if d0 == 0.0 || d1 == 0.0 || (d0 > 0.0) != (d1 > 0.0) {
        return 0.0;
    }
    let h0 = x1 - x0;
    let h1 = x2 - x1;
    let w0 = 2.0 * h1 + h0;
    let w1 = h1 + 2.0 * h0;
    (w0 + w1) / (w0 / d0 + w1 / d1)
}

fn endpoint(h0: f64, h1: f64, d0: f64, d1: f64) -> f64 {
    if h0 + h1 <= 0.0 {
        return d0;
    }
    let d = ((2.0 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if d.signum() != d0.signum() {
        0.0
    } else if d0.signum() != d1.signum() && d.abs() > 3.0 * d0.abs() {
        3.0 * d0
    } else {
        d
    }
}

fn hermite(y0: f64, y1: f64, m0: f64, m1: f64, u: f64) -> f64 {
    let u2 = u * u;
    let u3 = u2 * u;
    (2.0 * u3 - 3.0 * u2 + 1.0) * y0 + (u3 - 2.0 * u2 + u) * m0 + (-2.0 * u3 + 3.0 * u2) * y1 + (u3 - u2) * m1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(pts: &[(f64, f64)]) -> Script {
        Script { actions: pts.iter().map(|(at, pos)| Action { at: *at, pos: *pos }).collect(), ..Default::default() }
    }

    #[test]
    fn outside_is_none_and_edges_hold() {
        let s = script(&[(100.0, 0.0), (200.0, 1.0)]);
        assert_eq!(sample(&s, 50.0, Interpolation::Linear), None);
        assert_eq!(sample(&s, 100.0, Interpolation::Linear), Some(0.0));
        assert_eq!(sample(&s, 150.0, Interpolation::Linear), Some(0.5));
        assert_eq!(sample(&s, 150.0, Interpolation::Step), Some(0.0));
        assert_eq!(sample(&s, 200.0, Interpolation::Linear), Some(1.0));
        assert_eq!(sample(&s, 201.0, Interpolation::Linear), None);
    }

    #[test]
    fn pchip_passes_through_keyframes_and_never_overshoots() {
        let s = script(&[(0.0, 0.0), (100.0, 1.0), (200.0, 1.0), (300.0, 0.2), (400.0, 0.9)]);
        for a in &s.actions {
            assert!((sample(&s, a.at, Interpolation::Pchip).unwrap() - a.pos).abs() < 1e-9);
        }
        let mut t = 0.0;
        while t <= 400.0 {
            let v = sample(&s, t, Interpolation::Pchip).unwrap();
            assert!((0.0..=1.0).contains(&v), "t {t} v {v}");
            t += 1.0;
        }
        // Flat span stays flat (monotone: no bump between two equal keyframes).
        assert!((sample(&s, 150.0, Interpolation::Pchip).unwrap() - 1.0).abs() < 1e-9);
        // Curve is smooth: midpoint of a rise is near the linear value, not at a keyframe.
        let mid = sample(&s, 50.0, Interpolation::Pchip).unwrap();
        assert!(mid > 0.3 && mid < 0.7, "mid {mid}");
    }
}
