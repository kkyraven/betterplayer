use crate::funscript::{Action, Script};


const RATE_HZ: f64 = 25.0;


pub fn stroke_to_alpha_beta(stroke: &Script) -> (Script, Script) {
    let mut alpha = Vec::new();
    let mut beta = Vec::new();
    let ext = extrema(&stroke.actions);
    let mut dir = 1.0;
    for (seg, w) in ext.windows(2).enumerate() {
        let (a, b) = (stroke.actions[w[0]], stroke.actions[w[1]]);
        if hash(seg as u64) % 10 == 0 {
            dir = -dir;
        }
        let c = (a.pos + b.pos) / 2.0;
        let r = (a.pos - b.pos) / 2.0;
        let dur = b.at - a.at;
        let n = ((dur / 1000.0 * RATE_HZ).round() as usize).max(2);
        for k in 0..n {
            let u = k as f64 / n as f64;
            let theta = std::f64::consts::PI * u;
            let at = a.at + dur * u;
            alpha.push(Action { at, pos: (c + r * theta.cos()).clamp(0.0, 1.0) });
            beta.push(Action { at, pos: (0.5 + r * dir * theta.sin()).clamp(0.0, 1.0) });
        }
    }
    if let Some(last) = ext.last().map(|&i| stroke.actions[i]) {
        alpha.push(Action { at: last.at, pos: last.pos });
        beta.push(Action { at: last.at, pos: 0.5 });
    }
    (Script { actions: alpha, ..Default::default() }, Script { actions: beta, ..Default::default() })
}





pub fn electrodes(alpha: f64, beta: f64) -> [f64; 4] {
    let a = 2.0 * alpha - 1.0;
    let b = 2.0 * beta - 1.0;
    let s8 = 8f64.sqrt();
    let mut e = [a, -a / 3.0 + s8 / 3.0 * b, -a / 3.0 - s8 / 6.0 * b, -a / 3.0 - s8 / 6.0 * b];
    let mut min = 0;
    for i in 1..4 {
        if e[i].abs() < e[min].abs() {
            min = i;
        }
    }
    let shift = e[min];
    for v in &mut e {
        *v = ((*v - shift).abs() / (4.0 / 3.0)).min(1.0);
    }
    e
}




pub fn contrast(e: [f64; 4], contrast: f64) -> [f64; 4] {
    let gamma = 1.0 - 0.75 * contrast.clamp(0.0, 1.0);
    e.map(|v| v.clamp(0.0, 1.0).powf(gamma))
}



fn extrema(actions: &[Action]) -> Vec<usize> {
    let mut out = Vec::new();
    if actions.is_empty() {
        return out;
    }
    out.push(0);
    let mut last_dir = 0.0;
    for i in 1..actions.len() {
        let d = (actions[i].pos - actions[i - 1].pos).signum();
        if d != 0.0 && last_dir != 0.0 && d != last_dir {
            out.push(i - 1);
        }
        if d != 0.0 {
            last_dir = d;
        }
    }
    if actions.len() > 1 {
        out.push(actions.len() - 1);
    }
    out.dedup();
    out
}

fn hash(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(pts: &[(f64, f64)]) -> Script {
        Script { actions: pts.iter().map(|(at, pos)| Action { at: *at, pos: *pos }).collect(), ..Default::default() }
    }

    #[test]
    fn half_circles_between_extrema() {
        let s = script(&[(0.0, 1.0), (1000.0, 0.0), (2000.0, 1.0)]);
        let (alpha, beta) = stroke_to_alpha_beta(&s);
        assert_eq!(alpha.actions.len(), beta.actions.len());
        assert_eq!(alpha.actions.first().unwrap().pos, 1.0);
        assert_eq!(alpha.actions.last().unwrap().pos, 1.0);
        assert_eq!(alpha.duration_ms(), 2000.0);

        let mid = alpha.actions.iter().position(|a| (a.at - 500.0).abs() <= 20.0).unwrap();
        assert!((alpha.actions[mid].pos - 0.5).abs() < 0.05, "{}", alpha.actions[mid].pos);
        assert!((beta.actions[mid].pos - 0.5).abs() > 0.45, "{}", beta.actions[mid].pos);

        for a in beta.actions.iter().filter(|a| a.at == 0.0 || a.at == 1000.0 || a.at == 2000.0) {
            assert!((a.pos - 0.5).abs() < 1e-9);
        }
        assert!(beta.actions.iter().all(|a| (0.0..=1.0).contains(&a.pos)));
    }

    #[test]
    fn electrodes_match_restim_reference_values() {

        let rows: [((f64, f64), [f64; 4]); 5] = [
            ((1.0, 0.0), [1.0, 0.0, 0.0, 0.0]),
            ((0.0, 1.0), [0.0, 0.707, 0.354, 0.354]),
            ((0.5, 0.5), [0.146, 0.0, 0.530, 0.530]),
            ((0.5, -0.5), [0.323, 0.530, 0.0, 0.0]),
            ((0.0, 0.0), [0.0, 0.0, 0.0, 0.0]),
        ];
        for ((a, b), want) in rows {
            let got = electrodes((a + 1.0) / 2.0, (b + 1.0) / 2.0);
            for i in 0..4 {
                assert!((got[i] - want[i]).abs() < 1e-3, "({a}, {b}) e{}: {} vs {}", i + 1, got[i], want[i]);
            }
        }

        assert_eq!(electrodes(0.8, 0.3), electrodes(0.2, 0.7));
    }

    #[test]
    fn electrodes_stay_in_range_with_one_at_zero() {
        for i in 0..=40 {
            for j in 0..=40 {
                let (alpha, beta) = (i as f64 / 40.0, j as f64 / 40.0);
                let e = electrodes(alpha, beta);
                assert!(e.iter().all(|v| (0.0..=1.0).contains(v)), "{alpha} {beta} {e:?}");
                assert!(e.iter().any(|v| *v == 0.0), "{alpha} {beta} {e:?}");
                assert!((e[2] - e[3]).abs() < 1e-12, "gamma at the centre: e3 and e4 match");
            }
        }
    }

    #[test]
    fn contrast_lifts_the_middle_and_keeps_the_ends() {
        let e = [0.0, 0.3, 0.6, 1.0];
        assert_eq!(contrast(e, 0.0), e, "no contrast plays the decomposition as is");
        let up = contrast(e, 1.0);
        assert_eq!(up[0], 0.0, "silent stays silent");
        assert!((up[3] - 1.0).abs() < 1e-12);
        assert!(up[1] > 0.7 && up[2] > 0.85, "{up:?}");
        assert!(up[1] < up[2], "still in order");
        let half = contrast(e, 0.5);
        assert!(half[1] > e[1] && half[1] < up[1]);
        assert_eq!(contrast(e, 2.0), up, "clamped");
    }

    #[test]
    fn extrema_skip_flat_runs_and_empty_is_empty() {
        let s = script(&[(0.0, 0.0), (100.0, 0.5), (200.0, 0.5), (300.0, 1.0), (400.0, 0.2)]);
        assert_eq!(extrema(&s.actions), vec![0, 3, 4]);
        let (a, b) = stroke_to_alpha_beta(&Script::default());
        assert!(a.is_empty() && b.is_empty());
    }
}
