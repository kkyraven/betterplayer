//! Hero source: cock hero videos scroll notes (circles, hearts, bars) toward a target the user
//! draws on the video. This watches the lane leading into that zone, follows each note as it
//! approaches, and predicts when it lands (PLAN Phase 4b, item 6).
//!
//! Per RGB frame: the lane's pixels are masked to what looks like a note (saturated or bright,
//! and unlike the slowly learned background), the mask is projected onto the lane's axis, and
//! the runs along it are the notes. Runs are matched to tracks by predicted position; a track
//! seen a few times moving toward the zone gets a hit time from its distance over its speed,
//! refined as it comes closer. Each hit carries a colour bucket and a size. The scroll
//! direction is picked from the first consistent tracks when left on Auto.

/// A rectangle in 0..1 of the frame, top-left origin.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Which way notes travel into the zone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Auto,
    RightToLeft,
    LeftToRight,
    TopDown,
    BottomUp,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::Auto => "auto",
            Direction::RightToLeft => "right-to-left",
            Direction::LeftToRight => "left-to-right",
            Direction::TopDown => "top-down",
            Direction::BottomUp => "bottom-up",
        }
    }

    pub fn from_str(s: &str) -> Option<Direction> {
        match s {
            "auto" => Some(Direction::Auto),
            "right-to-left" => Some(Direction::RightToLeft),
            "left-to-right" => Some(Direction::LeftToRight),
            "top-down" => Some(Direction::TopDown),
            "bottom-up" => Some(Direction::BottomUp),
            _ => None,
        }
    }

    const LANES: [Direction; 4] = [Direction::RightToLeft, Direction::LeftToRight, Direction::TopDown, Direction::BottomUp];

    fn horizontal(self) -> bool {
        matches!(self, Direction::RightToLeft | Direction::LeftToRight)
    }

    /// Sign of a note's motion along the lane axis (x or y) as it approaches the zone.
    fn sign(self) -> f64 {
        match self {
            Direction::RightToLeft | Direction::BottomUp => -1.0,
            _ => 1.0,
        }
    }
}

/// Colour buckets a note can fall in: twelve hues of 30 degrees, plus white.
pub const HUE_BUCKETS: usize = 12;
pub const WHITE_BUCKET: usize = HUE_BUCKETS;
pub const BUCKETS: usize = HUE_BUCKETS + 1;

/// Names for the buckets, in bucket order.
pub const BUCKET_NAMES: [&str; BUCKETS] = ["Red", "Orange", "Yellow", "Lime", "Green", "Teal", "Cyan", "Azure", "Blue", "Violet", "Magenta", "Pink", "White"];

/// A predicted landing, first reported a few frames after the note appears and updated as it
/// nears; `id` ties the updates together.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hit {
    pub id: u64,
    /// Media time the note reaches the zone's centre.
    pub at_ms: f64,
    pub bucket: usize,
    /// Mean colour of the note, 0..255.
    pub rgb: [u8; 3],
    /// Length of the note along the lane over the zone's length, so a bar reads bigger than a dot.
    pub size: f64,
    /// The note is within a frame of the zone: the last word on this hit.
    pub settled: bool,
}

/// A note in the lane right now, for drawing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Note {
    /// Position along the lane axis in 0..1 of the frame.
    pub pos: f64,
    pub size: f64,
    pub rgb: [u8; 3],
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Options {
    pub zone: Rect,
    pub direction: Direction,
}

/// Pixels differing from the learned background by more than this (max channel) count.
const BG_DIFF: f32 = 45.0;
/// Learning rate of the background per frame.
const BG_ALPHA: f32 = 0.03;
/// A note pixel is saturated or bright on top of being foreground.
const MIN_SATURATION: f32 = 0.35;
const MIN_BRIGHT_WHITE: f32 = 0.85;
/// Fraction of the lane's width a column must have masked before it is part of a run.
const RUN_FILL: f32 = 0.25;
/// Runs shorter than this many pixels are noise (a tick mark is two wide at 384).
const MIN_RUN_PX: usize = 2;
/// Frames a track needs before it predicts a hit.
const MIN_OBSERVATIONS: u32 = 3;
/// A track unseen for this many frames is dropped.
const MAX_MISSES: u32 = 4;
/// Auto score (arrivals discounted by how much their speeds vary) a lane needs before Auto
/// commits to it, and how far ahead of every other lane it must be: the picture itself makes
/// tracks too, but its motion neither keeps arriving at the zone nor at one speed.
const AUTO_COMMIT: f64 = 5.0;
const AUTO_LEAD: f64 = 1.5;

