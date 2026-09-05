use std::f64::consts::PI;

use bp_script::{Action, Script};


pub const RATE: u32 = 22_050;

const FRAME: usize = 1024;
const HOP: usize = 256;
const MIN_BPM: f64 = 60.0;
const MAX_BPM: f64 = 200.0;

const LOUDNESS_MS: f64 = 50.0;

const FULL_DEPTH: f64 = 0.95;

pub const ENVELOPE_HOP_MS: f64 = 100.0;

pub const ONSET_HOP_MS: f64 = HOP as f64 / RATE as f64 * 1000.0;


#[derive(Clone, Debug, Default, PartialEq)]
pub struct BeatTrack {

    pub beats: Vec<f64>,
    pub bpm: f64,

    pub loudness: Vec<f64>,


    pub envelope: Vec<f32>,


    pub onset: Vec<f32>,
    pub duration_ms: f64,
}

impl BeatTrack {

    pub fn loudness_at(&self, ms: f64) -> f64 {
        let e = &self.envelope;
        if e.is_empty() || ms < 0.0 {
            return 0.0;
        }
        let x = ms / ENVELOPE_HOP_MS;
        let i = x.floor() as usize;
        let Some(&a) = e.get(i) else { return 0.0 };
        let b = e.get(i + 1).copied().unwrap_or(a);
        let u = x - i as f64;
        (a as f64 + (b as f64 - a as f64) * u).clamp(0.0, 1.0)
    }
}


pub const GRID_HOP_MS: f64 = 20.0;




#[derive(Clone, Debug, Default, PartialEq)]
pub struct Grid50 {
    pub onset: Vec<f32>,
    pub beat_sin: Vec<f32>,
    pub beat_cos: Vec<f32>,
    pub loudness: Vec<f32>,
}



fn sample_at(series: &[f32], hop_ms: f64, origin_ms: f64, ms: f64) -> f32 {
    let Some(&first) = series.first() else { return 0.0 };
    let x = (ms - origin_ms) / hop_ms;
    if x <= 0.0 {
        return first;
    }
    let last = series.len() - 1;
    if x >= last as f64 {
        return series[last];
    }
    let i = x.floor() as usize;
    series[i] + (series[i + 1] - series[i]) * (x - i as f64) as f32
}





pub fn grid50(track: &BeatTrack) -> Grid50 {
    let frames = ((track.duration_ms / GRID_HOP_MS).floor() as usize).max(1);
    let onset_origin = FRAME as f64 / 2.0 / RATE as f64 * 1000.0;
    let beats = &track.beats;
    let period = if beats.len() > 1 { (beats[beats.len() - 1] - beats[0]) / (beats.len() - 1) as f64 } else { 60_000.0 / if track.bpm > 0.0 { track.bpm } else { 120.0 } };
    let mut out = Grid50 { onset: Vec::with_capacity(frames), beat_sin: Vec::with_capacity(frames), beat_cos: Vec::with_capacity(frames), loudness: Vec::with_capacity(frames) };
    let mut beat = 0usize;
    for i in 0..frames {
        let ms = i as f64 * GRID_HOP_MS;
        out.onset.push(sample_at(&track.onset, ONSET_HOP_MS, onset_origin, ms));
        out.loudness.push(sample_at(&track.envelope, ENVELOPE_HOP_MS, ENVELOPE_HOP_MS / 2.0, ms));
        while beat + 1 < beats.len() && beats[beat + 1] <= ms {
            beat += 1;
        }
        let phase = if beats.is_empty() {
            0.0
        } else if ms < beats[0] {
            (ms - beats[0]) / period
        } else if beat + 1 < beats.len() {
            (ms - beats[beat]) / (beats[beat + 1] - beats[beat]).max(1.0)
        } else {
            (ms - beats[beat]) / period
        };
        out.beat_sin.push((phase * 2.0 * PI).sin() as f32);
        out.beat_cos.push((phase * 2.0 * PI).cos() as f32);
    }
    out
}


#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Style {

    Half,

    Full,

    Double,

    Smash,
}

