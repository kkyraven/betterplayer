use crate::maths::{Offset, Pose, Recentre, dot, sub};

const REACH: f32 = 1.0;
pub const LEVEL_DEG: f32 = 10.0;
const TILT_MAX: f32 = 90.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Drag {
    Start(usize),
    End,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Aim {
    across: Option<f32>,
    up: f32,
    twist: Option<f32>,
}

impl Aim {
    pub fn of(recentre: &Recentre, head: [f32; 3], hand: &Pose) -> Option<Aim> {
        let to_content = recentre.to_content();
        let m = &hand.0;
        let [x, y, z] = hand.position();
        let at = [x - m[0][2] * REACH, y - m[1][2] * REACH, z - m[2][2] * REACH];
        let d = to_content.rotate(sub(at, head));
        let length = dot(d, d).sqrt();
        if length < 1e-3 {
            return None;
        }
        let across = (d[0].hypot(d[2]) > 0.1 * length).then(|| (-d[0]).atan2(-d[2]));
        let right = to_content.rotate([m[0][0], m[1][0], m[2][0]]);
        let up = to_content.rotate([m[0][1], m[1][1], m[2][1]]);
        let twist = (right[1].hypot(up[1]) > 0.5).then(|| right[1].atan2(up[1]));
        Some(Aim { across, up: (d[1] / length).clamp(-1.0, 1.0).asin(), twist })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Grab {
    pub hand: usize,
    last: Aim,
    roll: f32,
}

impl Grab {
    pub fn start(hand: usize, aim: Aim, offset: &Offset) -> Grab {
        Grab { hand, last: aim, roll: offset.roll }
    }

    pub fn drag(&mut self, aim: Aim, offset: &mut Offset) -> bool {
        if let (Some(from), Some(to)) = (self.last.across, aim.across) {
            offset.turn = wrap(offset.turn + (to - from).to_degrees());
        }
        offset.tilt = (offset.tilt + (aim.up - self.last.up).to_degrees()).clamp(-TILT_MAX, TILT_MAX);
        if let (Some(from), Some(to)) = (self.last.twist, aim.twist) {
            self.roll = wrap(self.roll + wrap((to - from).to_degrees()));
        }
        self.last = aim;
        let was_level = offset.roll == 0.0;
        offset.roll = if self.roll.abs() < LEVEL_DEG { 0.0 } else { self.roll };
        was_level != (offset.roll == 0.0)
    }
}

fn wrap(degrees: f32) -> f32 {
    (degrees + 180.0).rem_euclid(360.0) - 180.0
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: [f32; 3] = [0.0, 1.5, 0.0];

    fn hand(across: f32, up: f32, twist: f32) -> Pose {
        Pose::translation(0.2, 1.2, 0.0).then(&Pose::yaw(across.to_radians())).then(&Pose::pitch(up.to_radians())).then(&Pose::roll(twist.to_radians()))
    }

    fn drag(moves: &[(f32, f32, f32)]) -> (Offset, Vec<bool>) {
        let r = Recentre::from_head(&Pose::translation(HEAD[0], HEAD[1], HEAD[2]));
        let aim = |&(a, u, t): &(f32, f32, f32)| Aim::of(&r, HEAD, &hand(a, u, t)).unwrap();
        let mut offset = Offset::default();
        let mut g = Grab::start(1, aim(&moves[0]), &offset);
        let detents = moves[1..].iter().map(|m| g.drag(aim(m), &mut offset)).collect();
        (offset, detents)
    }

    #[test]
    fn the_video_follows_the_hand_round_the_head() {
        let (o, _) = drag(&[(0.0, 0.0, 0.0), (30.0, 20.0, 0.0)]);
        assert!(o.turn > 25.0 && o.turn < 35.0, "{o:?}");
        assert!(o.tilt > 15.0 && o.tilt < 25.0, "{o:?}");
        assert_eq!(o.roll, 0.0);
        let (o, _) = drag(&[(0.0, 0.0, 0.0), (30.0, 20.0, 0.0), (0.0, 0.0, 0.0)]);
        assert!(o.turn.abs() < 1e-3 && o.tilt.abs() < 1e-3, "{o:?}");
    }

    #[test]
    fn a_small_twist_stays_level_and_a_big_one_rolls() {
        let (o, detents) = drag(&[(0.0, 0.0, 0.0), (0.0, 0.0, 8.0), (0.0, 0.0, 25.0), (0.0, 0.0, 4.0)]);
        assert_eq!(detents, [false, true, true]);
        assert_eq!(o.roll, 0.0);
        let (o, _) = drag(&[(0.0, 0.0, 0.0), (0.0, 0.0, -25.0)]);
        assert!((o.roll + 25.0).abs() < 1e-3, "{o:?}");
    }

    #[test]
    fn tilt_stops_at_straight_up() {
        let (o, _) = drag(&[(0.0, -60.0, 0.0), (0.0, 0.0, 0.0), (0.0, 60.0, 0.0), (0.0, 85.0, 0.0)]);
        assert_eq!(o.tilt, TILT_MAX);
    }
}