struct Track {
    id: u64,
    pos: f64,
    velocity: f64,
    last_ms: f64,
    observations: u32,
    misses: u32,
    bucket: usize,
    rgb: [f32; 3],
    size: f64,
    /// Set once the hit has been reported as settled.
    done: bool,
    /// Set once the arrival has been counted for Auto.
    counted: bool,
}

/// Background, tracks and the projection for one candidate lane.
struct Lane {
    direction: Direction,
    /// Pixel rect in the frame the lane covers, including the zone.
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    background: Vec<[f32; 3]>,
    frames: u32,
    tracks: Vec<Track>,
    /// Speeds (px per ms) of the notes that reached the zone along this lane, for Auto: a real
    /// lane's notes arrive steadily and at one speed, the picture's motion does neither.
    arrivals: Vec<f64>,
    profile: Vec<f32>,
    colour: Vec<[f32; 3]>,
}

pub struct Hero {
    options: Options,
    size: (usize, usize),
    lanes: Vec<Lane>,
    /// The lane Auto settled on, or the one the option names.
    chosen: Option<Direction>,
    next_id: u64,
    hits: Vec<Hit>,
    notes: Vec<Note>,
}

impl Hero {
    pub fn new(options: Options) -> Hero {
        Hero { options, size: (0, 0), lanes: Vec::new(), chosen: None, next_id: 1, hits: Vec::new(), notes: Vec::new() }
    }

    pub fn options(&self) -> Options {
        self.options
    }

    /// A new zone or direction starts the lanes over.
    pub fn set_options(&mut self, options: Options) {
        if self.options != options {
            self.options = options;
            self.lanes.clear();
            self.chosen = None;
        }
    }

    /// The direction in use: the option, or what Auto found, or `None` while it is looking.
    pub fn direction(&self) -> Option<Direction> {
        self.chosen
    }

    /// Hits reported by the last `push`: new ones and updates.
    pub fn hits(&self) -> &[Hit] {
        &self.hits
    }

    /// Notes in the lane after the last `push`.
    pub fn notes(&self) -> &[Note] {
        &self.notes
    }

    /// One packed RGB frame with its media time.
    pub fn push(&mut self, rgb: &[u8], width: usize, height: usize, time_ms: f64) {
        self.hits.clear();
        self.notes.clear();
        if width < 16 || height < 16 || rgb.len() < width * height * 3 {
            return;
        }
        if self.size != (width, height) || self.lanes.is_empty() {
            self.size = (width, height);
            self.build_lanes();
        }
        let active: Vec<usize> = match self.chosen {
            Some(d) => self.lanes.iter().position(|l| l.direction == d).into_iter().collect(),
            None => (0..self.lanes.len()).collect(),
        };
        for i in active {
            let lane = &mut self.lanes[i];
            let zone_centre = zone_centre(self.options.zone, lane.direction, width, height);
            let zone_len = zone_length(self.options.zone, lane.direction, width, height);
            lane.observe(rgb, width, time_ms);
            let runs = lane.runs();
            lane.assign(runs, time_ms, zone_centre, zone_len, &mut self.next_id);
            if self.chosen.is_some() {
                lane.report(time_ms, zone_centre, zone_len, &mut self.hits, &mut self.notes, width, height);
            }
        }
        if self.chosen.is_none() {
            let scores: Vec<(Direction, f64)> = self.lanes.iter().map(|l| (l.direction, l.auto_score())).collect();
            if let Some(&(d, best)) = scores.iter().max_by(|a, b| a.1.total_cmp(&b.1)) {
                let next = scores.iter().filter(|s| s.0 != d).map(|s| s.1).fold(0.0, f64::max);
                if best >= AUTO_COMMIT && best >= next * AUTO_LEAD {
                    self.chosen = Some(d);
                }
            }
        }
    }

    /// Lanes from the zone out to the frame's edge, one per candidate direction (or the one
    /// asked for), each ending where the frame does.
    fn build_lanes(&mut self) {
        let (w, h) = self.size;
        let z = self.options.zone;
        let px = |v: f64, n: usize| ((v * n as f64).round() as isize).clamp(0, n as isize) as usize;
        let (zx0, zy0, zx1, zy1) = (px(z.x, w), px(z.y, h), px(z.x + z.w, w), px(z.y + z.h, h));
        let dirs: Vec<Direction> = match self.options.direction {
            Direction::Auto => Direction::LANES.to_vec(),
            d => vec![d],
        };
        self.lanes = dirs
            .into_iter()
            .map(|direction| {
                let (x0, y0, x1, y1) = match direction {
                    Direction::RightToLeft => (zx0, zy0, w, zy1),
                    Direction::LeftToRight => (0, zy0, zx1, zy1),
                    Direction::TopDown => (zx0, 0, zx1, zy1),
                    Direction::BottomUp | Direction::Auto => (zx0, zy0, zx1, h),
                };
                let n = (x1 - x0) * (y1 - y0);
                let len = if direction.horizontal() { x1 - x0 } else { y1 - y0 };
                Lane { direction, x0, y0, x1, y1, background: vec![[0.0; 3]; n], frames: 0, tracks: Vec::new(), arrivals: Vec::new(), profile: vec![0.0; len], colour: vec![[0.0; 3]; len] }
            })
            .collect();
        self.chosen = match self.options.direction {
            Direction::Auto => None,
            d => Some(d),
        };
    }
}