impl Style {
    pub fn as_str(self) -> &'static str {
        match self {
            Style::Half => "half",
            Style::Full => "full",
            Style::Double => "double",
            Style::Smash => "smash",
        }
    }

    pub fn from_str(s: &str) -> Option<Style> {
        match s {
            "half" => Some(Style::Half),
            "full" => Some(Style::Full),
            "double" => Some(Style::Double),
            "smash" => Some(Style::Smash),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GenerateOptions {
    pub style: Style,

    pub intensity: f64,

    pub volume_depth: bool,

    pub tempo_factor: f64,

    pub alternate: bool,
}

impl Default for GenerateOptions {
    fn default() -> GenerateOptions {
        GenerateOptions { style: Style::Full, intensity: 1.0, volume_depth: true, tempo_factor: 1.0, alternate: false }
    }
}


pub fn analyse(samples: &[f32]) -> BeatTrack {
    let duration_ms = samples.len() as f64 / RATE as f64 * 1000.0;
    let peak = peak_rms(samples);
    let envelope = envelope(samples, peak);
    if samples.len() < FRAME * 4 {
        return BeatTrack { duration_ms, envelope, ..BeatTrack::default() };
    }
    let onsets = onset_strength(samples);
    let hop_ms = ONSET_HOP_MS;
    let bpm = tempo(&onsets, hop_ms);
    let period = 60_000.0 / bpm / hop_ms;
    let frames = track_beats(&onsets, period);

    let centre_ms = FRAME as f64 / 2.0 / RATE as f64 * 1000.0;
    let beats: Vec<f64> = frames.iter().map(|&f| f as f64 * hop_ms + centre_ms).collect();
    let loudness = beats.iter().map(|&ms| if peak > 0.0 { (rms_around(samples, ms) / (peak * FULL_DEPTH)).min(1.0) } else { 0.0 }).collect();
    BeatTrack { beats, bpm, loudness, envelope, onset: onsets.iter().map(|&f| f as f32).collect(), duration_ms }
}



fn envelope(samples: &[f32], peak: f64) -> Vec<f32> {
    let win = (ENVELOPE_HOP_MS / 1000.0 * RATE as f64) as usize;
    if win == 0 || peak <= 0.0 {
        return Vec::new();
    }
    let raw: Vec<f64> = samples
        .chunks(win)
        .map(|c| {
            let sum: f64 = c.iter().map(|&s| (s as f64) * (s as f64)).sum();
            ((sum / c.len() as f64).sqrt() / (peak * FULL_DEPTH)).min(1.0)
        })
        .collect();
    (0..raw.len())
        .map(|i| {
            let lo = i.saturating_sub(1);
            let hi = (i + 1).min(raw.len() - 1);
            (raw[lo..=hi].iter().sum::<f64>() / (hi - lo + 1) as f64) as f32
        })
        .collect()
}




fn onset_strength(samples: &[f32]) -> Vec<f64> {
    let bins = FRAME / 2;
    let window: Vec<f64> = (0..FRAME).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f64 / FRAME as f64).cos()).collect();
    let mut prev = vec![0.0f64; bins];
    let mut mags = vec![0.0f64; bins];
    let mut out = Vec::with_capacity(samples.len() / HOP);
    let mut buf = vec![0.0f64; FRAME];
    let mut start = 0;
    while start + FRAME <= samples.len() {
        for i in 0..FRAME {
            buf[i] = samples[start + i] as f64 * window[i];
        }
        fft_magnitudes(&buf, &mut mags);
        let mut flux = 0.0;
        for b in 1..bins {
            let d = mags[b].ln_1p() - prev[b].ln_1p();
            if d > 0.0 {
                flux += d;
            }
        }
        out.push(flux);
        std::mem::swap(&mut prev, &mut mags);
        start += HOP;
    }

    let n = out.len();
    let half = (0.5 * 1000.0 / (HOP as f64 / RATE as f64 * 1000.0)) as usize;
    let mut cleaned = vec![0.0; n];
    for i in 0..n {
        let (a, b) = (i.saturating_sub(half), (i + half + 1).min(n));
        let mean = out[a..b].iter().sum::<f64>() / (b - a) as f64;
        cleaned[i] = (out[i] - mean).max(0.0);
    }
    cleaned
}


fn fft_magnitudes(input: &[f64], mags: &mut [f64]) {
    power_spectrum(input, mags);
    for m in mags.iter_mut() {
        *m = m.sqrt();
    }
}



