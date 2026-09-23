use std::f64::consts::PI;

mod strokes;
mod stream;
pub use stream::Stream;

pub use strokes::{generate, continue_script, MAX_SPEED, MIN_SPEED};

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
pub enum Style { Raw, Strokes }

impl Style {
    pub fn as_str(self) -> &'static str {
        match self { Self::Raw => "raw", Self::Strokes => "strokes" }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "raw" => Some(Self::Raw),
            "strokes" | "half" | "full" | "double" | "smash" => Some(Self::Strokes),
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
    pub flourishes: bool,
    pub bounce_depth: f64,
    pub bounce_speed: f64,
    pub fps: f64,
    pub min_speed: f64,
    pub max_speed: f64,
    pub playback_rate: f64,
    pub min: f64,
    pub max: f64,
    pub invert: bool,
}

impl Default for GenerateOptions {
    fn default() -> GenerateOptions {
        GenerateOptions { style: Style::Strokes, intensity: 1.0, volume_depth: false, tempo_factor: 1.0, alternate: false, flourishes: true, bounce_depth: 1.0 / 6.0, bounce_speed: 3.0, fps: 60.0, min_speed: MIN_SPEED, max_speed: MAX_SPEED, playback_rate: 1.0, min: 0.0, max: 1.0, invert: false }
    }
}

pub fn analyse(samples: &[f32]) -> BeatTrack {
    let clean;
    let samples = if samples.iter().any(|s| !s.is_finite()) {
        clean = samples.iter().map(|s| if s.is_finite() { *s } else { 0.0 }).collect::<Vec<_>>();
        &clean[..]
    } else { samples };
    let mut flux = SpectralFlux::default();
    let spectra: Vec<_> = (0..samples.len().saturating_sub(FRAME - 1)).step_by(HOP)
        .map(|start| flux.push(&samples[start..start + FRAME])).collect();
    analyse_spectra(samples, &spectra)
}

fn analyse_spectra(samples: &[f32], spectra: &[(f64, f64)]) -> BeatTrack {
    let duration_ms = samples.len() as f64 / RATE as f64 * 1000.0;
    let peak = peak_rms(samples);
    let envelope = envelope(samples, peak);
    if samples.len() < FRAME * 4 {
        return BeatTrack { duration_ms, envelope, ..BeatTrack::default() };
    }
    let onsets = clean_flux(&spectra.iter().map(|s| s.0).collect::<Vec<_>>());
    let rhythmic = clean_flux(&spectra.iter().map(|s| s.1).collect::<Vec<_>>());
    let hop_ms = ONSET_HOP_MS;
    let bpm = tempo(&rhythmic, hop_ms, None);
    let periods = local_periods(&rhythmic, hop_ms, bpm);
    let frames = track_beats(&rhythmic, &periods);
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

struct SpectralFlux {
    window: Vec<f64>,
    previous: Vec<f64>,
    magnitudes: Vec<f64>,
    buffer: Vec<f64>,
}

impl Default for SpectralFlux {
    fn default() -> Self {
        Self {
            window: (0..FRAME).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f64 / FRAME as f64).cos()).collect(),
            previous: vec![0.0; FRAME / 2],
            magnitudes: vec![0.0; FRAME / 2],
            buffer: vec![0.0; FRAME],
        }
    }
}

impl SpectralFlux {
    fn push(&mut self, samples: &[f32]) -> (f64, f64) {
        for (i, sample) in samples.iter().enumerate() {
            self.buffer[i] = if sample.is_finite() { *sample as f64 * self.window[i] } else { 0.0 };
        }
        fft_magnitudes(&self.buffer, &mut self.magnitudes);
        let (mut full, mut rhythmic) = (0.0, 0.0);
        for b in 1..self.magnitudes.len() {
            let difference = (self.magnitudes[b].ln_1p() - self.previous[b].ln_1p()).max(0.0);
            let hz = b as f64 * RATE as f64 / FRAME as f64;
            let weight = if hz < 35.0 { 0.0 } else if hz < 250.0 { 2.0 } else if hz < 4000.0 { 1.0 } else { 0.5 };
            full += difference;
            rhythmic += difference * weight;
        }
        std::mem::swap(&mut self.previous, &mut self.magnitudes);
        (full, rhythmic)
    }
}