/// The zone's centre along the lane axis, in pixels.
fn zone_centre(z: Rect, d: Direction, w: usize, h: usize) -> f64 {
    if d.horizontal() { (z.x + z.w / 2.0) * w as f64 } else { (z.y + z.h / 2.0) * h as f64 }
}

fn zone_length(z: Rect, d: Direction, w: usize, h: usize) -> f64 {
    (if d.horizontal() { z.w * w as f64 } else { z.h * h as f64 }).max(1.0)
}

impl Lane {
    /// Learns the background and projects the note mask onto the lane axis.
    fn observe(&mut self, rgb: &[u8], width: usize, _time_ms: f64) {
        let lane_w = self.x1 - self.x0;
        let lane_h = self.y1 - self.y0;
        for v in &mut self.profile {
            *v = 0.0;
        }
        for c in &mut self.colour {
            *c = [0.0; 3];
        }
        let first = self.frames == 0;
        for y in self.y0..self.y1 {
            for x in self.x0..self.x1 {
                let i = (y * width + x) * 3;
                let p = [rgb[i] as f32, rgb[i + 1] as f32, rgb[i + 2] as f32];
                let b = &mut self.background[(y - self.y0) * lane_w + (x - self.x0)];
                let diff = if first {
                    *b = p;
                    0.0
                } else {
                    let d = (p[0] - b[0]).abs().max((p[1] - b[1]).abs()).max((p[2] - b[2]).abs());
                    for k in 0..3 {
                        b[k] += BG_ALPHA * (p[k] - b[k]);
                    }
                    d
                };
                if diff < BG_DIFF {
                    continue;
                }
                let max = p[0].max(p[1]).max(p[2]);
                let min = p[0].min(p[1]).min(p[2]);
                let sat = if max > 0.0 { (max - min) / max } else { 0.0 };
                if sat < MIN_SATURATION && max / 255.0 < MIN_BRIGHT_WHITE {
                    continue;
                }
                let k = if self.direction.horizontal() { x - self.x0 } else { y - self.y0 };
                self.profile[k] += 1.0;
                for c in 0..3 {
                    self.colour[k][c] += p[c];
                }
            }
        }
        let across = if self.direction.horizontal() { lane_h } else { lane_w } as f32;
        for k in 0..self.profile.len() {
            let n = self.profile[k];
            if n > 0.0 {
                for c in 0..3 {
                    self.colour[k][c] /= n;
                }
            }
            self.profile[k] = n / across.max(1.0);
        }
        self.frames += 1;
    }

    /// Runs along the profile: (centre px, length px, mean colour).
    fn runs(&self) -> Vec<(f64, usize, [f32; 3])> {
        let mut out = Vec::new();
        let mut start: Option<usize> = None;
        let n = self.profile.len();
        for k in 0..=n {
            let on = k < n && self.profile[k] >= RUN_FILL;
            match (start, on) {
                (None, true) => start = Some(k),
                (Some(s), false) => {
                    if k - s >= MIN_RUN_PX {
                        let mut col = [0.0f32; 3];
                        for j in s..k {
                            for c in 0..3 {
                                col[c] += self.colour[j][c];
                            }
                        }
                        for c in &mut col {
                            *c /= (k - s) as f32;
                        }
                        out.push(((s + k) as f64 / 2.0, k - s, col));
                    }
                    start = None;
                }
                _ => {}
            }
        }
        out
    }

