//! The Hero source's home in the engine: the note watcher fed from the track worker's colour
//! frames, the colour table, and the script that grows as hits are predicted.

use std::collections::HashMap;

use bp_hero::{BUCKETS, Direction, Hero, Hit, Note, Options, Rect};
use bp_script::{Action, Axis, Script};

/// What a colour does on top of the stroke that ends low on its hit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flourish {
    None,
    /// Stays low a moment after the hit.
    Hold,
    /// A short buzz after the hit.
    Vibrate,
    /// Two strokes into the hit instead of one.
    Double,
    /// Three strokes into the hit.
    Triple,
    /// Waits at the top and drops late.
    Slam,
    /// One rebound to the middle after the hit.
    Bounce,
    /// The stroke ends high on the hit instead of low.
    Rise,
    /// Past the hit to the axis's full extreme, then back.
    Whip,
    /// Full-range swings after the hit.
    Shake,
    /// A slow, wide oscillation held after the hit.
    Grind,
}

impl Flourish {
    pub const ALL: [Flourish; 11] = [
        Flourish::None, Flourish::Hold, Flourish::Vibrate, Flourish::Double, Flourish::Triple, Flourish::Slam,
        Flourish::Bounce, Flourish::Rise, Flourish::Whip, Flourish::Shake, Flourish::Grind,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Flourish::None => "none",
            Flourish::Hold => "hold",
            Flourish::Vibrate => "vibrate",
            Flourish::Double => "double",
            Flourish::Triple => "triple",
            Flourish::Slam => "slam",
            Flourish::Bounce => "bounce",
            Flourish::Rise => "rise",
            Flourish::Whip => "whip",
            Flourish::Shake => "shake",
            Flourish::Grind => "grind",
        }
    }

    pub fn from_str(s: &str) -> Option<Flourish> {
        Self::ALL.into_iter().find(|f| f.as_str() == s)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColourRule {
    pub intensity: f64,
    pub flourish: Flourish,
    /// 0 keeps the stroke's straight legs; 1 eases every leg in and out.
    pub smooth: f64,
    /// Hits in this colour make no stroke at all.
    pub ignore: bool,
}

impl ColourRule {
    fn default_for(bucket: usize) -> ColourRule {
        ColourRule { intensity: bp_hero::default_intensity(bucket), flourish: Flourish::None, smooth: 0.0, ignore: false }
    }
}

/// A leg eased by `s`: linear at 0, a smoothstep at 1.
fn ease(u: f64, s: f64) -> f64 {
    u + s * (u * u * (3.0 - 2.0 * u) - u)
}

/// Legs shorter than this stay straight; nothing is gained subdividing a buzz.
const SMOOTH_MIN_MS: f64 = 60.0;
const SMOOTH_STEPS: usize = 6;

#[derive(Clone, Debug)]
pub struct HeroSnapshot {
    pub zone: Option<Rect>,
    pub direction: Direction,
    /// What Auto settled on, or the option; `None` while Auto is still looking.
    pub found: Option<Direction>,
    pub notes: Vec<Note>,
    /// Hits seen per colour bucket.
    pub seen: [u32; BUCKETS],
    pub colours: [ColourRule; BUCKETS],
    pub next_hit_ms: Option<f64>,
    pub hits: u64,
}

/// A hit as the generator sees it, the latest prediction per note.
#[derive(Clone, Copy, Debug)]
struct Pending {
    id: u64,
    at_ms: f64,
    bucket: usize,
    size: f64,
    settled: bool,
}

/// Hits older than this fall out of the script; nothing plays backwards that far.
const KEEP_MS: f64 = 60_000.0;

pub struct HeroState {
    pub zone: Option<Rect>,
    pub direction: Direction,
    /// The colour table every axis follows unless it has its own.
    pub colours: [ColourRule; BUCKETS],
    /// Axes with their own table.
    pub axis_colours: HashMap<Axis, [ColourRule; BUCKETS]>,
    watcher: Option<Hero>,
    pending: Vec<Pending>,
    seen: [u32; BUCKETS],
    hits: u64,
    last_ms: f64,
    /// How far back hits are kept; a whole-file generation keeps every one.
    keep_ms: f64,
}

impl HeroState {
    pub fn new() -> HeroState {
        HeroState {
            zone: None,
            direction: Direction::Auto,
            colours: std::array::from_fn(ColourRule::default_for),
            axis_colours: HashMap::new(),
            watcher: None,
            pending: Vec::new(),
            seen: [0; BUCKETS],
            hits: 0,
            last_ms: 0.0,
            keep_ms: KEEP_MS,
        }
    }

    /// The same zone, direction and colour tables with a fresh watcher that keeps every hit,
    /// for a run through the whole file that must not disturb the live one.
    pub fn fresh(&self) -> HeroState {
        HeroState {
            zone: self.zone,
            direction: self.direction,
            colours: self.colours,
            axis_colours: self.axis_colours.clone(),
            watcher: self.zone.map(|zone| Hero::new(Options { zone, direction: self.direction })),
            pending: Vec::new(),
            seen: [0; BUCKETS],
            hits: 0,
            last_ms: 0.0,
            keep_ms: f64::INFINITY,
        }
    }

    pub fn set_options(&mut self, zone: Option<Rect>, direction: Direction) {
        self.zone = zone;
        self.direction = direction;
        match (zone, &mut self.watcher) {
            (Some(z), Some(w)) => w.set_options(Options { zone: z, direction }),
            (Some(z), None) => self.watcher = Some(Hero::new(Options { zone: z, direction })),
            (None, _) => self.watcher = None,
        }
        self.pending.clear();
    }

    /// One colour frame. Returns whether the script changed.
    pub fn push(&mut self, rgb: &[u8], width: usize, height: usize, time_ms: f64) -> bool {
        let Some(w) = self.watcher.as_mut() else { return false };
        w.push(rgb, width, height, time_ms);
        self.last_ms = time_ms;
        let hits: Vec<Hit> = w.hits().to_vec();
        if hits.is_empty() {
            return false;
        }
        for h in hits {
            match self.pending.iter_mut().find(|p| p.id == h.id) {
                Some(p) => {
                    if !p.settled {
                        *p = Pending { id: h.id, at_ms: h.at_ms, bucket: h.bucket, size: h.size, settled: h.settled };
                    }
                }
                None => {
                    self.pending.push(Pending { id: h.id, at_ms: h.at_ms, bucket: h.bucket, size: h.size, settled: h.settled });
                    self.seen[h.bucket] += 1;
                    self.hits += 1;
                }
            }
        }
        self.pending.retain(|p| p.at_ms > time_ms - self.keep_ms);
        self.pending.sort_by(|a, b| a.at_ms.total_cmp(&b.at_ms));
        true
    }

    /// The table an axis uses: its own, or the shared one.
    pub fn colours_for(&self, axis: Axis) -> &[ColourRule; BUCKETS] {
        self.axis_colours.get(&axis).unwrap_or(&self.colours)
    }

    /// The script for one axis from the hits so far: low on every hit, the top midway from the
    /// previous one (or a stroke's length before a lone hit), depth from the colour and size,
    /// with the colour's flourish and smoothing. A rotation axis alternates direction instead.
    /// Ignored colours leave no trace, as if the note were never there.
    pub fn script(&self, axis: Axis, intensity: f64, invert: bool, alternate: bool) -> Script {
        let colours = self.colours_for(axis);
        // (at, pos, smoothing of the leg that ends here)
        let mut keys: Vec<(f64, f64, f64)> = Vec::with_capacity(self.pending.len() * 6);
        let mut push = |at: f64, pos: f64, smooth: f64| {
            let pos = if invert { 1.0 - pos } else { pos };
            match keys.last_mut() {
                Some(last) if at <= last.0 + 1.0 => last.1 = pos.clamp(0.0, 1.0),
                _ => keys.push((at, pos.clamp(0.0, 1.0), smooth)),
            }
        };
        let mut prev_at: Option<f64> = None;
        let mut i = 0;
        for p in &self.pending {
            let rule = colours[p.bucket];
            if rule.ignore {
                continue;
            }
            let d = (0.5 * rule.intensity * intensity * (0.8 + 0.1 * p.size).clamp(0.8, 1.2)).clamp(0.0, 0.5);
            let sign = if alternate && i % 2 == 1 { -1.0 } else { 1.0 };
            i += 1;
            let (mut low, mut high) = (0.5 - d * sign, 0.5 + d * sign);
            if rule.flourish == Flourish::Rise {
                std::mem::swap(&mut low, &mut high);
            }
            let s = rule.smooth.clamp(0.0, 1.0);
            let gap = prev_at.map_or(600.0, |t| p.at_ms - t);
            let top_at = if gap > 1200.0 { p.at_ms - 400.0 } else { p.at_ms - gap / 2.0 };
            match rule.flourish {
                Flourish::Double if gap <= 1200.0 => {
                    let q = gap / 4.0;
                    push(p.at_ms - 3.0 * q, high, s);
                    push(p.at_ms - 2.0 * q, low, s);
                    push(p.at_ms - q, high, s);
                }
                Flourish::Triple if gap <= 1200.0 => {
                    let q = gap / 6.0;
                    push(p.at_ms - 5.0 * q, high, s);
                    push(p.at_ms - 4.0 * q, low, s);
                    push(p.at_ms - 3.0 * q, high, s);
                    push(p.at_ms - 2.0 * q, low, s);
                    push(p.at_ms - q, high, s);
                }
                Flourish::Slam => {
                    push(top_at, high, s);
                    push(p.at_ms - (gap / 4.0).min(120.0), high, s);
                }
                _ => push(top_at, high, s),
            }
            push(p.at_ms, low, s);
            let full_low = 0.5 - 0.5 * sign;
            let full_high = 0.5 + 0.5 * sign;
            match rule.flourish {
                Flourish::Hold => push(p.at_ms + 200.0, low, s),
                Flourish::Vibrate => {
                    let mut t = p.at_ms + 40.0;
                    let mut up = true;
                    while t < p.at_ms + 320.0 {
                        push(t, if up { low + 0.3 * d * sign } else { low }, s);
                        up = !up;
                        t += 40.0;
                    }
                }
                Flourish::Bounce => {
                    push(p.at_ms + 100.0, 0.5, s);
                    push(p.at_ms + 200.0, low, s);
                }
                Flourish::Whip => {
                    push(p.at_ms + 90.0, full_low, s);
                    push(p.at_ms + 220.0, low, s);
                }
                Flourish::Shake => {
                    push(p.at_ms + 120.0, full_high, s);
                    push(p.at_ms + 240.0, full_low, s);
                    push(p.at_ms + 360.0, full_high, s);
                    push(p.at_ms + 480.0, low, s);
                }
                Flourish::Grind => {
                    let mut t = p.at_ms + 80.0;
                    let mut up = true;
                    while t <= p.at_ms + 640.0 {
                        push(t, if up { low + 0.5 * d * sign } else { low }, s);
                        up = !up;
                        t += 80.0;
                    }
                }
                _ => {}
            }
            prev_at = Some(p.at_ms);
        }
        Script { actions: expand(&keys), ..Script::default() }
    }

    pub fn set_colour(&mut self, axis: Option<Axis>, bucket: usize, rule: ColourRule) {
        if bucket >= BUCKETS {
            return;
        }
        match axis {
            None => self.colours[bucket] = rule,
            Some(a) => self.axis_colours.entry(a).or_insert(self.colours)[bucket] = rule,
        }
    }

    /// The axis follows the shared table again.
    pub fn clear_axis_colours(&mut self, axis: Axis) {
        self.axis_colours.remove(&axis);
    }

    pub fn snapshot(&self) -> HeroSnapshot {
        HeroSnapshot {
            zone: self.zone,
            direction: self.direction,
            found: self.watcher.as_ref().and_then(|w| w.direction()),
            notes: self.watcher.as_ref().map(|w| w.notes().to_vec()).unwrap_or_default(),
            seen: self.seen,
            colours: self.colours,
            next_hit_ms: self.pending.iter().find(|p| p.at_ms > self.last_ms).map(|p| p.at_ms),
            hits: self.hits,
        }
    }
}

/// Keyframes to actions: a leg whose end has smoothing gets eased through a few points.
fn expand(keys: &[(f64, f64, f64)]) -> Vec<Action> {
    let mut actions: Vec<Action> = Vec::with_capacity(keys.len() * 2);
    for (k, &(at, pos, smooth)) in keys.iter().enumerate() {
        if k > 0 && smooth > 0.0 {
            let (from_at, from_pos, _) = keys[k - 1];
            if at - from_at >= SMOOTH_MIN_MS {
                for step in 1..SMOOTH_STEPS {
                    let u = step as f64 / SMOOTH_STEPS as f64;
                    actions.push(Action { at: from_at + (at - from_at) * u, pos: from_pos + (pos - from_pos) * ease(u, smooth) });
                }
            }
        }
        actions.push(Action { at, pos });
    }
    actions
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hero_with(hits: &[(f64, usize)], rule: ColourRule) -> HeroState {
        let mut h = HeroState::new();
        h.colours = [rule; BUCKETS];
        h.pending = hits.iter().enumerate().map(|(i, &(at_ms, bucket))| Pending { id: i as u64, at_ms, bucket, size: 1.0, settled: true }).collect();
        h
    }

    fn rule(flourish: Flourish) -> ColourRule {
        ColourRule { intensity: 1.0, flourish, smooth: 0.0, ignore: false }
    }

    #[test]
    fn ignored_colours_leave_no_stroke() {
        let mut h = hero_with(&[(1000.0, 0), (2000.0, 1), (3000.0, 0)], rule(Flourish::None));
        h.colours[1].ignore = true;
        let script = h.script(Axis::L0, 1.0, false, false);
        assert!(script.actions.iter().all(|a| (a.at - 2000.0).abs() > 1.0), "the ignored hit still made an action");
        // Two hits stroke: top, low, top, low.
        assert_eq!(script.actions.len(), 4);
    }

    #[test]
    fn rise_ends_high() {
        let h = hero_with(&[(1000.0, 0)], rule(Flourish::Rise));
        let script = h.script(Axis::L0, 1.0, false, false);
        let hit = script.actions.iter().find(|a| a.at == 1000.0).unwrap();
        assert!(hit.pos > 0.9);
    }

    #[test]
    fn smoothing_eases_the_drop_and_keeps_the_ends() {
        let sharp = hero_with(&[(1000.0, 0)], rule(Flourish::None)).script(Axis::L0, 1.0, false, false);
        let mut r = rule(Flourish::None);
        r.smooth = 1.0;
        let smooth = hero_with(&[(1000.0, 0)], r).script(Axis::L0, 1.0, false, false);
        // Top then low; only the drop has a leg before it to ease.
        assert_eq!(sharp.actions.len(), 2);
        assert_eq!(smooth.actions.len(), 2 + SMOOTH_STEPS - 1);
        assert_eq!(smooth.actions.first().unwrap().pos, sharp.actions[0].pos);
        assert_eq!(smooth.actions.last().unwrap().pos, sharp.actions[1].pos);
        // The first eased point lags a straight leg: it has moved less than a step's share.
        let (top, low) = (sharp.actions[0].pos, sharp.actions[1].pos);
        let first = smooth.actions[1].pos;
        assert!((first - top).abs() < (low - top).abs() / SMOOTH_STEPS as f64);
    }

    #[test]
    fn an_axis_table_overrides_the_shared_one() {
        let mut h = hero_with(&[(1000.0, 0)], rule(Flourish::None));
        h.set_colour(Some(Axis::R0), 0, ColourRule { ignore: true, ..rule(Flourish::None) });
        assert_eq!(h.script(Axis::L0, 1.0, false, false).actions.len(), 2);
        assert!(h.script(Axis::R0, 1.0, false, false).actions.is_empty());
        h.clear_axis_colours(Axis::R0);
        assert_eq!(h.script(Axis::R0, 1.0, false, false).actions.len(), 2);
    }

    #[test]
    fn flourish_names_round_trip() {
        for f in Flourish::ALL {
            assert_eq!(Flourish::from_str(f.as_str()), Some(f));
        }
    }
}
