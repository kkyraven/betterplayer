use std::sync::{Arc, Mutex};

use bp_beat::Grid50;
use bp_script::Script;

use crate::decoder::decode_axis;
use crate::features::{FLOW_CLIP, SIGNAL_SCALE};
use crate::mel::BANDS;
use crate::meta::Meta;
use crate::session::{Head, Session};

pub const RATE_HZ: f64 = 50.0;
pub const HOP_MS: f64 = 1000.0 / RATE_HZ;

const BPM_SCALE: f32 = 200.0;

pub const CHUNK: usize = 1500;
pub const OVERLAP: usize = 250;

pub const SECTION: usize = 100;
pub const STYLES: [&str; 4] = ["half", "full", "double", "smash"];

pub const MUSIC_LAYOUT: &[(&str, usize)] = &[
    ("mel", BANDS),
    ("onset", 1),
    ("beat_sin", 1),
    ("beat_cos", 1),
    ("loudness", 1),
    ("tempo", 1),
    ("video_chain", 6),
    ("video_signals", 6),
    ("video_cut", 1),
    ("video_present", 1),
    ("pace", 6),
];

const fn offset(index: usize) -> usize {
    let mut at = 0;
    let mut i = 0;
    while i < index {
        at += MUSIC_LAYOUT[i].1;
        i += 1;
    }
    at
}

pub const MEL: usize = offset(0);
pub const ONSET: usize = offset(1);
pub const BEAT_SIN: usize = offset(2);
pub const BEAT_COS: usize = offset(3);
pub const LOUDNESS: usize = offset(4);
pub const TEMPO: usize = offset(5);
pub const VIDEO_CHAIN: usize = offset(6);
pub const VIDEO_SIGNALS: usize = offset(7);
pub const VIDEO_CUT: usize = offset(8);
pub const VIDEO_PRESENT: usize = offset(9);
pub const PACE: usize = offset(10);
pub const MUSIC_WIDTH: usize = offset(11);


#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct VideoRow {
    pub time_ms: f64,

    pub chain: [f64; 6],
    pub signals: [f64; 6],
    pub cut: bool,
}



fn resample(video: &[VideoRow], frames: usize) -> Vec<([f32; 6], [f32; 6], f32)> {
    let mut out = vec![([0.0; 6], [0.0; 6], 0.0); frames];
    if video.is_empty() {
        return out;
    }
    let mut src = 0usize;
    for (i, row) in out.iter_mut().enumerate() {
        let t = i as f64 * HOP_MS;
        while src + 1 < video.len() && video[src + 1].time_ms <= t {
            src += 1;
        }
        let v = &video[src];
        for a in 0..6 {
            row.0[a] = v.chain[a] as f32;
            row.1[a] = (v.signals[a] as f32 / SIGNAL_SCALE[a]).clamp(-FLOW_CLIP, FLOW_CLIP);
        }
    }
    for v in video.iter().filter(|v| v.cut) {
        let hop = (v.time_ms / HOP_MS).floor();
        if hop >= 0.0 {
            let i = (hop as usize).min(frames - 1);
            out[i].2 = 1.0;
        }
    }
    out
}


#[derive(Clone, Debug, Default)]
pub struct MusicResult {

    pub scripts: Vec<Script>,

    pub style: Vec<u8>,
    pub frames: usize,
    pub run_ms: f64,
}

pub struct Music {
    session: Arc<Mutex<Session>>,
    pub meta: Arc<Meta>,
}

impl Music {
    pub fn new(session: Arc<Mutex<Session>>, meta: Arc<Meta>) -> Music {
        Music { session, meta }
    }