    /// Matches runs to tracks by predicted position, updates velocities, starts tracks for the
    /// rest and drops the ones that went missing.
    fn assign(&mut self, runs: Vec<(f64, usize, [f32; 3])>, time_ms: f64, zone_centre: f64, zone_len: f64, next_id: &mut u64) {
        let origin = if self.direction.horizontal() { self.x0 } else { self.y0 } as f64;
        let mut used = vec![false; runs.len()];
        for t in &mut self.tracks {
            let dt = (time_ms - t.last_ms).max(1.0);
            let predicted = t.pos + t.velocity * dt;
            let window = (zone_len * 0.75).max(8.0);
            let best = runs.iter().enumerate().filter(|(i, r)| !used[*i] && (r.0 + origin - predicted).abs() < window).min_by(|a, b| (a.1.0 + origin - predicted).abs().total_cmp(&(b.1.0 + origin - predicted).abs()));
            match best {
                Some((i, r)) => {
                    used[i] = true;
                    let pos = r.0 + origin;
                    let v = (pos - t.pos) / dt;
                    t.velocity = if t.observations < 2 { v } else { t.velocity * 0.6 + v * 0.4 };
                    t.pos = pos;
                    t.last_ms = time_ms;
                    t.observations += 1;
                    t.misses = 0;
                    for c in 0..3 {
                        t.rgb[c] = t.rgb[c] * 0.7 + r.2[c] * 0.3;
                    }
                    t.bucket = bucket_of(t.rgb);
                    t.size = r.1 as f64 / zone_len;
                }
                None => {
                    t.misses += 1;
                    t.pos = predicted;
                    t.last_ms = time_ms;
                }
            }
        }
        self.tracks.retain(|t| t.misses <= MAX_MISSES && !(t.done && (t.pos - zone_centre) * self.direction.sign() > zone_len));
        for (i, r) in runs.iter().enumerate() {
            if used[i] {
                continue;
            }
            let pos = r.0 + origin;
            // A run already past the zone cannot be an approaching note.
            if (pos - zone_centre) * self.direction.sign() > zone_len * 0.5 {
                continue;
            }
            self.tracks.push(Track { id: *next_id, pos, velocity: 0.0, last_ms: time_ms, observations: 1, misses: 0, bucket: bucket_of(r.2), rgb: r.2, size: r.1 as f64 / zone_len, done: false, counted: false });
            *next_id += 1;
        }
        // A note that was coming this way and is now at the zone has arrived.
        let sign = self.direction.sign();
        for t in &mut self.tracks {
            if !t.counted && t.observations >= MIN_OBSERVATIONS && t.velocity * sign > 0.02 && (zone_centre - t.pos) * sign < zone_len * 0.75 {
                t.counted = true;
                self.arrivals.push(t.velocity * sign);
            }
        }
    }

    /// Arrivals, discounted by the spread of their speeds.
    fn auto_score(&self) -> f64 {
        let n = self.arrivals.len();
        if n == 0 {
            return 0.0;
        }
        let mean = self.arrivals.iter().sum::<f64>() / n as f64;
        let var = self.arrivals.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / n as f64;
        let cv = if mean > 0.0 { var.sqrt() / mean } else { 1.0 };
        n as f64 / (1.0 + 4.0 * cv)
    }

    /// Hits for tracks approaching the zone, and every note for drawing.
    fn report(&mut self, time_ms: f64, zone_centre: f64, zone_len: f64, hits: &mut Vec<Hit>, notes: &mut Vec<Note>, width: usize, height: usize) {
        let sign = self.direction.sign();
        let span = if self.direction.horizontal() { width } else { height } as f64;
        for t in &mut self.tracks {
            if t.misses == 0 {
                notes.push(Note { pos: t.pos / span, size: t.size, rgb: [t.rgb[0] as u8, t.rgb[1] as u8, t.rgb[2] as u8] });
            }
            if t.done || t.observations < MIN_OBSERVATIONS {
                continue;
            }
            let speed = t.velocity * sign;
            if speed <= 0.02 {
                continue;
            }
            let distance = (zone_centre - t.pos) * sign;
            let at_ms = time_ms + distance / speed;
            let settled = distance <= speed * 40.0 || distance < zone_len * 0.25;
            if settled {
                t.done = true;
            }
            hits.push(Hit { id: t.id, at_ms, bucket: t.bucket, rgb: [t.rgb[0] as u8, t.rgb[1] as u8, t.rgb[2] as u8], size: t.size, settled });
        }
    }
}

