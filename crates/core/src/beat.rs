//! The Beat source's home in the engine: a sample file decoded by the host is analysed on its
//! own thread, and the result becomes scripts for the axes whose tracking source is Beat.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use bp_beat::{BeatTrack, GenerateOptions, Style};

#[derive(Clone, Debug, PartialEq)]
pub enum BeatStatus {
    None,
    Analysing,
    Ready,
    Error(String),
}

/// Global style and depth plus the per-video tempo factor.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BeatOptions {
    pub style: Style,
    pub volume_depth: bool,
    pub tempo_factor: f64,
}

impl Default for BeatOptions {
    fn default() -> BeatOptions {
        BeatOptions { style: Style::Full, volume_depth: true, tempo_factor: 1.0 }
    }
}

#[derive(Clone, Debug)]
pub struct BeatSnapshot {
    pub status: BeatStatus,
    pub bpm: f64,
    pub beats: usize,
    pub options: BeatOptions,
}

pub struct Beat {
    pub status: BeatStatus,
    pub track: Option<BeatTrack>,
    pub options: BeatOptions,
    /// Bumped per load so a stale analysis thread's result is dropped.
    pub generation: u64,
}

impl Beat {
    pub fn new() -> Beat {
        Beat { status: BeatStatus::None, track: None, options: BeatOptions::default(), generation: 0 }
    }

    pub fn snapshot(&self) -> BeatSnapshot {
        BeatSnapshot {
            status: self.status.clone(),
            bpm: self.track.as_ref().map_or(0.0, |t| t.bpm * self.options.tempo_factor),
            beats: self.track.as_ref().map_or(0, |t| t.beats.len()),
            options: self.options,
        }
    }

    /// The script for one axis at the current options. `alternate` makes a rotation axis swing
    /// the other way on every other beat.
    pub fn script(&self, intensity: f64, invert: bool, alternate: bool) -> Option<bp_script::Script> {
        let track = self.track.as_ref().filter(|t| t.beats.len() >= 2)?;
        let opts = GenerateOptions { style: self.options.style, intensity, volume_depth: self.options.volume_depth, tempo_factor: self.options.tempo_factor, alternate };
        let mut script = bp_beat::generate(track, opts);
        if invert {
            for a in &mut script.actions {
                a.pos = 1.0 - a.pos;
            }
        }
        Some(script)
    }

    /// Reads a raw mono f32le file at `bp_beat::RATE` and analyses it off the caller's thread;
    /// `done` runs with the lock released once the result is in.
    pub fn load(this: &Arc<Mutex<Beat>>, path: PathBuf, done: impl FnOnce() + Send + 'static) {
        let generation = {
            let mut b = this.lock().unwrap();
            b.generation += 1;
            b.status = BeatStatus::Analysing;
            b.track = None;
            b.generation
        };
        let beat = this.clone();
        std::thread::Builder::new()
            .name("bp-beat".into())
            .spawn(move || {
                let result = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display())).map(|bytes| {
                    let samples: Vec<f32> = bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
                    bp_beat::analyse(&samples)
                });
                {
                    let mut b = beat.lock().unwrap();
                    if b.generation != generation {
                        return;
                    }
                    // A track without beats still carries its loudness envelope for the
                    // Audio parameter source, so it is kept behind the error.
                    match result {
                        Ok(track) => {
                            b.status = if track.beats.len() >= 2 { BeatStatus::Ready } else { BeatStatus::Error("no beats found".into()) };
                            b.track = Some(track);
                        }
                        Err(e) => b.status = BeatStatus::Error(e),
                    }
                }
                done();
            })
            .ok();
    }

    /// Loudness of the sound track at `ms`, 0..1, once analysed.
    pub fn loudness_at(&self, ms: f64) -> Option<f64> {
        self.track.as_ref().map(|t| t.loudness_at(ms))
    }

    pub fn clear(&mut self) {
        self.generation += 1;
        self.status = BeatStatus::None;
        self.track = None;
    }
}
