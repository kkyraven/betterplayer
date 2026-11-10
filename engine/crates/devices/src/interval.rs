pub const AUTO_MS: f64 = 80.0;
pub const FIXED_MIN_MS: u32 = 20;
pub const FIXED_MAX_MS: u32 = 1000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Interval {
    #[default]
    Auto,
    Points,
    Fixed(u32),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub at_ms: f64,
    pub value: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Pacer {
    since_ms: f64,
    held: Option<f64>,
    point_ms: Option<f64>,
}

impl Default for Pacer {
    fn default() -> Pacer {
        Pacer { since_ms: f64::INFINITY, held: None, point_ms: None }
    }
}

impl Pacer {
    pub fn step(&mut self, interval: Interval, level: f64, point: Option<Point>, sent: Option<f64>, dt_ms: f64) -> Option<f64> {
        let unit = |v: f64| (v * 1000.0).round();
        let changed = |v: f64| sent.is_none_or(|s| unit(s) != unit(v));
        self.since_ms += dt_ms;
        if let Interval::Fixed(ms) = interval {
            self.held = None;
            self.point_ms = None;
            if self.since_ms < ms as f64 {
                return None;
            }
            self.since_ms = 0.0;
            return changed(level).then_some(level);
        }
        let level = match point.filter(|_| interval == Interval::Points) {
            Some(p) => {
                if self.point_ms.replace(p.at_ms) != Some(p.at_ms) {
                    self.held = None;
                    self.since_ms = 0.0;
                    return changed(p.value).then_some(p.value);
                }
                p.value
            }
            None => {
                self.point_ms = None;
                level
            }
        };
        let from_sent = |v: f64| sent.map_or(f64::INFINITY, |s| (v - s).abs());
        if self.held.is_none_or(|h| from_sent(level) >= from_sent(h)) {
            self.held = Some(level);
        }
        if self.since_ms < AUTO_MS {
            return None;
        }
        let v = self.held.take().filter(|v| changed(*v))?;
        self.since_ms = 0.0;
        Some(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(interval: Interval, levels: &[f64], points: &[Option<Point>]) -> Vec<(u32, f64)> {
        let mut pacer = Pacer::default();
        let mut sent = None;
        let mut out = Vec::new();
        for (i, level) in levels.iter().enumerate() {
            if let Some(v) = pacer.step(interval, *level, points.get(i).copied().flatten(), sent, 10.0) {
                sent = Some(v);
                out.push((i as u32 * 10, v));
            }
        }
        out
    }

    #[test]
    fn auto_sends_a_change_at_once_then_the_peak_of_each_gap() {
        let spike = [0.0, 0.33, 0.67, 1.0, 0.67, 0.33, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        assert_eq!(run(Interval::Auto, &spike, &[]), vec![(0, 0.0), (80, 1.0), (160, 0.0)]);
        let step = [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.9, 0.9];
        assert_eq!(run(Interval::Auto, &step, &[]), vec![(0, 0.4), (100, 0.9)]);
    }

    #[test]
    fn points_sends_each_point_once_at_its_own_value() {
        let p = |at_ms: f64, value: f64| Some(Point { at_ms, value });
        let levels = [0.1, 0.2, 0.9, 0.5, 0.2, 0.2];
        let points = [p(0.0, 0.0), p(0.0, 0.0), p(15.0, 1.0), p(15.0, 1.0), p(38.0, 0.0), p(38.0, 0.0)];
        assert_eq!(run(Interval::Points, &levels, &points), vec![(0, 0.0), (20, 1.0), (40, 0.0)]);
        let mut pacer = Pacer::default();
        assert_eq!(pacer.step(Interval::Points, 0.3, p(15.0, 1.0), None, 10.0), Some(1.0));
        assert_eq!(pacer.step(Interval::Points, 0.3, None, Some(1.0), 10.0), None);
        for _ in 0..6 {
            assert_eq!(pacer.step(Interval::Points, 0.3, None, Some(1.0), 10.0), None);
        }
        assert_eq!(pacer.step(Interval::Points, 0.3, None, Some(1.0), 10.0), Some(0.3));
        assert_eq!(pacer.step(Interval::Points, 0.3, p(15.0, 1.0), Some(0.3), 10.0), Some(1.0));
        for _ in 0..7 {
            assert_eq!(pacer.step(Interval::Points, 0.3, p(15.0, 0.6), Some(1.0), 10.0), None);
        }
        assert_eq!(pacer.step(Interval::Points, 0.3, p(15.0, 0.6), Some(1.0), 10.0), Some(0.6));
    }

    #[test]
    fn fixed_sends_the_level_as_it_is_every_interval() {
        let levels = [0.0, 0.33, 0.67, 1.0, 0.67, 0.33, 0.0, 0.0, 0.0];
        assert_eq!(run(Interval::Fixed(30), &levels, &[]), vec![(0, 0.0), (30, 1.0), (60, 0.0)]);
        assert_eq!(run(Interval::Fixed(40), &levels, &[]), vec![(0, 0.0), (40, 0.67), (80, 0.0)]);
    }
}
