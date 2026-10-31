#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose(pub [[f32; 4]; 3]);

impl Pose {
    pub const IDENTITY: Pose = Pose([[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]);

    pub fn translation(x: f32, y: f32, z: f32) -> Pose {
        Pose([[1.0, 0.0, 0.0, x], [0.0, 1.0, 0.0, y], [0.0, 0.0, 1.0, z]])
    }

    pub fn yaw(radians: f32) -> Pose {
        let (s, c) = radians.sin_cos();
        Pose([[c, 0.0, s, 0.0], [0.0, 1.0, 0.0, 0.0], [-s, 0.0, c, 0.0]])
    }

    pub fn pitch(radians: f32) -> Pose {
        let (s, c) = radians.sin_cos();
        Pose([[1.0, 0.0, 0.0, 0.0], [0.0, c, -s, 0.0], [0.0, s, c, 0.0]])
    }

    pub fn then(&self, inner: &Pose) -> Pose {
        let (a, b) = (&self.0, &inner.0);
        let mut m = [[0.0; 4]; 3];
        for r in 0..3 {
            for c in 0..4 {
                m[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c] + if c == 3 { a[r][3] } else { 0.0 };
            }
        }
        Pose(m)
    }

    pub fn position(&self) -> [f32; 3] {
        [self.0[0][3], self.0[1][3], self.0[2][3]]
    }

    pub fn heading(&self) -> f32 {
        let m = &self.0;
        (m[0][2]).atan2(m[2][2])
    }
}

const RECLINE_FROM: f32 = 20f32.to_radians();
const RECLINE_MAX: f32 = 80f32.to_radians();

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Recentre {
    pub origin: [f32; 3],
    pub heading: f32,
    pub pitch: f32,
}

impl Recentre {
    pub fn from_head(head: &Pose) -> Recentre {
        let m = &head.0;
        let up = (-m[1][2]).clamp(-1.0, 1.0);
        let look = up.asin();
        let heading = if m[0][2].hypot(m[2][2]) > 0.1 {
            head.heading()
        } else {
            let s = up.signum();
            (s * m[0][1]).atan2(s * m[2][1])
        };
        let pitch = if look > RECLINE_FROM { look.min(RECLINE_MAX) } else { 0.0 };
        Recentre { origin: head.position(), heading, pitch }
    }

    pub fn keeping_recline(&self, head: &Pose) -> Recentre {
        Recentre { pitch: self.pitch, ..Recentre::from_head(head) }
    }

    pub fn turned(&self, degrees: f32) -> Recentre {
        Recentre { heading: self.heading + degrees.to_radians(), ..*self }
    }

    pub fn to_tracking(&self) -> Pose {
        let [x, y, z] = self.origin;
        Pose::translation(x, y, z).then(&Pose::yaw(self.heading)).then(&Pose::pitch(self.pitch))
    }

    pub fn to_content(&self) -> Pose {
        let [x, y, z] = self.origin;
        Pose::pitch(-self.pitch).then(&Pose::yaw(-self.heading)).then(&Pose::translation(-x, -y, -z))
    }
}

pub fn panel(recentre: &Recentre, distance: f32, drop: f32, pitch_deg: f32) -> Pose {
    recentre.to_tracking().then(&Pose::translation(0.0, -drop, -distance)).then(&Pose::pitch(-pitch_deg.to_radians()))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EyeView {
    pub rotation: [f32; 9],
    pub position: [f32; 3],
}

pub fn eye_view(recentre: &Recentre, head: &Pose, eye_to_head: &Pose) -> EyeView {
    let m = recentre.to_content().then(head).then(eye_to_head).0;
    let flip = |r: usize, c: usize| if (r == 2) != (c == 2) { -1.0 } else { 1.0 };
    let mut rotation = [0.0; 9];
    for c in 0..3 {
        for r in 0..3 {
            rotation[c * 3 + r] = m[r][c] * flip(r, c);
        }
    }
    EyeView { rotation, position: [m[0][3], m[1][3], -m[2][3]] }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::{FRAC_PI_2, FRAC_PI_6};

    fn close(a: &[f32], b: &[f32]) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-5)
    }

    fn look(v: &EyeView, d: [f32; 3]) -> [f32; 3] {
        let r = &v.rotation;
        [0, 1, 2].map(|i| r[i] * d[0] + r[3 + i] * d[1] + r[6 + i] * d[2])
    }

    #[test]
    fn heading_reads_back_yaw() {
        for a in [-3.0, -FRAC_PI_2, -0.3, 0.0, 0.7, FRAC_PI_2, 3.0] {
            assert!((Pose::yaw(a).heading() - a).abs() < 1e-5, "{a}");
            assert!((Pose::yaw(a).then(&Pose::pitch(0.6)).heading() - a).abs() < 1e-5, "{a} pitched");
        }
    }

    #[test]
    fn recentre_puts_the_head_at_the_content_origin_facing_forward() {
        let head = Pose::translation(1.0, 1.6, -2.0).then(&Pose::yaw(FRAC_PI_2));
        let r = Recentre::from_head(&head);
        let local = r.to_content().then(&head);
        assert!(close(&local.position(), &[0.0; 3]));
        assert!(local.heading().abs() < 1e-5);
        assert!(close(&r.to_tracking().then(&r.to_content()).0.concat(), &Pose::IDENTITY.0.concat()));
    }

