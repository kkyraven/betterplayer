use bp_detect::{Kind, Rect};
use bp_hero::{BUCKETS, WHITE_BUCKET, bucket_of};

use crate::detect::Found;


#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Override {
    pub tempo: f64,
    pub intensity: f64,
    pub playback_speed: f64,

    pub stroke_speed: Option<f64>,

    pub estim_max: Option<f64>,
    pub estim_max_relative: Option<f64>,

    pub vibe_max: Option<f64>,
}

impl Default for Override {
    fn default() -> Self {
        Override { tempo: 1.0, intensity: 1.0, playback_speed: 1.0, stroke_speed: None, estim_max: None, estim_max_relative: None, vibe_max: None }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ZoneTrigger {

    Colour([bool; BUCKETS]),

    CustomColour { buckets: [bool; BUCKETS], matches: Vec<(u32, f64)> },

    Part(Kind),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Zone {
    pub id: String,

    pub rect: Rect,
    pub trigger: ZoneTrigger,


    pub cover: f64,

    pub hold_ms: f64,
    pub effect: Override,
}


#[derive(Clone, Debug, PartialEq)]
pub struct ZoneMatch {
    pub id: String,

    pub share: f64,

    pub active: bool,

    pub leading: bool,
}

#[derive(Clone, Copy, Debug, Default)]
struct Match {
    share: f64,

    on: bool,

    since_ms: Option<f64>,

    last_ms: Option<f64>,
}


const HYSTERESIS: f64 = 0.7;

const DARK: f32 = 0.18;

const WHITE_MIN: f32 = 0.6;

const OPEN_END_MS: f64 = 1000.0;

pub struct ZoneState {
    pub enabled: bool,
    zones: Vec<Zone>,
    matches: Vec<Match>,
    last_ms: f64,
}

impl Default for ZoneState {
    fn default() -> Self {
        Self::new()
    }
}

impl ZoneState {
    pub fn new() -> ZoneState {
        ZoneState { enabled: false, zones: Vec::new(), matches: Vec::new(), last_ms: 0.0 }
    }


    pub fn set(&mut self, enabled: bool, zones: Vec<Zone>) {
        let matches = zones
            .iter()
            .map(|z| self.zones.iter().position(|o| o.id == z.id).map_or(Match::default(), |i| self.matches[i]))
            .collect();
        self.enabled = enabled;
        self.zones = zones;
        self.matches = matches;
    }


    pub fn wants_frames(&self) -> bool {
        self.enabled && self.zones.iter().any(|z| matches!(z.trigger, ZoneTrigger::Colour(_) | ZoneTrigger::CustomColour { .. }))
    }


    pub fn wants_detector(&self) -> bool {
        self.enabled && self.zones.iter().any(|z| matches!(z.trigger, ZoneTrigger::Part(_)))
    }


    pub fn reset(&mut self) {
        for m in &mut self.matches {
            *m = Match::default();
        }
        self.last_ms = 0.0;
    }

    fn clock(&mut self, time_ms: f64) {
        if time_ms < self.last_ms || time_ms - self.last_ms > 2000.0 {
            self.reset();
        }
        self.last_ms = time_ms;
    }

    fn observe(&mut self, i: usize, share: f64, time_ms: f64) {
        let cover = self.zones[i].cover;
        let m = &mut self.matches[i];
        m.share = share;
        let threshold = if m.on { cover * HYSTERESIS } else { cover };
        let hit = share > 0.0 && share >= threshold;
        if hit {
            if !m.on {
                m.on = true;
                m.since_ms = Some(time_ms);
            }
            m.last_ms = Some(time_ms);
        } else {
            m.on = false;
        }
    }


    pub fn push_colour(&mut self, rgb: &[u8], width: usize, height: usize, time_ms: f64) {
        if !self.enabled || width == 0 || height == 0 || rgb.len() < width * height * 3 {
            return;
        }
        self.clock(time_ms);
        for i in 0..self.zones.len() {
            let (buckets, matches) = match &self.zones[i].trigger {
                ZoneTrigger::Colour(buckets) => (buckets, &[][..]),
                ZoneTrigger::CustomColour { buckets, matches } => (buckets, matches.as_slice()),
                ZoneTrigger::Part(_) => continue,
            };
            let share = colour_share_matching(rgb, width, height, self.zones[i].rect, buckets, matches);
            self.observe(i, share, time_ms);
        }
    }


    pub fn push_boxes(&mut self, boxes: &[Found], time_ms: f64) {
        if !self.enabled {
            return;
        }
        self.clock(time_ms);
        for i in 0..self.zones.len() {
            let ZoneTrigger::Part(kind) = self.zones[i].trigger else {
                continue;
            };
            let rect = self.zones[i].rect;
            let share = boxes
                .iter()
                .filter(|b| kind.matches(b.class))
                .map(|b| overlap(rect, b.rect))
                .fold(0.0, f64::max);
            self.observe(i, share, time_ms);
        }
    }

    fn active(&self, i: usize, time_ms: f64) -> Option<(f64, f64)> {
        let m = self.matches[i];
        let since = m.since_ms?;
        let end = if m.on { time_ms + OPEN_END_MS } else { m.last_ms? + self.zones[i].hold_ms };
        (time_ms < end).then_some((since, end))
    }



    pub fn active_at(&self, time_ms: f64) -> Option<(f64, f64, &Override)> {
        if !self.enabled {
            return None;
        }
        (0..self.zones.len())
            .filter_map(|i| self.active(i, time_ms).map(|(s, e)| (s, e, &self.zones[i].effect)))
            .max_by(|a, b| a.0.total_cmp(&b.0))
    }

    pub fn snapshot(&self, time_ms: f64) -> Vec<ZoneMatch> {
        let leading = (0..self.zones.len())
            .filter_map(|i| self.active(i, time_ms).map(|(s, _)| (s, i)))
            .max_by(|a, b| a.0.total_cmp(&b.0))
            .map(|(_, i)| i);
        self.zones
            .iter()
            .enumerate()
            .map(|(i, z)| ZoneMatch { id: z.id.clone(), share: self.matches[i].share, active: self.active(i, time_ms).is_some(), leading: leading == Some(i) })
            .collect()
    }
}


fn zone_bucket(r: u8, g: u8, b: u8) -> Option<usize> {
    let max = r.max(g).max(b) as f32 / 255.0;
    if max < DARK {
        return None;
    }
    let bucket = bucket_of([r as f32, g as f32, b as f32]);
    if bucket == WHITE_BUCKET && max < WHITE_MIN {
        return None;
    }
    Some(bucket)
}


fn colour_share_matching(rgb: &[u8], width: usize, height: usize, rect: Rect, buckets: &[bool; BUCKETS], matches: &[(u32, f64)]) -> f64 {
    let px = |v: f64, n: usize| ((v * n as f64).round() as isize).clamp(0, n as isize) as usize;
    let (x0, y0, x1, y1) = (px(rect.x, width), px(rect.y, height), px(rect.x + rect.w, width), px(rect.y + rect.h, height));
    if x1 <= x0 || y1 <= y0 {
        return 0.0;
    }
    let mut hits = 0usize;
    for y in y0..y1 {
        let row = y * width;
        for x in x0..x1 {
            let i = (row + x) * 3;
            if zone_bucket(rgb[i], rgb[i + 1], rgb[i + 2]).is_some_and(|b| buckets[b])
                || matches.iter().any(|&(colour, tolerance)| bp_hero::colour_matches([rgb[i], rgb[i + 1], rgb[i + 2]], colour, tolerance)) {
                hits += 1;
            }
        }
    }
    hits as f64 / ((x1 - x0) * (y1 - y0)) as f64
}



fn overlap(zone: Rect, b: Rect) -> f64 {
    let w = (zone.x + zone.w).min(b.x + b.w) - zone.x.max(b.x);
    let h = (zone.y + zone.h).min(b.y + b.h) - zone.y.max(b.y);
    if w <= 0.0 || h <= 0.0 {
        return 0.0;
    }
    let smaller = (zone.w * zone.h).min(b.w * b.h);
    if smaller <= 0.0 {
        return 0.0;
    }
    ((w * h) / smaller).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 64;
    const H: usize = 36;

    fn frame(fill: [u8; 3], patch: Option<(Rect, [u8; 3])>) -> Vec<u8> {
        let mut rgb = vec![0u8; W * H * 3];
        for p in rgb.chunks_exact_mut(3) {
            p.copy_from_slice(&fill);
        }
        if let Some((r, c)) = patch {
            for y in 0..H {
                for x in 0..W {
                    let (fx, fy) = (x as f64 / W as f64, y as f64 / H as f64);
                    if fx >= r.x && fx < r.x + r.w && fy >= r.y && fy < r.y + r.h {
                        let i = (y * W + x) * 3;
                        rgb[i..i + 3].copy_from_slice(&c);
                    }
                }
            }
        }
        rgb
    }

    fn colour_zone(id: &str, bucket: usize, cover: f64, hold_ms: f64) -> Zone {
        let mut buckets = [false; BUCKETS];
        buckets[bucket] = true;
        Zone {
            id: id.into(),
            rect: Rect { x: 0.0, y: 0.0, w: 0.5, h: 0.5 },
            trigger: ZoneTrigger::Colour(buckets),
            cover,
            hold_ms,
            effect: Override { tempo: 2.0, ..Override::default() },
        }
    }

    const RED: [u8; 3] = [255, 40, 40];
    const BLACK: [u8; 3] = [8, 8, 8];

    #[test]
    fn colour_share_counts_the_zone_and_dark_pixels_are_nothing() {
        let mut z = ZoneState::new();
        z.set(true, vec![colour_zone("a", 0, 0.2, 500.0)]);

        z.push_colour(&frame(BLACK, Some((Rect { x: 0.0, y: 0.0, w: 0.25, h: 1.0 }, RED))), W, H, 1000.0);
        let s = z.snapshot(1000.0);
        assert!((s[0].share - 0.5).abs() < 0.05, "share {}", s[0].share);
        assert!(s[0].active);
        assert_eq!(z.active_at(1000.0).unwrap().2.tempo, 2.0);

        let mut white = [false; BUCKETS];
        white[WHITE_BUCKET] = true;
        z.set(true, vec![Zone { trigger: ZoneTrigger::Colour(white), ..colour_zone("w", 0, 0.2, 500.0) }]);
        z.push_colour(&frame([60, 60, 60], None), W, H, 1100.0);
        assert_eq!(z.snapshot(1100.0)[0].share, 0.0);
        z.push_colour(&frame([240, 240, 240], None), W, H, 1200.0);
        assert!(z.snapshot(1200.0)[0].active);
    }

    #[test]
    fn custom_colours_request_frames_and_measure_tolerance() {
        let mut z = ZoneState::new();
        let zone = Zone { trigger: ZoneTrigger::CustomColour { buckets: [false; BUCKETS], matches: vec![(0xff2828, 0.1)] }, ..colour_zone("custom", 0, 0.2, 0.0) };
        z.set(true, vec![zone]);
        assert!(z.wants_frames());
        assert!(!z.wants_detector());
        z.push_colour(&frame([255, 60, 60], None), W, H, 1000.0);
        assert_eq!(z.snapshot(1000.0)[0].share, 1.0);
        z.push_colour(&frame([255, 80, 80], None), W, H, 1100.0);
        assert_eq!(z.snapshot(1100.0)[0].share, 0.0);
        assert!(z.active_at(1100.0).is_none());
    }

    #[test]
    fn hold_keeps_the_effect_and_a_seek_drops_it() {
        let mut z = ZoneState::new();
        z.set(true, vec![colour_zone("a", 0, 0.2, 500.0)]);
        z.push_colour(&frame(RED, None), W, H, 1000.0);
        z.push_colour(&frame(BLACK, None), W, H, 1033.0);
        assert!(z.active_at(1400.0).is_some(), "within the hold");
        assert!(z.active_at(1600.0).is_none(), "after the hold");
        z.push_colour(&frame(RED, None), W, H, 2000.0);
        assert!(z.active_at(2000.0).is_some());
        z.reset();
        assert!(z.active_at(2000.0).is_none());
        z.enabled = false;
        z.push_colour(&frame(RED, None), W, H, 2100.0);
        assert!(z.active_at(2100.0).is_none());
    }

    #[test]
    fn the_newest_match_wins_and_keeps_its_start() {
        let mut z = ZoneState::new();
        let mut b = colour_zone("b", 6, 0.2, 500.0);
        b.rect = Rect { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
        b.effect.tempo = 0.5;
        z.set(true, vec![colour_zone("a", 0, 0.2, 500.0), b]);
        z.push_colour(&frame(BLACK, Some((Rect { x: 0.0, y: 0.0, w: 0.5, h: 0.5 }, RED))), W, H, 1000.0);
        assert_eq!(z.active_at(1000.0).unwrap().2.tempo, 2.0);

        let mut both = frame(BLACK, Some((Rect { x: 0.0, y: 0.0, w: 0.5, h: 0.5 }, RED)));
        let cyan = frame(BLACK, Some((Rect { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, [40, 230, 255])));
        for (d, s) in both.iter_mut().zip(cyan.iter()) {
            if *s != BLACK[0] {
                *d = *s;
            }
        }
        z.push_colour(&both, W, H, 1500.0);
        let (start, _, effect) = z.active_at(1500.0).unwrap();
        assert_eq!((start, effect.tempo), (1500.0, 0.5));
        z.push_colour(&frame(BLACK, Some((Rect { x: 0.0, y: 0.0, w: 0.5, h: 0.5 }, RED))), W, H, 2100.0);
        let (start, _, effect) = z.active_at(2100.0).unwrap();
        assert_eq!((start, effect.tempo), (1000.0, 2.0));
        let s = z.snapshot(2100.0);
        assert!(s[0].leading && s[0].active && !s[1].leading);
    }

    #[test]
    fn a_part_zone_reads_the_boxes_and_a_changed_setup_keeps_standing_by_id() {
        let mut z = ZoneState::new();
        let part = Zone {
            id: "p".into(),
            rect: Rect { x: 0.5, y: 0.0, w: 0.5, h: 0.5 },
            trigger: ZoneTrigger::Part(Kind::Faces),
            cover: 0.5,
            hold_ms: 0.0,
            effect: Override { estim_max: Some(0.9), ..Override::default() },
        };
        z.set(true, vec![part.clone()]);
        assert!(z.wants_detector() && !z.wants_frames());
        let face = Found { rect: Rect { x: 0.6, y: 0.1, w: 0.2, h: 0.2 }, class: "FACE_FEMALE", confidence: 0.9 };
        let breast = Found { rect: Rect { x: 0.6, y: 0.1, w: 0.2, h: 0.2 }, class: "FEMALE_BREAST_EXPOSED", confidence: 0.9 };
        z.push_boxes(&[breast], 1000.0);
        assert!(z.active_at(1000.0).is_none());
        z.push_boxes(&[breast, face], 1100.0);
        assert_eq!(z.active_at(1100.0).unwrap().2.estim_max, Some(0.9));
        assert_eq!(z.snapshot(1100.0)[0].share, 1.0);

        z.set(true, vec![Zone { effect: Override { tempo: 3.0, ..Override::default() }, ..part.clone() }]);
        assert_eq!(z.active_at(1100.0).unwrap().2.tempo, 3.0);
        z.set(true, vec![Zone { id: "q".into(), ..part }]);
        assert!(z.active_at(1100.0).is_none());
    }

    #[test]
    fn overlap_is_over_the_smaller_box() {
        let zone = Rect { x: 0.0, y: 0.0, w: 0.5, h: 0.5 };
        assert_eq!(overlap(zone, Rect { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }), 1.0);
        assert_eq!(overlap(zone, Rect { x: -0.5, y: -0.5, w: 2.0, h: 2.0 }), 1.0);
        assert!((overlap(zone, Rect { x: 0.25, y: 0.0, w: 0.5, h: 0.5 }) - 0.5).abs() < 1e-9);
        assert_eq!(overlap(zone, Rect { x: 0.6, y: 0.6, w: 0.1, h: 0.1 }), 0.0);
    }
}
