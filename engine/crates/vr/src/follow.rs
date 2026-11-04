use std::f32::consts::{PI, TAU};
use std::time::{Duration, Instant};

use crate::{Pose, Recentre};

const START: f32 = 40f32.to_radians();
const DWELL: Duration = Duration::from_millis(500);
const WALK: f32 = 0.5;
const SNAP: f32 = 30f32.to_radians();
const OMEGA: f32 = 6.0;
const SETTLE: f32 = 2f32.to_radians();
const SETTLE_M: f32 = 0.03;
const LEVEL: f32 = 0.5;

#[derive(Clone, Copy, Debug)]
pub struct Follow {
    frame: Recentre,
    anchor: Recentre,
    yaw: f32,
    turn: f32,
    drift: [f32; 3],
    gliding: bool,
    away_since: Option<Instant>,
    aim: f32,
    aside: f32,
}

impl Follow {
    pub fn new(anchor: Recentre) -> Follow {
        Follow { frame: anchor, anchor, yaw: 0.0, turn: 0.0, drift: [0.0; 3], gliding: false, away_since: None, aim: 0.0, aside: 0.0 }
    }

    pub fn set_aside(&mut self, radians: f32) {
        self.aside = radians;
    }

    pub fn anchor(&self) -> &Recentre {
        &self.anchor
    }

    pub fn left_behind(&self, head: &Pose) -> bool {
        self.away(head, SNAP)
    }

    pub fn snap(&mut self, head: &Pose) {
        if let Some(h) = self.heading_of(head) {
            self.yaw = h;
        }
        self.frame.origin = head.position();
        self.rest();
    }

    pub fn step(&mut self, head: &Pose, now: Instant, dt: f32, hold: bool) -> bool {
        if !self.gliding {
            if hold || !self.away(head, START) {
                self.away_since = None;
                return false;
            }
            let since = *self.away_since.get_or_insert(now);
            if now.duration_since(since) < DWELL {
                return false;
            }
            self.gliding = true;
            self.away_since = None;
            self.aim = self.yaw;
        }
        if let Some(h) = self.heading_of(head) {
            self.aim = h;
        }
        let off = wrap(self.aim - self.yaw);
        let (h, turn) = damp(self.yaw, self.turn, self.yaw + off, OMEGA, dt);
        (self.yaw, self.turn) = (wrap(h), turn);
        let target = head.position();
        for ((x, v), to) in self.frame.origin.iter_mut().zip(&mut self.drift).zip(target) {
            (*x, *v) = damp(*x, *v, to, OMEGA, dt);
        }
        if wrap(self.aim - self.yaw).abs() < SETTLE && distance(self.frame.origin, target) < SETTLE_M {
            self.rest();
        } else {
            self.anchor = self.frame.turned(self.yaw);
        }
        true
    }

    fn rest(&mut self) {
        let (frame, yaw, aside) = (self.frame, self.yaw, self.aside);
        *self = Follow { anchor: frame.turned(yaw), yaw, aim: yaw, aside, ..Follow::new(frame) };
    }

    fn away(&self, head: &Pose, angle: f32) -> bool {
        let off = |h: f32, from: f32| wrap(h - from).abs() > angle;
        let turned = self.heading_of(head).is_some_and(|h| off(h, self.yaw) && off(h, self.yaw + self.aside));
        turned || distance(head.position(), self.frame.origin) > WALK
    }

    fn heading_of(&self, head: &Pose) -> Option<f32> {
        let seen = Recentre { origin: head.position(), ..self.frame }.to_content().then(head);
        let m = &seen.0;
        (m[0][2].hypot(m[2][2]) >= LEVEL).then(|| seen.heading())
    }
}

fn wrap(a: f32) -> f32 {
    let a = (a + PI).rem_euclid(TAU) - PI;
    if a == -PI { PI } else { a }
}

fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