/// Hue bucket of a colour, or the white bucket for a pale one.
pub fn bucket_of(rgb: [f32; 3]) -> usize {
    let (r, g, b) = (rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    if max <= 0.0 || d / max < 0.25 {
        return WHITE_BUCKET;
    }
    let hue = if max == r {
        60.0 * (((g - b) / d) % 6.0)
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    let hue = if hue < 0.0 { hue + 360.0 } else { hue };
    ((hue / 30.0).floor() as usize).min(HUE_BUCKETS - 1)
}

/// A first intensity for a bucket by vibes: warm strong, cool soft, white in between.
pub fn default_intensity(bucket: usize) -> f64 {
    match bucket {
        WHITE_BUCKET => 0.6,
        0..=2 | 10..=11 => 0.9,
        _ => 0.4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 384;
    const H: usize = 216;

    /// A dark lane across the middle with the zone at the left; `notes` are (x centre, colour)
    /// discs of radius 8.
    fn frame(notes: &[(f64, [u8; 3])], out: &mut Vec<u8>) {
        out.clear();
        out.resize(W * H * 3, 0);
        for y in 0..H {
            for x in 0..W {
                let i = (y * W + x) * 3;
                let lane = (90..126).contains(&y);
                let v = if lane { 24 } else { 70 + ((x * 7 + y * 3) % 40) as u8 };
                out[i] = v;
                out[i + 1] = v;
                out[i + 2] = v + 5;
            }
        }
        for &(cx, rgb) in notes {
            for y in 100..116 {
                for x in 0..W {
                    let (dx, dy) = (x as f64 - cx, y as f64 - 108.0);
                    if dx * dx + dy * dy <= 64.0 {
                        let i = (y * W + x) * 3;
                        out[i..i + 3].copy_from_slice(&rgb);
                    }
                }
            }
        }
    }

    fn zone() -> Rect {
        Rect { x: 0.1, y: 0.4, w: 0.08, h: 0.2 }
    }

    /// Notes at 200 px/s from the right, one every 600 ms, alternating pink and blue. Returns
    /// the settled hits: (id, predicted ms, bucket, true ms).
    fn run(direction: Direction, frames: usize) -> (Hero, Vec<(u64, f64, usize, f64)>) {
        let mut hero = Hero::new(Options { zone: zone(), direction });
        let mut buf = Vec::new();
        let mut seen: Vec<(u64, f64, usize, f64)> = Vec::new();
        let zone_x = (0.1 + 0.04) * W as f64;
        for f in 0..frames {
            let t = f as f64 * 1000.0 / 30.0;
            let mut notes = Vec::new();
            for k in 0..20 {
                let launch = k as f64 * 600.0;
                let x = W as f64 + 20.0 - (t - launch) * 0.2;
                if x > 10.0 && x < W as f64 + 20.0 && t >= launch {
                    notes.push((x, if k % 2 == 0 { [255u8, 92, 138] } else { [94u8, 200, 255] }));
                }
            }
            frame(&notes, &mut buf);
            hero.push(&buf, W, H, t);
            for h in hero.hits().iter().filter(|h| h.settled) {
                // The truth: note k reaches the zone centre at launch + (W + 20 - zone_x) / 0.2.
                let expected = (0..20).map(|k| k as f64 * 600.0 + (W as f64 + 20.0 - zone_x) / 0.2).min_by(|a, b| (a - h.at_ms).abs().total_cmp(&(b - h.at_ms).abs())).unwrap();
                seen.push((h.id, h.at_ms, h.bucket, expected));
            }
        }
        (hero, seen)
    }

    #[test]
    fn predicts_hits_with_the_right_colours() {
        let (hero, seen) = run(Direction::RightToLeft, 150);
        assert_eq!(hero.direction(), Some(Direction::RightToLeft));
        assert!(seen.len() >= 5, "hits seen: {}", seen.len());
        for (id, at, bucket, expected) in &seen {
            assert!((at - expected).abs() < 40.0, "hit {id} at {at:.0} vs {expected:.0}");
            assert!(*bucket == 11 || *bucket == 6, "hit {id} bucket {bucket}");
        }
        assert!(seen.iter().any(|s| s.2 == 11) && seen.iter().any(|s| s.2 == 6), "both colours: {seen:?}");
    }

    #[test]
    fn auto_finds_the_direction() {
        let (hero, seen) = run(Direction::Auto, 270);
        assert_eq!(hero.direction(), Some(Direction::RightToLeft));
        assert!(seen.len() >= 3, "hits after settling: {}", seen.len());
    }

    #[test]
    fn buckets_and_defaults() {
        assert_eq!(bucket_of([255.0, 92.0, 138.0]), 11);
        assert_eq!(bucket_of([94.0, 200.0, 255.0]), 6);
        assert_eq!(bucket_of([255.0, 181.0, 71.0]), 1);
        assert_eq!(bucket_of([240.0, 240.0, 240.0]), WHITE_BUCKET);
        assert_eq!(default_intensity(11), 0.9);
        assert_eq!(default_intensity(6), 0.4);
        assert_eq!(default_intensity(WHITE_BUCKET), 0.6);
    }
}