pub fn power_spectrum(input: &[f64], out: &mut [f64]) {
    let n = input.len();
    let mut re: Vec<f64> = input.to_vec();
    let mut im = vec![0.0f64; n];

    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * PI / len as f64;
        let (wr, wi) = (ang.cos(), ang.sin());
        let mut i = 0;
        while i < n {
            let (mut cr, mut ci) = (1.0, 0.0);
            for k in 0..len / 2 {
                let (ar, ai) = (re[i + k], im[i + k]);
                let (br, bi) = (re[i + k + len / 2], im[i + k + len / 2]);
                let (tr, ti) = (br * cr - bi * ci, br * ci + bi * cr);
                re[i + k] = ar + tr;
                im[i + k] = ai + ti;
                re[i + k + len / 2] = ar - tr;
                im[i + k + len / 2] = ai - ti;
                let ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
            i += len;
        }
        len <<= 1;
    }
    for (b, o) in out.iter_mut().enumerate() {
        *o = re[b] * re[b] + im[b] * im[b];
    }
}




fn tempo(onsets: &[f64], hop_ms: f64) -> f64 {
    let n = onsets.len();
    let min_lag = (60_000.0 / MAX_BPM / hop_ms).round() as usize;
    let max_lag = ((60_000.0 / MIN_BPM / hop_ms).round() as usize).min(n / 2);
    if max_lag <= min_lag {
        return 120.0;
    }
    let mean = onsets.iter().sum::<f64>() / n as f64;
    let mut best = (0.0f64, min_lag);
    for lag in min_lag..=max_lag {
        let mut acc = 0.0;
        for i in lag..n {
            acc += (onsets[i] - mean) * (onsets[i - lag] - mean);
        }
        let bpm = 60_000.0 / (lag as f64 * hop_ms);

        let weight = (-0.5 * ((bpm / 120.0).ln() / 0.6).powi(2)).exp();
        let score = acc / (n - lag) as f64 * weight;
        if score > best.0 {
            best = (score, lag);
        }
    }

    let lag = best.1 as f64;
    60_000.0 / (lag * hop_ms)
}




fn track_beats(onsets: &[f64], period: f64) -> Vec<usize> {
    let n = onsets.len();
    if n == 0 || period < 2.0 {
        return Vec::new();
    }
    let max = onsets.iter().cloned().fold(0.0, f64::max).max(1e-9);
    let norm: Vec<f64> = onsets.iter().map(|o| o / max).collect();
    let lo = (period * 0.5).floor() as usize;
    let hi = (period * 2.0).ceil() as usize;
    let tightness = 100.0;
    let mut score = vec![0.0f64; n];
    let mut back = vec![usize::MAX; n];
    for i in 0..n {
        let mut best = norm[i];
        let mut from = usize::MAX;
        if i >= lo {
            let start = i.saturating_sub(hi);
            for j in start..=i - lo {
                let gap = (i - j) as f64;
                let penalty = tightness * ((gap / period).ln()).powi(2);
                let s = score[j] + norm[i] - penalty * 0.01;
                if s > best {
                    best = s;
                    from = j;
                }
            }
        }
        score[i] = best;
        back[i] = from;
    }

    let tail = n.saturating_sub(hi.max(1));
    let mut i = (tail..n).max_by(|&a, &b| score[a].total_cmp(&score[b])).unwrap_or(n - 1);
    let mut beats = Vec::new();
    while i != usize::MAX {
        beats.push(i);
        i = back[i];
    }
    beats.reverse();
    beats
}

fn peak_rms(samples: &[f32]) -> f64 {
    let win = (LOUDNESS_MS * 2.0 / 1000.0 * RATE as f64) as usize;
    let mut peak = 0.0f64;
    let mut start = 0;
    while start + win <= samples.len() {
        let sum: f64 = samples[start..start + win].iter().map(|&s| (s as f64) * (s as f64)).sum();
        peak = peak.max((sum / win as f64).sqrt());
        start += win / 2;
    }
    peak
}

fn rms_around(samples: &[f32], ms: f64) -> f64 {
    let centre = (ms / 1000.0 * RATE as f64) as usize;
    let half = (LOUDNESS_MS / 1000.0 * RATE as f64) as usize;
    let (a, b) = (centre.saturating_sub(half), (centre + half).min(samples.len()));
    if b <= a {
        return 0.0;
    }
    let sum: f64 = samples[a..b].iter().map(|&s| (s as f64) * (s as f64)).sum();
    (sum / (b - a) as f64).sqrt()
}



