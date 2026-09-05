use std::f64::consts::PI;

pub const RATE: usize = 22_050;
pub const N_FFT: usize = 1024;
pub const HOP: usize = 441;
pub const BANDS: usize = 80;
const EPS: f64 = 1e-6;
const BINS: usize = N_FFT / 2 + 1;

fn hz_to_mel(f: f64) -> f64 {
    2595.0 * (1.0 + f / 700.0).log10()
}

fn mel_to_hz(m: f64) -> f64 {
    700.0 * (10f64.powf(m / 2595.0) - 1.0)
}



fn filterbank() -> Vec<[f64; BANDS]> {
    let all_freqs: Vec<f64> = (0..BINS).map(|k| k as f64 * (RATE as f64 / 2.0) / (BINS - 1) as f64).collect();
    let (m_min, m_max) = (hz_to_mel(0.0), hz_to_mel(RATE as f64 / 2.0));
    let f_pts: Vec<f64> = (0..BANDS + 2).map(|i| mel_to_hz(m_min + (m_max - m_min) * i as f64 / (BANDS + 1) as f64)).collect();
    let mut fb = vec![[0.0; BANDS]; BINS];
    for (k, &f) in all_freqs.iter().enumerate() {
        for b in 0..BANDS {
            let down = -(f_pts[b] - f) / (f_pts[b + 1] - f_pts[b]);
            let up = (f_pts[b + 2] - f) / (f_pts[b + 2] - f_pts[b + 1]);
            fb[k][b] = down.min(up).max(0.0);
        }
    }
    fb
}


pub fn log_mel(samples: &[f32]) -> Vec<[f32; BANDS]> {
    if samples.is_empty() {
        return Vec::new();
    }
    let frames = 1 + samples.len() / HOP;
    let half = N_FFT / 2;

    let at = |i: isize| -> f64 {
        let n = samples.len() as isize;
        let i = if i < 0 { -i } else if i >= n { 2 * (n - 1) - i } else { i };
        samples[i.clamp(0, n - 1) as usize] as f64
    };
    let window: Vec<f64> = (0..N_FFT).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f64 / N_FFT as f64).cos()).collect();
    let fb = filterbank();
    let mut buf = vec![0.0f64; N_FFT];
    let mut power = vec![0.0f64; BINS];
    let mut rows: Vec<[f64; BANDS]> = Vec::with_capacity(frames);
    for t in 0..frames {
        let start = (t * HOP) as isize - half as isize;
        for i in 0..N_FFT {
            buf[i] = at(start + i as isize) * window[i];
        }
        bp_beat::power_spectrum(&buf, &mut power);
        let mut row = [0.0; BANDS];
        for (k, p) in power.iter().enumerate() {
            if *p == 0.0 {
                continue;
            }
            for b in 0..BANDS {
                row[b] += p * fb[k][b];
            }
        }
        for v in &mut row {
            *v = (*v + EPS).ln();
        }
        rows.push(row);
    }
    let n = (rows.len() * BANDS) as f64;
    let mean = rows.iter().flatten().sum::<f64>() / n;

    let var = rows.iter().flatten().map(|v| (v - mean) * (v - mean)).sum::<f64>() / (n - 1.0).max(1.0);
    let std = if var > 0.0 { var.sqrt() } else { 1.0 };
    rows.into_iter().map(|r| std::array::from_fn(|b| ((r[b] - mean) / std) as f32)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Fixture {
        seconds: f64,
        rows: Vec<Vec<f32>>,
    }


    pub(crate) fn synthetic(seconds: f64) -> Vec<f32> {
        let n = (seconds * RATE as f64) as usize;
        let mut seed: u32 = 12345;
        (0..n)
            .map(|i| {
                let t = i as f64 / RATE as f64;
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                let noise = ((seed >> 9) as f64 / (1u32 << 23) as f64 - 1.0) * 0.02;
                let v = 0.5 * (2.0 * PI * 220.0 * t).sin() + 0.3 * (2.0 * PI * (1000.0 + 400.0 * t) * t).sin() + 0.1 * (2.0 * PI * 5000.0 * t).sin() + noise;
                (v * if t > 1.0 { 0.4 } else { 1.0 }) as f32
            })
            .collect()
    }

    #[test]
    fn matches_torchaudio_within_a_thousandth() {
        let f: Fixture = serde_json::from_str(include_str!("../fixtures/mel.json")).unwrap();
        let rows = log_mel(&synthetic(f.seconds));
        assert_eq!(rows.len(), f.rows.len());
        let mut worst = 0.0f32;
        for (got, want) in rows.iter().zip(&f.rows) {
            for (g, w) in got.iter().zip(want) {
                worst = worst.max((g - w).abs());
            }
        }
        assert!(worst < 1e-3, "worst difference {worst}");
    }

    #[test]
    fn frame_count_and_normalisation() {
        let rows = log_mel(&vec![0.1; RATE]);
        assert_eq!(rows.len(), 1 + RATE / HOP);
        let mean: f32 = rows.iter().flatten().sum::<f32>() / (rows.len() * BANDS) as f32;
        assert!(mean.abs() < 1e-4);
        assert!(log_mel(&[]).is_empty());
    }
}
