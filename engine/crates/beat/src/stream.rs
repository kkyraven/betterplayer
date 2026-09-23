use crate::{BeatTrack, FRAME, HOP, ONSET_HOP_MS, RATE, SpectralFlux, analyse_spectra};

const WINDOW_SAMPLES: usize = RATE as usize * 24;

#[derive(Default)]
pub struct Stream {
    samples: Vec<f32>,
    spectra: Vec<(f64, f64)>,
    flux: SpectralFlux,
    next_frame: usize,
    origin: u64,
}

impl Stream {
    pub fn starting_at(samples: u64) -> Self {
        Self {
            origin: samples,
            ..Self::default()
        }
    }

    pub fn total_samples(&self) -> u64 {
        self.origin + self.samples.len() as u64
    }

    pub fn push(&mut self, samples: &[f32]) {
        self.samples
            .extend(samples.iter().map(|s| if s.is_finite() { *s } else { 0.0 }));
        while self.next_frame + FRAME <= self.samples.len() {
            self.spectra.push(
                self.flux
                    .push(&self.samples[self.next_frame..self.next_frame + FRAME]),
            );
            self.next_frame += HOP;
        }
        let remove = self.samples.len().saturating_sub(WINDOW_SAMPLES) / HOP * HOP;
        if remove > 0 {
            self.samples.drain(..remove);
            self.spectra.drain(..remove / HOP);
            self.next_frame -= remove;
            self.origin += remove as u64;
        }
    }

    pub fn analyse(&self) -> (BeatTrack, Option<f64>) {
        let mut track = analyse_spectra(&self.samples, &self.spectra);
        let onset_peak = track.onset.iter().copied().fold(0.0_f32, f32::max);
        let origin_ms = self.origin as f64 * 1000.0 / RATE as f64;
        let mut evidence = Vec::new();
        for (at, loud) in track.beats.iter().zip(&track.loudness) {
            let frame = ((at - FRAME as f64 / 2.0 / RATE as f64 * 1000.0) / ONSET_HOP_MS)
                .round()
                .max(0.0) as usize;
            let strength = track
                .onset
                .get(frame.saturating_sub(2)..(frame + 3).min(track.onset.len()))
                .unwrap_or(&[])
                .iter()
                .copied()
                .fold(0.0_f32, f32::max);
            if *loud > 0.08 && strength > onset_peak * 0.15 && onset_peak > 1e-6 {
                evidence.push(*at + origin_ms);
            }
        }
        let last_evidence = if evidence.len() >= 2 {
            evidence.last().copied()
        } else {
            None
        };
        for at in &mut track.beats {
            *at += origin_ms;
        }
        track.duration_ms += origin_ms;
        track.onset.clear();
        track.envelope.clear();
        (track, last_evidence)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analyse;

    #[test]
    fn chunk_boundaries_preserve_analysis_and_silence_has_no_evidence() {
        let samples = super::super::tests::click_track(120.0, 8.0, |_| 0.8);
        let expected = analyse(&samples);
        let mut stream = Stream::default();
        for chunk in samples.chunks(1379) {
            stream.push(chunk);
        }
        let (actual, evidence) = stream.analyse();
        assert_eq!(actual.beats, expected.beats);
        assert_eq!(actual.loudness, expected.loudness);
        assert!(evidence.unwrap() > 7000.0);
        for _ in 0..100 {
            stream.push(&vec![0.0; RATE as usize / 4]);
        }
        let (silent, evidence) = stream.analyse();
        assert!(silent.beats.is_empty());
        assert_eq!(evidence, None);
        assert!(stream.samples.len() <= WINDOW_SAMPLES + HOP);
    }

    #[test]
    fn rolling_audio_deadline_and_timing_recovery() {
        let mut samples = super::super::tests::click_track(120.0, 28.0, |_| 0.8);
        samples.extend(vec![0.0; RATE as usize * 4]);
        samples.extend(super::super::tests::click_track(150.0, 12.0, |_| 0.8));
        let mut stream = Stream::default();
        let mut timings = Vec::new();
        let mut old = crate::generate(&BeatTrack::default(), crate::GenerateOptions::default());
        let mut final_bpm = 0.0;
        for chunk in samples.chunks(RATE as usize / 10) {
            let started = std::time::Instant::now();
            stream.push(chunk);
            let (mut track, evidence) = stream.analyse();
            if track.duration_ms >= 31_000.0 && track.duration_ms < 32_000.0 {
                assert!(evidence.is_none_or(|at| at < 28_000.0));
            }
            let until = evidence.map_or(0.0, |at| at + 1500.0);
            let last = track.beats.last().copied().unwrap_or(0.0);
            crate::extend_beats(&mut track, (until - last).max(0.0));
            let keep = track.beats.partition_point(|at| *at <= until);
            track.beats.truncate(keep);
            track.loudness.truncate(keep);
            let next = crate::generate(&track, crate::GenerateOptions::default());
            old = crate::continue_script(
                &old,
                next,
                stream.total_samples() as f64 * 1000.0 / RATE as f64,
                crate::MAX_SPEED,
            );
            assert!(old.actions.windows(2).all(|w| w[0].at < w[1].at));
            timings.push(started.elapsed().as_secs_f64() * 1000.0);
            final_bpm = track.bpm;
        }
        assert!(
            (final_bpm - 150.0).abs() < 6.0,
            "recovered tempo: {final_bpm}"
        );
        timings.sort_by(f64::total_cmp);
        eprintln!(
            "100 ms audio updates, analysis + generation + continuity: p95 {:.2} ms, max {:.2} ms",
            timings[timings.len() * 95 / 100],
            timings.last().unwrap()
        );
        if !cfg!(debug_assertions) {
            assert!(timings[timings.len() * 95 / 100] < 100.0);
        }
    }
}