fn damp(x: f32, v: f32, target: f32, omega: f32, dt: f32) -> (f32, f32) {
    let e = (-omega * dt).exp();
    let x0 = x - target;
    let t = (v + omega * x0) * dt;
    (target + (x0 + t) * e, (v - omega * t) * e)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deg(d: f32) -> f32 {
        d.to_radians()
    }

    fn head(yaw: f32, up: f32) -> Pose {
        Pose::translation(0.0, 1.2, 0.0).then(&Pose::yaw(deg(yaw))).then(&Pose::pitch(deg(up)))
    }

    fn start() -> Follow {
        Follow::new(Recentre::from_head(&head(0.0, 0.0)))
    }

    fn run(f: &mut Follow, h: &Pose, t: Instant, ms: u64, dt_ms: u64, hold: bool) -> Option<u64> {
        let mut first = None;
        for i in 1..=ms / dt_ms {
            let now = t + Duration::from_millis(i * dt_ms);
            if f.step(h, now, dt_ms as f32 / 1000.0, hold) && first.is_none() {
                first = Some(i * dt_ms);
            }
        }
        first
    }

    #[test]
    fn a_small_turn_or_a_glance_never_moves_it() {
        let t = Instant::now();
        let mut f = start();
        assert_eq!(run(&mut f, &head(30.0, 0.0), t, 3000, 16, false), None);
        let t = t + Duration::from_secs(4);
        assert_eq!(run(&mut f, &head(-60.0, 0.0), t, 300, 16, false), None);
        assert_eq!(run(&mut f, &head(0.0, 0.0), t + Duration::from_millis(300), 1000, 16, false), None);
        assert_eq!(f.anchor().heading, 0.0);
    }

    #[test]
    fn a_big_turn_waits_then_glides_in_front_the_same_at_any_poll_rate() {
        let t = Instant::now();
        let mut ends = Vec::new();
        for dt in [11, 16, 31] {
            let mut f = start();
            let first = run(&mut f, &head(50.0, 0.0), t, 500 + 1000, dt, false).unwrap();
            assert!((500..500 + 2 * dt).contains(&first), "waits for the dwell: {first} at {dt} ms");
            assert!((f.anchor().heading - deg(50.0)).abs() < deg(2.0), "{} at {dt} ms", f.anchor().heading.to_degrees());
            ends.push(f.anchor().heading);
        }
        assert!(ends.iter().all(|h| (h - ends[0]).abs() < deg(1.0)), "{ends:?}");
        let mut f = start();
        run(&mut f, &head(50.0, 0.0), t, 500 + 400, 16, false);
        let h = f.anchor().heading.to_degrees();
        assert!(h > 15.0 && h < 48.0, "{h}");
    }

    #[test]
    fn it_turns_the_short_way_round() {
        let t = Instant::now();
        let mut f = Follow::new(Recentre::from_head(&head(170.0, 0.0)));
        assert_eq!(run(&mut f, &head(-140.0, 0.0), t, 600, 16, false), Some(528));
        assert!(f.anchor().heading > deg(170.0), "{}", f.anchor().heading.to_degrees());
        run(&mut f, &head(-140.0, 0.0), t + Duration::from_millis(600), 2000, 16, false);
        assert!(wrap(f.anchor().heading - deg(-140.0)).abs() < deg(2.0));
    }

    #[test]
    fn looking_far_up_or_down_ignores_yaw() {
        let t = Instant::now();
        let mut f = start();
        for (i, yaw) in [0.0, 120.0, -90.0, 170.0, 60.0].into_iter().cycle().take(200).enumerate() {
            let now = t + Duration::from_millis(16 * i as u64);
            assert!(!f.step(&head(yaw, -75.0), now, 0.016, false));
        }
    }

    #[test]
    fn walking_off_moves_it_after_the_dwell() {
        let t = Instant::now();
        let mut f = start();
        let walked = Pose::translation(0.7, 1.2, 0.0);
        assert!(f.left_behind(&walked));
        assert!(run(&mut f, &walked, t, 1500, 16, false).is_some());
        assert!(distance(f.anchor().origin, walked.position()) < SETTLE_M);
    }

    #[test]
    fn the_laser_on_it_keeps_it_from_starting() {
        let t = Instant::now();
        let mut f = start();
        let turned = head(70.0, 0.0);
        assert_eq!(run(&mut f, &turned, t, 2000, 16, true), None);
        let first = run(&mut f, &turned, t + Duration::from_secs(2), 1000, 16, false).unwrap();
        assert!(first >= 500, "{first}");
    }

    fn off(r: &Recentre, head: &Pose) -> f32 {
        r.to_content().then(head).heading().to_degrees().abs()
    }

    #[test]
    fn shown_again_far_off_it_snaps_in_front_keeping_its_recline() {
        let r = Recentre { pitch: deg(40.0), ..Recentre::from_head(&head(0.0, 0.0)) };
        let turned = |yaw: f32| r.to_tracking().then(&Pose::yaw(deg(yaw)));
        let mut f = Follow::new(r);
        assert!(!f.left_behind(&turned(25.0)));
        let behind = turned(160.0);
        assert!(f.left_behind(&behind));
        f.snap(&behind);
        assert!(off(f.anchor(), &behind) < 1e-3);
        assert_eq!(f.anchor(), &r.turned(f.yaw), "turned about the reclined up");
        assert!(!f.step(&behind, Instant::now(), 0.016, false), "nothing left to glide");
    }

    #[test]
    fn on_a_side_it_follows_a_turn_about_the_heads_own_up_not_its_right() {
        let t = Instant::now();
        let r = Recentre { roll: deg(80.0), ..Recentre::from_head(&head(0.0, 0.0)) };
        let own = |turn: Pose| r.to_tracking().then(&turn);
        let mut f = Follow::new(r);
        assert_eq!(run(&mut f, &own(Pose::pitch(deg(50.0))), t, 2000, 16, false), None);
        let left = own(Pose::yaw(deg(50.0)));
        assert!(run(&mut f, &left, t + Duration::from_secs(2), 2000, 16, false).is_some());
        assert!(off(f.anchor(), &left) < 2.0, "{}", off(f.anchor(), &left));
    }

    #[test]
    fn a_moved_panel_stays_put_while_looked_at_and_keeps_its_offset_when_it_follows() {
        let t = Instant::now();
        let mut f = start();
        f.set_aside(deg(-60.0));
        assert_eq!(run(&mut f, &head(-60.0, 0.0), t, 2000, 16, false), None);
        assert_eq!(run(&mut f, &head(0.0, 0.0), t + Duration::from_secs(2), 2000, 16, false), None);
        run(&mut f, &head(120.0, 0.0), t + Duration::from_secs(4), 3000, 16, false);
        assert!((f.anchor().heading - deg(120.0)).abs() < deg(2.0), "{}", f.anchor().heading.to_degrees());
        assert_eq!(run(&mut f, &head(60.0, 0.0), t + Duration::from_secs(7), 2000, 16, false), None, "looking at it again");
    }
}