    pub fn run(&self, mel: &[[f32; BANDS]], grid: &Grid50, bpm: f64, video: Option<&[VideoRow]>, pace: f64) -> Result<MusicResult, String> {
        let frames = mel.len().min(grid.onset.len());
        if frames == 0 {
            return Ok(MusicResult::default());
        }
        let started = std::time::Instant::now();
        let flow = video.map(|v| resample(v, frames));
        let row_of = |i: usize, out: &mut [f32]| {
            out.fill(0.0);
            out[MEL..MEL + BANDS].copy_from_slice(&mel[i]);
            out[ONSET] = grid.onset[i];
            out[BEAT_SIN] = grid.beat_sin[i];
            out[BEAT_COS] = grid.beat_cos[i];
            out[LOUDNESS] = grid.loudness[i];
            out[TEMPO] = bpm as f32 / BPM_SCALE;
            if let Some(flow) = &flow {
                let (chain, signals, cut) = flow[i];
                out[VIDEO_CHAIN..VIDEO_CHAIN + 6].copy_from_slice(&chain);
                out[VIDEO_SIGNALS..VIDEO_SIGNALS + 6].copy_from_slice(&signals);
                out[VIDEO_CUT] = cut;
                out[VIDEO_PRESENT] = 1.0;
            }
            out[PACE..PACE + 6].fill(pace as f32);
        };

        let hop = CHUNK - OVERLAP;
        let mut window = vec![0.0f32; CHUNK * MUSIC_WIDTH];
        let mut sum: [Vec<[f64; 6]>; 4] = std::array::from_fn(|_| vec![[0.0; 6]; frames]);
        let mut count = vec![0.0f64; frames];
        let sections = frames / SECTION + 1;
        let mut style_sum = vec![[0.0f64; 4]; sections];
        let mut start = 0;
        loop {
            for i in 0..CHUNK {
                let src = (start + i).min(frames - 1);
                row_of(src, &mut window[i * MUSIC_WIDTH..(i + 1) * MUSIC_WIDTH]);
            }
            let heads = self.session.lock().unwrap().run(&window)?;
            let find = |name: &str| heads.iter().find(|h| h.name == name).ok_or_else(|| format!("the graph has no {name} head"));
            let named: [&Head; 4] = [find("pos")?, find("active")?, find("trough")?, find("peak")?];
            let hi = frames.min(start + CHUNK);
            for (k, head) in named.iter().enumerate() {
                for i in start..hi {
                    for a in 0..6 {
                        sum[k][i][a] += head.at(i - start, a) as f64;
                    }
                }
            }
            for i in start..hi {
                count[i] += 1.0;
            }
            let style = find("style")?;
            let lo_sec = start / SECTION;
            for s in 0..style.frames.min(sections - lo_sec) {
                for c in 0..4 {
                    style_sum[lo_sec + s][c] += style.at(s, c) as f64;
                }
            }

            start += hop;
            if start >= (frames + hop).saturating_sub(CHUNK).max(1) {
                break;
            }
        }
        let time_ms: Vec<f64> = (0..frames).map(|i| i as f64 * HOP_MS).collect();
        let mean = |k: usize, a: usize| -> Vec<f64> { (0..frames).map(|i| sum[k][i][a] / count[i].max(1.0)).collect() };
        let config = self.meta.decode_config(pace);
        let mut scripts = Vec::with_capacity(6);
        for a in 0..6 {
            let actions = decode_axis(&time_ms, &mean(0, a), &mean(2, a), &mean(3, a), Some(&mean(1, a)), &config);
            scripts.push(Script { actions, ..Script::default() });
        }
        let style = style_sum.iter().map(|s| (0..4).max_by(|&x, &y| s[x].total_cmp(&s[y])).unwrap_or(1) as u8).collect();
        Ok(MusicResult { scripts, style, frames, run_ms: started.elapsed().as_secs_f64() * 1000.0 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets_match_the_export() {
        assert_eq!(MUSIC_WIDTH, 105);
        assert_eq!((ONSET, BEAT_SIN, BEAT_COS, LOUDNESS, TEMPO), (80, 81, 82, 83, 84));
        assert_eq!((VIDEO_CHAIN, VIDEO_SIGNALS, VIDEO_CUT, VIDEO_PRESENT, PACE), (85, 91, 97, 98, 99));
    }

    #[test]
    fn video_rows_hold_the_last_frame_and_keep_every_cut() {
        let video = [
            VideoRow { time_ms: 0.0, chain: [0.1; 6], signals: [8.0, 4.0, 128.0, 0.0, 0.0, 0.0], cut: false },
            VideoRow { time_ms: 33.3, chain: [0.2; 6], signals: [0.0; 6], cut: true },
            VideoRow { time_ms: 66.6, chain: [0.3; 6], signals: [0.0; 6], cut: false },
            VideoRow { time_ms: 99.9, chain: [0.4; 6], signals: [0.0; 6], cut: true },
        ];
        let rows = resample(&video, 8);
        assert_eq!(rows[0].0[0], 0.1);
        assert_eq!(rows[0].1[..3], [1.0, 1.0, 1.0]);
        assert_eq!(rows[1].0[0], 0.1, "20 ms still has the first frame");
        assert_eq!(rows[2].0[0], 0.2, "40 ms has the frame at 33 ms");
        assert_eq!(rows[7].0[0], 0.4, "held past the last frame");
        let cuts: Vec<usize> = rows.iter().enumerate().filter(|(_, r)| r.2 == 1.0).map(|(i, _)| i).collect();
        assert_eq!(cuts, vec![1, 4], "a cut lands on the hop at or before it");
        assert!(resample(&[], 3).iter().all(|r| r.0 == [0.0; 6] && r.2 == 0.0));
    }
}