    #[test]
    fn lying_back_tips_content_up_to_the_gaze_and_looking_down_never_does() {
        let deg = f32::to_radians;
        for (up, pitch) in [(45.0, 45.0), (15.0, 0.0), (21.0, 21.0), (-40.0, 0.0), (85.0, 80.0), (90.0, 80.0), (-90.0, 0.0)] {
            let head = Pose::translation(0.2, 0.9, 0.4).then(&Pose::yaw(2.5)).then(&Pose::pitch(deg(up)));
            let r = Recentre::from_head(&head);
            assert!((r.pitch - deg(pitch)).abs() < 1e-4, "looking {up}: pitch {}", r.pitch.to_degrees());
            assert!((r.heading - 2.5).abs() < 1e-4, "looking {up}: heading {}", r.heading);
            let local = r.to_content().then(&head);
            assert!(close(&local.position(), &[0.0; 3]));
            assert!(close(&r.to_tracking().then(&r.to_content()).0.concat(), &Pose::IDENTITY.0.concat()));
        }
        let reclined = Recentre::from_head(&Pose::yaw(2.5).then(&Pose::pitch(deg(60.0))));
        let upright = Recentre::from_head(&Pose::yaw(2.5));
        for (from, up, pitch) in [(reclined, 35.0, 60.0), (reclined, 0.0, 60.0), (upright, 0.0, 0.0), (upright, 40.0, 0.0)] {
            let head = Pose::translation(0.3, 1.1, 0.0).then(&Pose::yaw(1.0)).then(&Pose::pitch(deg(up)));
            let r = from.keeping_recline(&head);
            assert!((r.pitch - deg(pitch)).abs() < 1e-4, "looking {up}: pitch {}", r.pitch.to_degrees());
            assert!((r.heading - 1.0).abs() < 1e-4);
            assert!(close(&r.origin, &[0.3, 1.1, 0.0]));
        }
        let head = Pose::yaw(FRAC_PI_2).then(&Pose::pitch(deg(45.0)));
        let r = Recentre::from_head(&head);
        let v = eye_view(&r, &head, &Pose::IDENTITY);
        assert!(close(&look(&v, [0.0, 0.0, 1.0]), &[0.0, 0.0, 1.0]));
        let deck = panel(&r, 0.55, 0.42, 38.0);
        let flat = panel(&Recentre { pitch: 0.0, ..r }, 0.55, 0.42, 38.0);
        assert!(deck.position()[1] > flat.position()[1] + 0.3, "raised toward the gaze");
    }

    #[test]
    fn panels_sit_ahead_and_below_tipped_toward_the_eyes() {
        let p = panel(&Recentre::default(), 0.55, 0.42, 30.0).0;
        assert!(close(&[p[0][3], p[1][3], p[2][3]], &[0.0, -0.42, -0.55]));
        assert!(close(&[p[0][2], p[1][2], p[2][2]], &[0.0, 0.5, 0.866_025_4]));
        let r = Recentre { origin: [0.0, 1.5, 0.0], heading: FRAC_PI_2, pitch: 0.0 };
        let p = panel(&r, 2.0, 0.0, 0.0);
        assert!(close(&p.position(), &[-2.0, 1.5, 0.0]));
    }

    #[test]
    fn eye_views_turn_and_place_the_shader_ray() {
        let eye = Pose::translation(-0.032, 0.0, 0.0);
        let v = eye_view(&Recentre::default(), &Pose::IDENTITY, &eye);
        assert!(close(&v.position, &[-0.032, 0.0, 0.0]));
        assert!(close(&look(&v, [0.0, 0.0, 1.0]), &[0.0, 0.0, 1.0]));
        let v = eye_view(&Recentre::default(), &Pose::yaw(FRAC_PI_2), &eye);
        assert!(close(&look(&v, [0.0, 0.0, 1.0]), &[-1.0, 0.0, 0.0]));
        assert!(close(&v.position, &[0.0, 0.0, -0.032]));
        let head = Pose::yaw(FRAC_PI_2).then(&Pose::pitch(FRAC_PI_6));
        let v = eye_view(&Recentre::default(), &head, &Pose::IDENTITY);
        assert!(close(&look(&v, [0.0, 0.0, 1.0]), &[-0.866_025_4, 0.5, 0.0]));
        let head = Pose::yaw(FRAC_PI_2).then(&Pose::pitch(15f32.to_radians()));
        let v = eye_view(&Recentre::from_head(&head), &head, &Pose::IDENTITY);
        assert!(close(&look(&v, [0.0, 0.0, 1.0]), &[0.0, 0.258_819, 0.965_925_8]));
        assert!(close(&look(&v, [1.0, 0.0, 0.0]), &[1.0, 0.0, 0.0]));
    }

    #[test]
    fn a_turn_right_brings_contents_right_side_ahead() {
        let r = Recentre { origin: [0.0, 1.5, 0.0], heading: 0.4, pitch: 0.5 };
        let head = Pose::translation(0.0, 1.5, 0.0).then(&Pose::yaw(0.4));
        let v = eye_view(&r.turned(90.0), &head, &Pose::IDENTITY);
        let ahead = look(&v, [0.0, 0.0, 1.0]);
        assert!(ahead[0] > 0.8 && ahead[2].abs() < 1e-5, "{ahead:?}");
        assert!(close(&v.position, &eye_view(&r, &head, &Pose::IDENTITY).position));
        assert!((r.turned(90.0).turned(-90.0).heading - r.heading).abs() < 1e-6);
    }
}
