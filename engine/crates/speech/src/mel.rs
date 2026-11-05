use std::f64::consts::PI;

pub const RATE: usize = 16_000;
pub const MELS: usize = 80;
pub const FRAMES: usize = 3000;
pub const SAMPLES: usize = 480_000;
const N_FFT: usize = 400;
const HOP: usize = 160;
const BINS: usize = N_FFT / 2 + 1;
const FLOOR: f32 = -10.0;

pub struct Mel {
    filters: Vec<f32>,
    cos: Vec<f32>,
    sin: Vec<f32>,
}

fn hz_to_mel(f: f64) -> f64 {
    let (f_sp, min_log_hz) = (200.0 / 3.0, 1000.0);
    let logstep = 6.4f64.ln() / 27.0;
    if f >= min_log_hz { min_log_hz / f_sp + (f / min_log_hz).ln() / logstep } else { f / f_sp }
}

fn mel_to_hz(m: f64) -> f64 {
    let (f_sp, min_log_hz) = (200.0 / 3.0, 1000.0);
    let (min_log_mel, logstep) = (min_log_hz / f_sp, 6.4f64.ln() / 27.0);
    if m >= min_log_mel { min_log_hz * (logstep * (m - min_log_mel)).exp() } else { f_sp * m }
}

fn filterbank() -> Vec<f32> {
    let freqs: Vec<f64> = (0..BINS).map(|k| k as f64 * RATE as f64 / N_FFT as f64).collect();
    let (lo, hi) = (hz_to_mel(0.0), hz_to_mel(RATE as f64 / 2.0));
    let pts: Vec<f64> = (0..MELS + 2).map(|i| mel_to_hz(lo + (hi - lo) * i as f64 / (MELS + 1) as f64)).collect();
    let mut fb = vec![0.0f32; MELS * BINS];
    for m in 0..MELS {
        let enorm = 2.0 / (pts[m + 2] - pts[m]);
        for (k, &f) in freqs.iter().enumerate() {
            let lower = (f - pts[m]) / (pts[m + 1] - pts[m]);
            let upper = (pts[m + 2] - f) / (pts[m + 2] - pts[m + 1]);
            fb[m * BINS + k] = (lower.min(upper).max(0.0) * enorm) as f32;
        }
    }
    fb
}

impl Mel {
    pub fn new() -> Mel {
        let mut cos = vec![0.0f32; BINS * N_FFT];
        let mut sin = vec![0.0f32; BINS * N_FFT];
        for k in 0..BINS {
            for n in 0..N_FFT {
                let w = 0.5 - 0.5 * (2.0 * PI * n as f64 / N_FFT as f64).cos();
                let phase = 2.0 * PI * ((k * n) % N_FFT) as f64 / N_FFT as f64;
                cos[k * N_FFT + n] = (w * phase.cos()) as f32;
                sin[k * N_FFT + n] = (w * phase.sin()) as f32;
            }
        }
        Mel { filters: filterbank(), cos, sin }
    }

    pub fn features(&self, audio: &[f32]) -> Vec<f32> {
        let audio = &audio[..audio.len().min(SAMPLES)];
        let n = audio.len() as isize;
        let at = |i: isize| -> f32 {
            let i = if i < 0 { -i } else if i >= SAMPLES as isize { 2 * (SAMPLES as isize - 1) - i } else { i };
            if i < n { audio[i as usize] } else { 0.0 }
        };
        let mut out = vec![FLOOR; MELS * FRAMES];
        let mut frame = [0.0f32; N_FFT];
        let mut power = [0.0f32; BINS];
        let mut peak = FLOOR;
        for t in 0..FRAMES {
            let start = (t * HOP) as isize - (N_FFT / 2) as isize;
            if start >= n && start + (N_FFT as isize) < SAMPLES as isize {
                continue;
            }
            for (i, s) in frame.iter_mut().enumerate() {
                *s = at(start + i as isize);
            }
            for (k, p) in power.iter_mut().enumerate() {
                let (c, s) = (&self.cos[k * N_FFT..][..N_FFT], &self.sin[k * N_FFT..][..N_FFT]);
                let (mut re, mut im) = (0.0f32, 0.0f32);
                for i in 0..N_FFT {
                    re += frame[i] * c[i];
                    im += frame[i] * s[i];
                }
                *p = re * re + im * im;
            }
            for m in 0..MELS {
                let w = &self.filters[m * BINS..][..BINS];
                let v: f32 = w.iter().zip(&power).map(|(w, p)| w * p).sum();
                let v = v.max(1e-10).log10();
                peak = peak.max(v);
                out[m * FRAMES + t] = v;
            }
        }
        for v in &mut out {
            *v = (v.max(peak - 8.0) + 4.0) / 4.0;
        }
        out
    }
}

impl Default for Mel {
    fn default() -> Self {
        Mel::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_whisper() {
        let audio: Vec<f32> = (0..8000)
            .map(|n| {
                let t = n as f64 / RATE as f64;
                (0.4 * (2.0 * PI * 440.0 * t).sin() + 0.2 * (n as f64 / 8000.0) * (2.0 * PI * 2500.0 * t).sin()) as f32
            })
            .collect();
        let got = Mel::new().features(&audio);
        let mut worst = 0.0f32;
        for line in include_str!("../tests/mel_ref.txt").lines().filter(|l| !l.starts_with('#')) {
            let mut cols = line.split_whitespace();
            let t: usize = cols.next().unwrap().parse().unwrap();
            for (m, v) in cols.enumerate() {
                let want: f32 = v.parse().unwrap();
                worst = worst.max((got[m * FRAMES + t] - want).abs());
            }
        }
        assert!(worst < 1e-3, "worst difference {worst}");
    }
}
