use std::collections::BTreeMap;

use bp_tracking::FlowPoint;
use serde::Deserialize;

use crate::features::{BoxRun, DEFAULT_REGION, FrameInput, GRID_POINTS, MOVEMENT_WIDTH, movement_row};
use crate::movement::{PAST, WINDOW};
use crate::ring::Ring;

struct Lcg(u32);

impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        (self.0 >> 8) as f64 / (1u32 << 24) as f64
    }
}

#[derive(Deserialize)]
struct Window {
    start: i64,
    future: usize,
    sum: f64,
    abs_sum: f64,
    rows: BTreeMap<String, Vec<f32>>,
}

#[derive(Deserialize)]
struct Fixture {
    frames: usize,
    pace: f32,
    detect_every_ms: f64,
    windows: Vec<Window>,
}

struct Frame {
    time_ms: f64,
    frame_field: Vec<FlowPoint>,
    region_field: Vec<FlowPoint>,
    region: [f32; 4],
    chain: [f64; 6],
    signals: [f64; 6],
    cut: bool,
}

fn synthetic_title(f: &Fixture) -> (Vec<Frame>, Vec<BoxRun>) {
    let mut rng = Lcg(1);
    let fps_ms = 1000.0 / 30.0;
    let mut frames = Vec::with_capacity(f.frames);
    for i in 0..f.frames {
        let time_ms = i as f64 * fps_ms + if i >= 100 { 50.0 } else { 0.0 };
        let mut fields = [Vec::with_capacity(GRID_POINTS), Vec::with_capacity(GRID_POINTS)];
        for field in &mut fields {
            for _ in 0..GRID_POINTS {
                let u = rng.next();
                let dx = ((u - 0.5) * 40.0) as f32;
                let dy = ((rng.next() - 0.5) * 40.0) as f32;
                let err = (rng.next() * 60.0) as f32;
                field.push(FlowPoint { u: 0.0, v: 0.0, dx, dy, err, textured: if u < 0.7 { 1.0 } else { 0.0 } });
            }
        }
        let chain: [f64; 6] = std::array::from_fn(|_| rng.next() as f32 as f64);
        let mut signals: [f64; 6] = std::array::from_fn(|_| ((rng.next() - 0.5) * 300.0) as f32 as f64);
        if i == 80 {
            signals = [0.0; 6];
        }
        let [frame_field, region_field] = fields;
        frames.push(Frame { time_ms, frame_field, region_field, region: if i < 80 { DEFAULT_REGION } else { [0.1, 0.3, 0.5, 0.5] }, chain, signals, cut: i == 80 });
    }
    let last = frames.last().unwrap().time_ms;
    let runs = (last / f.detect_every_ms).floor() as usize + 1;
    let mut boxes = Vec::with_capacity(runs);
    for k in 0..runs {
        let found = k % 3 != 2;
        let (x, y) = (rng.next() * 0.5, rng.next() * 0.5);
        let rect = found.then(|| [x as f32, y as f32, (0.2 + rng.next() * 0.3) as f32, (0.2 + rng.next() * 0.3) as f32]);
        let kind = found.then(|| (k % 7) as i64 - 1).filter(|k| *k >= 0).map(|k| k as usize);
        let confidence = if found { rng.next() as f32 } else { f32::NAN };
        let coverage: [f32; 6] = std::array::from_fn(|_| rng.next() as f32);
        boxes.push(BoxRun { time_ms: k as f64 * f.detect_every_ms, rect, kind, confidence, coverage });
    }
    (frames, boxes)
}

#[test]
fn feature_rows_match_the_python_windows() {
    let f: Fixture = serde_json::from_str(include_str!("../fixtures/features.json")).unwrap();
    let (frames, boxes) = synthetic_title(&f);
    let mut rows: Vec<Vec<f32>> = Vec::with_capacity(frames.len());
    for (i, fr) in frames.iter().enumerate() {
        let interval_ms = if i == 0 { 1000.0 / 30.0 } else { fr.time_ms - frames[i - 1].time_ms };
        let detection = boxes.iter().rev().find(|b| b.time_ms <= fr.time_ms);
        let input = FrameInput { frame_field: &fr.frame_field, region_field: &fr.region_field, region: fr.region, chain: fr.chain, signals: fr.signals, cut: fr.cut, interval_ms, detection, now_ms: fr.time_ms, pace: f.pace };
        let mut row = vec![0.0; MOVEMENT_WIDTH];
        movement_row(&input, &mut row);
        rows.push(row);
    }
    let mut out = vec![0.0f32; WINDOW * MOVEMENT_WIDTH];
    for w in &f.windows {
        let mut ring = Ring::new();


        let newest = w.start + (PAST - 1 + w.future) as i64;
        for (i, row) in rows.iter().enumerate().take((newest + 1).max(0) as usize) {
            ring.push(row, frames[i].time_ms);
        }
        for _ in frames.len() as i64..=newest {
            ring.push_repeat(frames.last().unwrap().time_ms);
        }
        ring.window(w.future, &mut out);
        let sum: f64 = out.iter().map(|&v| v as f64).sum();
        let abs_sum: f64 = out.iter().map(|&v| v.abs() as f64).sum();
        assert!((sum - w.sum).abs() < 0.05 && (abs_sum - w.abs_sum).abs() < 0.05, "window {} future {}: sums {sum} {abs_sum}, expected {} {}", w.start, w.future, w.sum, w.abs_sum);
        for (index, want) in &w.rows {
            let i: usize = index.parse().unwrap();
            let got = &out[i * MOVEMENT_WIDTH..(i + 1) * MOVEMENT_WIDTH];
            for (c, (g, e)) in got.iter().zip(want).enumerate() {
                assert!((g - e).abs() <= 1e-5, "window {} future {} row {i} column {c}: {g} vs {e}", w.start, w.future);
            }
        }
    }
}