fn beats_at(track: &BeatTrack, factor: f64) -> Vec<(f64, f64)> {
    let pairs: Vec<(f64, f64)> = track.beats.iter().zip(&track.loudness).map(|(&b, &l)| (b, l)).collect();
    if factor <= 0.75 {
        pairs.into_iter().step_by(2).collect()
    } else if factor >= 1.5 {
        let mut out = Vec::with_capacity(pairs.len() * 2);
        for w in pairs.windows(2) {
            out.push(w[0]);
            out.push(((w[0].0 + w[1].0) / 2.0, (w[0].1 + w[1].1) / 2.0));
        }
        if let Some(last) = pairs.last() {
            out.push(*last);
        }
        out
    } else {
        pairs
    }
}



pub fn generate(track: &BeatTrack, opts: GenerateOptions) -> Script {
    let beats = beats_at(track, opts.tempo_factor);
    let mut actions: Vec<Action> = Vec::with_capacity(beats.len() * 3);
    let depth = |loud: f64| {
        let d = if opts.volume_depth { loud } else { 1.0 };
        (0.5 * d * opts.intensity).clamp(0.0, 0.5)
    };
    let mut push = |at: f64, pos: f64| {
        if actions.last().is_none_or(|a: &Action| at > a.at + 1.0) {
            actions.push(Action { at, pos: pos.clamp(0.0, 1.0) });
        }
    };
    match opts.style {
        Style::Half => {

            for (i, &(at, loud)) in beats.iter().enumerate() {
                let d = depth(loud);
                push(at, if i % 2 == 0 { 0.5 - d } else { 0.5 + d });
            }
        }
        Style::Full => {

            for (i, &(at, loud)) in beats.iter().enumerate() {
                let d = depth(loud);
                let sign = if opts.alternate && i % 2 == 1 { -1.0 } else { 1.0 };
                push(at, 0.5 - d * sign);
                if let Some(&(next, _)) = beats.get(i + 1) {
                    push((at + next) / 2.0, 0.5 + d * sign);
                }
            }
        }
        Style::Double => {
            for (i, &(at, loud)) in beats.iter().enumerate() {
                let d = depth(loud);
                push(at, 0.5 - d);
                if let Some(&(next, _)) = beats.get(i + 1) {
                    let q = (next - at) / 4.0;
                    push(at + q, 0.5 + d);
                    push(at + 2.0 * q, 0.5 - d);
                    push(at + 3.0 * q, 0.5 + d);
                }
            }
        }
        Style::Smash => {

            for (i, &(at, loud)) in beats.iter().enumerate() {
                let d = depth(loud);
                let top = 0.5 + d;
                if i == 0 {
                    push((at - 80.0).max(0.0), top);
                }
                push(at, 0.5 - d);
                push(at + 120.0, top);
            }
        }
    }
    Script { actions, ..Script::default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_follows_loudness_against_the_peak() {

        let mut samples = vec![0.0f32; RATE as usize];
        for i in 0..RATE as usize * 2 {
            let amp = if i < RATE as usize { 0.5 } else { 0.25 };
            samples.push(amp * (i as f32 * 0.1).sin());
        }
        let peak = peak_rms(&samples);
        let env = envelope(&samples, peak);
        assert_eq!(env.len(), 30);
        let t = BeatTrack { envelope: env, ..BeatTrack::default() };
        assert!(t.loudness_at(500.0) < 0.05, "silence: {}", t.loudness_at(500.0));
        assert!(t.loudness_at(1500.0) > 0.95, "loud: {}", t.loudness_at(1500.0));
        let half = t.loudness_at(2500.0);
        assert!((half - 0.53).abs() < 0.05, "half amplitude against a 0.95 peak: {half}");
        assert_eq!(t.loudness_at(-1.0), 0.0);
        assert_eq!(t.loudness_at(10_000.0), 0.0, "past the end");
        assert_eq!(BeatTrack::default().loudness_at(100.0), 0.0);
    }


    fn click_track(bpm: f64, seconds: f64, loud: impl Fn(usize) -> f32) -> Vec<f32> {
        let n = (seconds * RATE as f64) as usize;
        let mut out = vec![0.0f32; n];
        let mut seed = 12345u32;
        for s in out.iter_mut() {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            *s = ((seed >> 9) as f32 / (1u32 << 23) as f32 - 1.0) * 0.02;
        }
        let period = 60.0 / bpm * RATE as f64;
        let mut i = 0usize;
        while (i as f64 * period) < n as f64 {
            let start = (i as f64 * period) as usize;
            let amp = loud(i);
            for k in 0..(RATE as usize / 20) {
                if start + k >= n {
                    break;
                }
                let t = k as f64 / RATE as f64;

                out[start + k] += amp * ((2.0 * PI * 80.0 * t).sin() * (-t * 30.0).exp()) as f32 + if k < 20 { amp * 0.5 } else { 0.0 };
            }
            i += 1;
        }
        out
    }

    #[test]
    fn finds_the_tempo_and_the_beats_of_a_click_track() {
        let track = analyse(&click_track(128.0, 20.0, |_| 0.8));
        assert!((track.bpm - 128.0).abs() < 2.0, "tempo {}", track.bpm);
        assert!(track.beats.len() > 35, "beats {}", track.beats.len());

        let period = 60_000.0 / 128.0;
        let off: Vec<f64> = track.beats.iter().map(|b| ((b / period).round() * period - b).abs()).collect();
        let worst = off.iter().cloned().fold(0.0, f64::max);
        assert!(worst < 25.0, "worst beat offset {worst} ms");
    }

    #[test]
    fn loudness_follows_the_kicks() {
        let track = analyse(&click_track(120.0, 16.0, |i| if i % 8 < 4 { 0.9 } else { 0.3 }));
        let loud: Vec<f64> = track.loudness.clone();
        let (quiet, strong): (Vec<f64>, Vec<f64>) = loud.iter().partition(|&&l| l < 0.6);
        assert!(!quiet.is_empty() && !strong.is_empty(), "both levels should show: {loud:?}");
    }

    #[test]
    fn the_grid_samples_onset_envelope_and_phase_as_the_dumper_did() {

        let track = BeatTrack {
            beats: vec![500.0, 1000.0],
            bpm: 120.0,
            loudness: vec![1.0, 1.0],
            envelope: vec![0.0, 1.0],
            onset: (0..200).map(|i| i as f32).collect(),
            duration_ms: 1200.0,
        };
        let g = grid50(&track);
        assert_eq!(g.onset.len(), 60);


        assert_eq!(g.onset[0], 0.0);
        let hop = ONSET_HOP_MS;
        let expect = ((100.0 - 1024.0 / 2.0 / 22050.0 * 1000.0) / hop) as f32;
        assert!((g.onset[5] - expect).abs() < 1e-3, "{} vs {expect}", g.onset[5]);

        assert_eq!(g.loudness[0], 0.0);
        assert!((g.loudness[5] - 0.5).abs() < 1e-6);
        assert_eq!(g.loudness[59], 1.0);

        assert!((g.beat_sin[25]).abs() < 1e-6 && g.beat_cos[25] > 0.99, "on the first beat");
        assert!((g.beat_sin[37] - (0.48 * 2.0 * PI).sin() as f32).abs() < 1e-5);
        assert!((g.beat_sin[0] - ((-500.0 / 500.0) * 2.0 * PI).sin() as f32).abs() < 1e-5);
        assert!((g.beat_sin[55] - (0.2 * 2.0 * PI).sin() as f32).abs() < 1e-5, "after the last beat at the mean period");
        assert!(grid50(&BeatTrack::default()).beat_sin.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn styles_shape_the_script() {
        let track = BeatTrack { beats: vec![0.0, 500.0, 1000.0, 1500.0], bpm: 120.0, loudness: vec![1.0; 4], duration_ms: 2000.0, ..BeatTrack::default() };
        let full = generate(&track, GenerateOptions::default());
        assert!(full.actions.iter().filter(|a| a.at == 500.0).all(|a| a.pos < 0.01), "full: low on the beat");
        assert!(full.actions.iter().any(|a| a.at == 250.0 && a.pos > 0.99), "full: high midway");
        let half = generate(&track, GenerateOptions { style: Style::Half, ..Default::default() });
        assert_eq!(half.actions.len(), 4);
        assert!(half.actions[0].pos < 0.01 && half.actions[1].pos > 0.99);
        let double = generate(&track, GenerateOptions { style: Style::Double, ..Default::default() });
        assert!(double.actions.len() > full.actions.len());
        let smash = generate(&track, GenerateOptions { style: Style::Smash, ..Default::default() });
        assert!(smash.actions.iter().any(|a| a.at == 620.0 && a.pos > 0.99), "smash: back up 120 ms after the beat");
        let soft = generate(&track, GenerateOptions { intensity: 0.5, ..Default::default() });
        assert!(soft.actions.iter().all(|a| (a.pos - 0.5).abs() <= 0.251));
        let halved = generate(&track, GenerateOptions { tempo_factor: 0.5, ..Default::default() });
        assert!(halved.actions.iter().filter(|a| a.pos < 0.01).count() == 2);
    }
}