fn clean_flux(raw: &[f64]) -> Vec<f64> {
    let half = (500.0 / ONSET_HOP_MS) as usize;
    let mut sum = vec![0.0; raw.len() + 1];
    for (i, value) in raw.iter().enumerate() { sum[i + 1] = sum[i] + value; }
    raw.iter().enumerate().map(|(i, value)| {
        let (a, b) = (i.saturating_sub(half), (i + half + 1).min(raw.len()));
        (value - (sum[b] - sum[a]) / (b - a) as f64).max(0.0)
    }).collect()
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

fn tempo(onsets: &[f64], hop_ms: f64, previous: Option<f64>) -> f64 {
    let n = onsets.len();
    let min_lag = (60_000.0 / MAX_BPM / hop_ms).round() as usize;
    let max_lag = ((60_000.0 / MIN_BPM / hop_ms).round() as usize).min(n / 2);
    if max_lag <= min_lag {
        return previous.unwrap_or(120.0);
    }
    let mean = onsets.iter().sum::<f64>() / n as f64;
    let variance = onsets.iter().map(|o| (o - mean).powi(2)).sum::<f64>() / n as f64;
    if variance <= 1e-18 {
        return previous.unwrap_or(120.0);
    }
    let mut correlations = vec![0.0; max_lag + 1];
    let mut best = (0.0f64, min_lag);
    for lag in min_lag..=max_lag {
        let mut acc = 0.0;
        for i in lag..n {
            acc += (onsets[i] - mean) * (onsets[i - lag] - mean);
        }
        let bpm = 60_000.0 / (lag as f64 * hop_ms);
        let weight = (-0.5 * ((bpm / 120.0).ln() / 0.6).powi(2)).exp();
        let correlation = acc / (n - lag) as f64 / variance;
        correlations[lag] = correlation;
        let score = correlation * weight;
        if score > best.0 {
            best = (score, lag);
        }
    }
    if let Some(bpm) = previous {
        if correlations[best.1] < 0.2 {
            return bpm;
        }
    }
    let lag = best.1 as f64;
    60_000.0 / (lag * hop_ms)
}

fn local_periods(onsets: &[f64], hop_ms: f64, bpm: f64) -> Vec<f64> {
    let half = (4000.0 / hop_ms).round() as usize;
    let step = (1000.0 / hop_ms).round() as usize;
    let mut anchors = Vec::new();
    let mut period = 60_000.0 / bpm / hop_ms;
    for centre in (0..onsets.len()).step_by(step) {
        let start = centre.saturating_sub(half).min(onsets.len().saturating_sub(half * 2));
        let end = (start + half * 2).min(onsets.len());
        let window = &onsets[start..end];
        let previous = 60_000.0 / period / hop_ms;
        period = 60_000.0 / tempo(window, hop_ms, Some(previous)) / hop_ms;
        anchors.push(period as f32);
    }
    let mut periods: Vec<f64> = (0..onsets.len()).map(|i| sample_at(&anchors, step as f64, 0.0, i as f64) as f64).collect();
    follow_strong_onsets(onsets, hop_ms, &mut periods);
    periods
}

fn follow_strong_onsets(onsets: &[f64], hop_ms: f64, periods: &mut [f64]) {
    let energy: Vec<f64> = (0..onsets.len()).map(|i| onsets[i.saturating_sub(1)..(i + 2).min(onsets.len())].iter().sum()).collect();
    let peak = energy.iter().copied().fold(0.0_f64, f64::max);
    if peak <= 1e-9 { return; }
    let neighbourhood = (1000.0 / hop_ms).round() as usize;
    let separation = (100.0 / hop_ms).ceil() as usize;
    let mut peaks: Vec<usize> = Vec::new();
    for i in 1..onsets.len().saturating_sub(1) {
        if energy[i] < peak * 0.03 || onsets[i] < onsets[i - 1] || onsets[i] <= onsets[i + 1] { continue; }
        let start = i.saturating_sub(neighbourhood);
        let end = (i + neighbourhood + 1).min(onsets.len());
        let local_peak = energy[start..end].iter().copied().fold(0.0_f64, f64::max);
        if energy[i] < local_peak * 0.35 { continue; }
        if let Some(last) = peaks.last_mut() {
            let nearby_weaker_peak = (i - *last) as f64 * hop_ms < 150.0
                && energy[i].min(energy[*last]) < energy[i].max(energy[*last]) * 0.5;
            if i - *last < separation || nearby_weaker_peak {
                if energy[i] > energy[*last] { *last = i; }
                continue;
            }
        }
        peaks.push(i);
    }
    let mut supported = vec![false; peaks.len().saturating_sub(1)];
    for size in [5, 7] {
        for (index, run) in peaks.windows(size).enumerate() {
            let gaps = run.windows(2).map(|pair| pair[1] - pair[0]);
            let shortest = gaps.clone().min().unwrap() as f64;
            if shortest * hop_ms < 120.0 || gaps.clone().any(|gap| gap as f64 * hop_ms > 1250.0) { continue; }
            let on_grid = |gap: usize| {
                let multiple = gap as f64 / shortest;
                (1.0..=4.0).contains(&multiple.round()) && (multiple - multiple.round()).abs() < 0.15
            };
            let repeated = gaps.clone().filter(|&gap| gap as f64 / shortest < 1.15).count();
            if repeated < 3 || !gaps.clone().all(on_grid) { continue; }
            supported[index..index + size - 1].fill(true);
            for pair in run.windows(2) {
                periods[pair[0] + 1..=pair[1]].fill((pair[1] - pair[0]) as f64);
            }
        }
    }
    for i in 1..supported.len().saturating_sub(1) {
        if supported[i] || !supported[i - 1] || !supported[i + 1] { continue; }
        let before = (peaks[i] - peaks[i - 1]) as f64;
        let after = (peaks[i + 2] - peaks[i + 1]) as f64;
        let gap = peaks[i + 1] - peaks[i];
        if (before / after).ln().abs() > 0.3 && (120.0..=1250.0).contains(&(gap as f64 * hop_ms)) {
            periods[peaks[i] + 1..=peaks[i + 1]].fill(gap as f64);
        }
    }
}

fn track_beats(onsets: &[f64], periods: &[f64]) -> Vec<usize> {
    let n = onsets.len();
    let max = onsets.iter().cloned().fold(0.0, f64::max);
    if n == 0 || max <= 1e-9 {
        return Vec::new();
    }
    let norm: Vec<f64> = onsets.iter().map(|o| o / max).collect();
    let tightness = 100.0;
    let mut score = vec![0.0f64; n];
    let mut back = vec![usize::MAX; n];
    for i in 0..n {
        let period = periods[i];
        let lo = (period * 0.5).floor() as usize;
        let hi = (period * 2.0).ceil() as usize;
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
    let tail = n.saturating_sub((periods[n - 1] * 2.0).ceil() as usize);
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

pub fn extend_beats(track: &mut BeatTrack, ahead_ms: f64) {
    if track.beats.len() < 2 || track.bpm <= 0.0 {
        return;
    }
    let mut gaps: Vec<f64> = track.beats[track.beats.len().saturating_sub(5)..].windows(2).map(|w| w[1] - w[0]).collect();
    gaps.sort_by(f64::total_cmp);
    let period = gaps[gaps.len() / 2];
    if !period.is_finite() || period <= 0.0 || !ahead_ms.is_finite() {
        return;
    }
    let last = track.beats[track.beats.len() - 1];
    let end = last + ahead_ms;
    let tail = &track.loudness[track.loudness.len().saturating_sub(4)..];
    let loud = if tail.is_empty() { 1.0 } else { tail.iter().sum::<f64>() / tail.len() as f64 };
    let count = (ahead_ms / period).floor().clamp(0.0, 8192.0) as usize;
    for i in 1..=count {
        let at = last + period * i as f64;
        if at.is_finite() && at > *track.beats.last().unwrap() {
            track.beats.push(at);
            track.loudness.push(loud);
        }
    }
    track.duration_ms = track.duration_ms.max(end);
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

    pub(super) fn click_track(bpm: f64, seconds: f64, loud: impl Fn(usize) -> f32) -> Vec<f32> {
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
    fn follows_tempo_changes_in_both_directions() {
        for (first, second) in [(90.0, 150.0), (150.0, 90.0), (120.0, 60.0), (60.0, 120.0)] {
            let mut samples = click_track(first, 24.0, |_| 0.8);
            samples.extend(click_track(second, 24.0, |_| 0.8));
            let track = analyse(&samples);
            for (start, bpm) in [(0.0, first), (24_000.0, second)] {
                let period = 60_000.0 / bpm;
                let beats: Vec<f64> = track.beats.iter().copied().filter(|&at| at > start + 5000.0 && at < start + 22_000.0).collect();
                let aligned = beats.iter().filter(|&&at| {
                    let phase = (at - start) / period;
                    (phase - phase.round()).abs() * period < 30.0
                }).count();
                assert!(aligned as f64 / beats.len() as f64 > 0.95, "{first} -> {second}, section {bpm}: {aligned}/{} on beat", beats.len());
                assert!((beats.len() as f64 - 17_000.0 / period).abs() < 2.0, "{first} -> {second}, section {bpm}: {} beats", beats.len());
            }
        }
    }

    #[test]
    fn follows_three_second_fast_sections_without_transition_beats() {
        for (fast, before) in [(120.0, 12.0), (150.0, 12.0), (180.0, 12.0), (200.0, 12.0), (240.0, 12.0), (180.0, 6.137), (240.0, 6.137)] {
            let mut samples = click_track(60.0, before, |_| 0.8);
            let start = samples.len() as f64 * 1000.0 / RATE as f64;
            samples.extend(click_track(fast, 3.0, |_| 0.8));
            samples.extend(click_track(60.0, 12.0, |_| 0.8));
            let expected: Vec<f64> = (1..).map(|i| i as f64 * 1000.0).take_while(|at| *at < start)
                .chain((0..).map(|i| start + i as f64 * 60_000.0 / fast).take_while(|at| *at < start + 3000.0))
                .chain((0..12).map(|i| start + 3000.0 + i as f64 * 1000.0)).collect();
            let track = analyse(&samples);
            for at in &expected {
                assert!(track.beats.iter().any(|beat| (beat - at).abs() < 30.0), "60 -> {fast} -> 60: missed {at}, {:?}", track.beats);
            }
            for at in track.beats.iter().filter(|&&at| (970.0..start + 14_030.0).contains(&at)) {
                assert!(expected.iter().any(|beat| (beat - at).abs() < 30.0), "60 -> {fast} -> 60: extra {at}");
            }
        }
    }

    #[test]
    fn repeated_strong_subdivisions_follow_their_uneven_gaps() {
        let period = 60_000.0 / 110.0;
        let mut samples = click_track(110.0, 20.0, |_| 0.8);
        let mut expected: Vec<f64> = (1..36).map(|i| i as f64 * period).collect();
        for beat in (4..32).step_by(2) {
            let at = (beat as f64 + 0.5) * period;
            let start = (at / 1000.0 * RATE as f64) as usize;
            let pulse = click_track(110.0, 0.05, |_| 0.8);
            for (sample, pulse) in samples[start..].iter_mut().zip(pulse) { *sample += pulse; }
            expected.push(at);
        }
        let track = analyse(&samples);
        for at in &expected {
            assert!(track.beats.iter().any(|beat| (beat - at).abs() < 30.0), "missed strong pulse {at}");
        }
        for at in track.beats.iter().filter(|&&at| at > period - 30.0 && at < 35.0 * period + 30.0) {
            assert!(expected.iter().any(|beat| (beat - at).abs() < 30.0), "extra pulse {at}");
        }
    }

    #[test]
    fn subdivisions_survive_energy_split_across_fft_frames() {
        for shifted in [false, true] {
            let mut onsets = vec![0.0; 47 * 36];
            let mut expected = Vec::new();
            for beat in 1..35 {
                let frame = beat * 47;
                let main = if shifted { [60.0, 120.0, 20.0] } else { [20.0, 100.0, 80.0] };
                onsets[frame - 1..frame + 2].copy_from_slice(&main);
                expected.push(frame);
                if shifted && beat == 17 {
                    onsets[frame - 12..frame - 9].copy_from_slice(&[18.0, 35.0, 17.0]);
                }
                if beat % 2 == 0 {
                    let frame = frame + 23;
                    let pulse = match (shifted, beat % 4 == 0) {
                        (false, false) => [20.0, 45.0, 15.0],
                        (true, false) => [30.0, 35.0, 15.0],
                        (false, true) => [30.0, 70.0, 40.0],
                        (true, true) => [20.0, 90.0, 30.0],
                    };
                    onsets[frame - 1..frame + 2].copy_from_slice(&pulse);
                    expected.push(frame);
                }
            }
            let bpm = tempo(&onsets, ONSET_HOP_MS, None);
            let beats = track_beats(&onsets, &local_periods(&onsets, ONSET_HOP_MS, bpm));
            for frame in expected.iter().filter(|&&frame| (47 * 4..47 * 32).contains(&frame)) {
                assert!(beats.iter().any(|beat| beat.abs_diff(*frame) <= 1), "shifted {shifted}: missed pulse {frame}");
            }
            for frame in beats.iter().filter(|&&frame| (47 * 4..47 * 32).contains(&frame)) {
                assert!(expected.iter().any(|beat| beat.abs_diff(*frame) <= 1), "shifted {shifted}: extra pulse {frame}");
            }
        }
    }

    #[test]
    fn repeated_swing_keeps_both_strong_pulses() {
        for long in [28, 42] {
            let expected: Vec<usize> = (0..110).scan(40, |frame, i| {
                let at = *frame;
                *frame += if i % 2 == 0 { long } else { long / 2 };
                Some(at)
            }).collect();
            let mut onsets = vec![0.0; expected.last().unwrap() + 2];
            for &frame in &expected { onsets[frame] = 1.0; }
            let bpm = tempo(&onsets, ONSET_HOP_MS, None);
            let beats = track_beats(&onsets, &local_periods(&onsets, ONSET_HOP_MS, bpm));
            assert_eq!(beats, expected, "both swing pulses at {long} frames");
        }
    }

    #[test]
    fn an_isolated_offbeat_does_not_change_the_pace() {
        let mut samples = click_track(60.0, 20.0, |_| 0.8);
        let start = (10.5 * RATE as f64) as usize;
        for (sample, pulse) in samples[start..].iter_mut().zip(click_track(60.0, 0.05, |_| 0.8)) { *sample += pulse; }
        let track = analyse(&samples);
        assert!(track.beats.iter().filter(|&&at| (1000.0..19_000.0).contains(&at)).all(|at| (at - (at / 1000.0).round() * 1000.0).abs() < 30.0));
    }

    #[test]
    fn follows_a_gradual_acceleration() {
        let mut samples = Vec::new();
        let mut expected = Vec::new();
        for i in 0..100 {
            let bpm = 85.0 + i as f64 * 0.85;
            expected.push(samples.len() as f64 / RATE as f64 * 1000.0);
            samples.extend(click_track(bpm, 60.0 / bpm, |_| 0.8));
        }
        let track = analyse(&samples);
        let hits = expected[4..96].iter().filter(|&&at| track.beats.iter().any(|&b| (b - at).abs() < 30.0)).count();
        assert!(hits >= 88, "{hits}/92 accelerating beats found");
        assert!((track.beats.len() as isize - 100).abs() < 4, "{} beats", track.beats.len());
    }

    #[test]
    fn quiet_alternating_beats_settle_into_half_time_then_recover() {
        let track = analyse(&click_track(120.0, 48.0, |i| {
            if (32..64).contains(&i) && i % 2 == 1 { 0.1 } else { 0.8 }
        }));
        for (start, count, period) in [(4000.0, 16, 500.0), (20_000.0, 8, 1000.0), (36_000.0, 16, 500.0)] {
            let beats: Vec<f64> = track.beats.iter().copied().filter(|&at| (start..start + 8000.0).contains(&at)).collect();
            assert_eq!(beats.len(), count, "stroke pace at {start} ms: {beats:?}");
            assert!(beats.iter().all(|at| (at - (at / period).round() * period).abs() < 30.0));
        }
    }

    #[test]
    fn background_noise_during_a_break_keeps_the_previous_tempo() {
        let mut samples = click_track(120.0, 16.0, |_| 0.8);
        let mut seed = 1u32;
        for _ in 0..RATE as usize * 16 {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            samples.push(((seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5) * 0.001);
        }
        samples.extend(click_track(120.0, 16.0, |_| 0.8));
        let track = analyse(&samples);
        let middle: Vec<f64> = track.beats.iter().copied().filter(|&at| (20_000.0..28_000.0).contains(&at)).collect();
        assert_eq!(middle.len(), 16, "maintain the beat through the break: {middle:?}");
        assert!(middle.windows(2).all(|w| (w[1] - w[0] - 500.0).abs() < 20.0));
    }

    #[test]
    fn silence_has_no_beats_or_strokes() {
        let track = analyse(&vec![0.0; RATE as usize * 8]);
        assert!(track.beats.is_empty());
        assert!(generate(&track, GenerateOptions::default()).actions.is_empty());
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
    fn extend_beats_keeps_time_past_the_last_beat() {
        let mut track = BeatTrack { beats: vec![0.0, 500.0, 1000.0], bpm: 120.0, loudness: vec![0.2, 0.4, 0.6], duration_ms: 1100.0, ..BeatTrack::default() };
        extend_beats(&mut track, 2000.0);
        assert_eq!(track.beats, vec![0.0, 500.0, 1000.0, 1500.0, 2000.0, 2500.0, 3000.0]);
        assert_eq!(track.loudness.len(), 7);
        assert!((track.loudness[6] - 0.4).abs() < 1e-9, "mean of the last four: {}", track.loudness[6]);
        assert_eq!(track.duration_ms, 3000.0);
        let mut short = BeatTrack { beats: vec![0.0], bpm: 120.0, ..BeatTrack::default() };
        extend_beats(&mut short, 2000.0);
        assert_eq!(short.beats.len(), 1);
    }

    #[test]
    fn extends_at_the_recent_tempo_after_a_change() {
        let mut track = BeatTrack { beats: vec![0.0, 500.0, 1000.0, 1400.0, 1800.0, 2200.0, 2600.0], bpm: 120.0, loudness: vec![0.5; 7], duration_ms: 2700.0, ..BeatTrack::default() };
        extend_beats(&mut track, 1200.0);
        assert_eq!(&track.beats[7..], &[3000.0, 3400.0, 3800.0]);
    }


}
