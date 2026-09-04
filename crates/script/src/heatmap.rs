//! Speed statistics for cards and the scrubber. Speed is in position units (0..100) per
//! second, the number funscript tools show, so 400 reads as "fast" everywhere.

use crate::funscript::Script;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SpeedStats {
    pub average: f64,
    pub max: f64,
}

/// Time-weighted average speed per bucket across the media duration.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Heatmap {
    pub buckets: Vec<f64>,
}

pub fn speed_stats(script: &Script) -> SpeedStats {
    let mut total = 0.0;
    let mut time = 0.0;
    let mut max: f64 = 0.0;
    for w in script.actions.windows(2) {
        let dt = w[1].at - w[0].at;
        if dt <= 0.0 {
            continue;
        }
        let speed = (w[1].pos - w[0].pos).abs() * 100.0 / (dt / 1000.0);
        total += speed * dt;
        time += dt;
        max = max.max(speed);
    }
    SpeedStats { average: if time > 0.0 { total / time } else { 0.0 }, max }
}

/// `n` buckets spanning `0..duration_ms` (the media length, so gaps read as gaps).
pub fn heatmap(script: &Script, duration_ms: f64, n: usize) -> Heatmap {
    let mut buckets = vec![0.0; n];
    if n == 0 || duration_ms <= 0.0 {
        return Heatmap { buckets };
    }
    let bucket_ms = duration_ms / n as f64;
    let mut weights = vec![0.0; n];
    for w in script.actions.windows(2) {
        let (a, b) = (w[0], w[1]);
        let dt = b.at - a.at;
        if dt <= 0.0 {
            continue;
        }
        let speed = (b.pos - a.pos).abs() * 100.0 / (dt / 1000.0);
        let first = ((a.at / bucket_ms).floor() as usize).min(n - 1);
        let last = ((b.at / bucket_ms).floor() as usize).min(n - 1);
        for i in first..=last {
            let lo = a.at.max(i as f64 * bucket_ms);
            let hi = b.at.min((i + 1) as f64 * bucket_ms);
            let overlap = (hi - lo).max(0.0);
            buckets[i] += speed * overlap;
            weights[i] += overlap;
        }
    }
    for (b, w) in buckets.iter_mut().zip(weights) {
        if w > 0.0 {
            *b /= w;
        }
    }
    Heatmap { buckets }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::funscript::Action;

    #[test]
    fn stats_and_buckets() {
        let s = Script {
            actions: vec![Action { at: 0.0, pos: 0.0 }, Action { at: 500.0, pos: 1.0 }, Action { at: 1000.0, pos: 1.0 }],
            ..Default::default()
        };
        let st = speed_stats(&s);
        assert_eq!(st.max, 200.0);
        assert_eq!(st.average, 100.0);
        let h = heatmap(&s, 2000.0, 4);
        assert_eq!(h.buckets, vec![200.0, 0.0, 0.0, 0.0]);
    }
}
