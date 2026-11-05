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

    pub fn roll(radians: f32) -> Pose {
        let (s, c) = radians.sin_cos();
        Pose([[c, -s, 0.0, 0.0], [s, c, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]])
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

    pub fn rotate(&self, v: [f32; 3]) -> [f32; 3] {
        self.0.map(|r| r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
    }

    pub fn heading(&self) -> f32 {
        let m = &self.0;
        (m[0][2]).atan2(m[2][2])
    }
}

const RECLINE_FROM: f32 = 20f32.to_radians();
const RECLINE_MAX: f32 = 80f32.to_radians();
const ROLL_FROM: f32 = 45f32.to_radians();
const ROLL_MAX: f32 = 90f32.to_radians();

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Recentre {
    pub origin: [f32; 3],
    pub heading: f32,
    pub pitch: f32,
    pub roll: f32,
}

impl Recentre {
    pub fn from_head(head: &Pose) -> Recentre {
        let m = &head.0;
        let up = (-m[1][2]).clamp(-1.0, 1.0);
        let look = up.asin();
        let (heading, roll) = if m[0][2].hypot(m[2][2]) > 0.1 {
            (head.heading(), m[1][0].atan2(m[1][1]))
        } else {
            let s = up.signum();
            ((s * m[0][1]).atan2(s * m[2][1]), 0.0)
        };
        let pitch = if look.abs() > RECLINE_FROM { look.clamp(-RECLINE_MAX, RECLINE_MAX) } else { 0.0 };
        let roll = if roll.abs() > ROLL_FROM { roll.clamp(-ROLL_MAX, ROLL_MAX) } else { 0.0 };
        Recentre { origin: head.position(), heading, pitch, roll }
    }

    pub fn keeping_recline(&self, head: &Pose) -> Recentre {
        Recentre { pitch: self.pitch, roll: self.roll, ..Recentre::from_head(head) }
    }

    pub fn turned(&self, radians: f32) -> Recentre {
        let m = self.to_tracking().then(&Pose::yaw(radians)).0;
        let pitch = (-m[1][2]).clamp(-1.0, 1.0).asin();
        let (heading, roll) = if m[0][2].hypot(m[2][2]) > 1e-3 { (m[0][2].atan2(m[2][2]), m[1][0].atan2(m[1][1])) } else { ((-m[2][0]).atan2(m[0][0]), 0.0) };
        Recentre { origin: self.origin, heading, pitch, roll }
    }

    pub fn to_tracking(&self) -> Pose {
        let [x, y, z] = self.origin;
        Pose::translation(x, y, z).then(&Pose::yaw(self.heading)).then(&Pose::pitch(self.pitch)).then(&Pose::roll(self.roll))
    }

    pub fn to_content(&self) -> Pose {
        let [x, y, z] = self.origin;
        Pose::roll(-self.roll).then(&Pose::pitch(-self.pitch)).then(&Pose::yaw(-self.heading)).then(&Pose::translation(-x, -y, -z))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Offset {
    pub turn: f32,
    pub tilt: f32,
    pub roll: f32,
}

impl Offset {
    pub fn rotation(&self) -> Pose {
        Pose::yaw(self.turn.to_radians()).then(&Pose::pitch(self.tilt.to_radians())).then(&Pose::roll(self.roll.to_radians()))
    }

    pub fn inverse(&self) -> Pose {
        Pose::roll(-self.roll.to_radians()).then(&Pose::pitch(-self.tilt.to_radians())).then(&Pose::yaw(-self.turn.to_radians()))
    }
}

pub fn panel(recentre: &Recentre, distance: f32, drop: f32, pitch_deg: f32) -> Pose {
    recentre.to_tracking().then(&Pose::translation(0.0, -drop, -distance)).then(&Pose::pitch(-pitch_deg.to_radians()))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ray {
    pub origin: [f32; 3],
    pub direction: [f32; 3],
}

impl Ray {
    pub fn from_pose(pose: &Pose) -> Ray {
        let m = &pose.0;
        Ray { origin: pose.position(), direction: normalised([-m[0][2], -m[1][2], -m[2][2]]) }
    }

    pub fn at(&self, distance: f32) -> [f32; 3] {
        let (o, d) = (self.origin, self.direction);
        [o[0] + d[0] * distance, o[1] + d[1] * distance, o[2] + d[2] * distance]
    }

    pub fn to_video(&self, recentre: &Recentre, offset: &Offset) -> Ray {
        let m = offset.inverse().then(&recentre.to_content());
        let [ox, oy, oz] = self.origin;
        let [x, y, z] = m.then(&Pose::translation(ox, oy, oz)).position();
        let [dx, dy, dz] = m.rotate(self.direction);
        Ray { origin: [x, y, -z], direction: [dx, dy, -dz] }
    }

    pub fn on_screen(&self, radius: f32, width: f32, height: f32) -> Option<[f32; 2]> {
        let (p, d) = (self.origin, self.direction);
        let a = (d[0] * d[0] + d[2] * d[2]).max(1e-6);
        let b = p[0] * d[0] + p[2] * d[2];
        let c = p[0] * p[0] + p[2] * p[2] - radius * radius;
        let h = self.at((-b + (b * b - a * c).max(0.0).sqrt()) / a);
        on_picture([0.5 + h[0].atan2(h[2]) * radius / width, 0.5 - h[1] / height])
    }

    pub fn on_equirect(&self, hfov: f32) -> Option<[f32; 2]> {
        let d = self.direction;
        let lon = d[0].atan2(d[2]);
        let lat = d[1].clamp(-1.0, 1.0).asin();
        (hfov > std::f32::consts::TAU - 0.01 || lon.abs() <= hfov * 0.5).then(|| [0.5 + lon / hfov, 0.5 - lat / std::f32::consts::PI])
    }

    pub fn on_fisheye(&self, fov: f32) -> Option<[f32; 2]> {
        let d = self.direction;
        let theta = d[2].clamp(-1.0, 1.0).acos();
        let r = theta / fov;
        let phi = d[1].atan2(d[0]);
        (theta <= fov * 0.5).then(|| [0.5 + r * phi.cos(), 0.5 - r * phi.sin()])
    }
}

fn on_picture(t: [f32; 2]) -> Option<[f32; 2]> {
    t.iter().all(|c| (0.0..=1.0).contains(c)).then_some(t)
}

pub fn facing(centre: [f32; 3], head: &Pose) -> Pose {
    let to_eye = sub(head.position(), centre);
    let z = if dot(to_eye, to_eye) < 1e-8 { head.rotate([0.0, 0.0, 1.0]) } else { normalised(to_eye) };
    let square = |v: [f32; 3]| {
        let d = dot(v, z);
        sub(v, [z[0] * d, z[1] * d, z[2] * d])
    };
    let y = [head.rotate([0.0, 1.0, 0.0]), head.rotate([0.0, 0.0, 1.0])]
        .into_iter()
        .map(square)
        .find(|v| dot(*v, *v) > 0.01)
        .map_or([0.0, 1.0, 0.0], normalised);
    let x = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]];
    let [cx, cy, cz] = centre;
    Pose([[x[0], y[0], z[0], cx], [x[1], y[1], z[1], cy], [x[2], y[2], z[2], cz]])
}

pub fn hit(pose: &Pose, ray: &Ray, width: f32, height: f32) -> Option<(f32, f32)> {
    plane_hit(pose, ray, width, height).filter(|(u, v)| (0.0..=1.0).contains(u) && (0.0..=1.0).contains(v))
}

pub fn plane_hit(pose: &Pose, ray: &Ray, width: f32, height: f32) -> Option<(f32, f32)> {
    let m = &pose.0;
    let axis = |c: usize| [m[0][c], m[1][c], m[2][c]];
    let (x, y, z, centre) = (axis(0), axis(1), axis(2), pose.position());
    let facing = dot(ray.direction, z);
    if facing.abs() < 1e-6 {
        return None;
    }
    let along = dot(sub(centre, ray.origin), z) / facing;
    if along <= 0.0 {
        return None;
    }
    let local = sub(ray.at(along), centre);
    Some((dot(local, x) / width + 0.5, 0.5 - dot(local, y) / height))
}

pub fn gaze(head: &Pose, at: [f32; 3]) -> (f32, f32) {
    let m = &head.0;
    let forward = [-m[0][2], -m[1][2], -m[2][2]];
    let to = sub(at, head.position());
    let distance = dot(to, to).sqrt();
    if distance < 1e-4 {
        return (0.0, 0.0);
    }
    let cos = (dot(to, forward) / distance).clamp(-1.0, 1.0);
    (distance, cos.acos().to_degrees())
}

pub(crate) fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(crate) fn normalised(v: [f32; 3]) -> [f32; 3] {
    let n = dot(v, v).sqrt();
    if n > 0.0 { [v[0] / n, v[1] / n, v[2] / n] } else { v }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EyeView {
    pub rotation: [f32; 9],
    pub position: [f32; 3],
}

pub fn eye_view(recentre: &Recentre, offset: &Offset, head: &Pose, eye_to_head: &Pose) -> EyeView {
    let m = offset.inverse().then(&recentre.to_content()).then(head).then(eye_to_head).0;
    let flip = |r: usize, c: usize| if (r == 2) != (c == 2) { -1.0 } else { 1.0 };
    let mut rotation = [0.0; 9];
    for c in 0..3 {
        for r in 0..3 {
            rotation[c * 3 + r] = m[r][c] * flip(r, c);
        }
    }
    EyeView { rotation, position: [m[0][3], m[1][3], -m[2][3]] }
}

impl EyeView {
    pub fn turned(self, degrees: f32) -> EyeView {
        if degrees == 0.0 {
            return self;
        }
        let (s, c) = degrees.to_radians().sin_cos();
        let turn = |v: [f32; 3]| [c * v[0] + s * v[2], v[1], c * v[2] - s * v[0]];
        let mut rotation = self.rotation;
        for col in rotation.chunks_exact_mut(3) {
            let v = turn([col[0], col[1], col[2]]);
            col.copy_from_slice(&v);
        }
        EyeView { rotation, position: turn(self.position) }
    }
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
    fn looking_far_up_or_down_tips_content_to_the_gaze() {
        let deg = f32::to_radians;
        for (up, pitch) in [(45.0, 45.0), (15.0, 0.0), (21.0, 21.0), (-15.0, 0.0), (-40.0, -40.0), (85.0, 80.0), (90.0, 80.0), (-90.0, -80.0)] {
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
        let v = eye_view(&r, &Offset::default(), &head, &Pose::IDENTITY);
        assert!(close(&look(&v, [0.0, 0.0, 1.0]), &[0.0, 0.0, 1.0]));
        let deck = panel(&r, 0.55, 0.42, 38.0);
        let flat = panel(&Recentre { pitch: 0.0, ..r }, 0.55, 0.42, 38.0);
        assert!(deck.position()[1] > flat.position()[1] + 0.3, "raised toward the gaze");
    }

    #[test]
    fn lying_on_a_side_rolls_content_with_the_head_and_a_tilted_head_never_does() {
        let deg = f32::to_radians;
        let head = |up: f32, roll: f32| Pose::translation(0.2, 0.9, 0.4).then(&Pose::yaw(2.5)).then(&Pose::pitch(deg(up))).then(&Pose::roll(deg(roll)));
        for (up, roll, taken) in [(0.0, 70.0, 70.0), (0.0, -85.0, -85.0), (0.0, 30.0, 0.0), (0.0, -44.0, 0.0), (0.0, 120.0, 90.0), (45.0, 60.0, 60.0), (-30.0, 80.0, 80.0)] {
            let r = Recentre::from_head(&head(up, roll));
            assert!((r.roll - deg(taken)).abs() < 1e-4, "rolled {roll} looking {up}: roll {}", r.roll.to_degrees());
            assert!((r.heading - 2.5).abs() < 1e-4, "rolled {roll} looking {up}: heading {}", r.heading);
            assert!(close(&r.to_tracking().then(&r.to_content()).0.concat(), &Pose::IDENTITY.0.concat()));
        }
        let h = head(0.0, 80.0);
        let v = eye_view(&Recentre::from_head(&h), &Offset::default(), &h, &Pose::IDENTITY);
        assert!(close(&look(&v, [0.0, 0.0, 1.0]), &[0.0, 0.0, 1.0]));
        assert!(close(&look(&v, [1.0, 0.0, 0.0]), &[1.0, 0.0, 0.0]));
        assert_eq!(Recentre::from_head(&head(90.0, 60.0)).roll, 0.0);
        let r = Recentre::from_head(&h).keeping_recline(&Pose::translation(0.3, 1.1, 0.0).then(&Pose::yaw(1.0)));
        assert!((r.roll - deg(80.0)).abs() < 1e-4 && (r.heading - 1.0).abs() < 1e-4);
        let r = Recentre::from_head(&h);
        let dragged = eye_view(&r, &Offset { roll: 10.0, ..Offset::default() }, &h, &Pose::IDENTITY);
        let level = eye_view(&Recentre { roll: deg(90.0), ..r }, &Offset::default(), &h, &Pose::IDENTITY);
        assert!(close(&dragged.rotation, &level.rotation));
    }

    #[test]
    fn turned_turns_about_the_recentres_own_up() {
        let deg = f32::to_radians;
        for (pitch, roll, turn) in [(0.0, 0.0, 50.0), (40.0, 0.0, 160.0), (0.0, 80.0, -70.0), (60.0, -90.0, 120.0), (0.0, 90.0, -90.0), (80.0, 90.0, -90.0)] {
            let r = Recentre { origin: [0.1, 1.2, -0.3], heading: 2.5, pitch: deg(pitch), roll: deg(roll) };
            let want = r.to_tracking().then(&Pose::yaw(deg(turn)));
            let got = r.turned(deg(turn)).to_tracking();
            assert!(got.0.iter().zip(want.0).all(|(a, b)| a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-3)), "{pitch} {roll} {turn}: {got:?}");
        }
        let r = Recentre { heading: 0.3, ..Recentre::default() }.turned(0.5);
        assert!((r.heading - 0.8).abs() < 1e-6 && r.pitch == 0.0 && r.roll == 0.0, "{r:?}");
    }

    #[test]
    fn a_ring_faces_the_eye_and_the_ray_hits_it_where_it_points() {
        let eye = [0.0, 1.6, 0.0];
        let ray = Ray::from_pose(&Pose::translation(0.1, 1.3, -0.3).then(&Pose::yaw(0.2)));
        let centre = ray.at(0.8);
        let ring = facing(centre, &Pose::translation(eye[0], eye[1], eye[2]));
        let z = [ring.0[0][2], ring.0[1][2], ring.0[2][2]];
        assert!(close(&z, &normalised(sub(eye, centre))), "faces the eye, tipped up to it: {z:?}");
        assert!(ring.0[1][0].abs() < 1e-6 && ring.0[1][1] > 0.9, "level, its top up");
        let (u, v) = hit(&ring, &ray, 0.5, 0.5).unwrap();
        assert!((u - 0.5).abs() < 1e-4 && (v - 0.5).abs() < 1e-4, "the centre: {u} {v}");
        let up_right = Ray { origin: ray.origin, direction: normalised(sub(add(centre, [ring.0[0][0] * 0.1, 0.1, ring.0[2][0] * 0.1]), ray.origin)) };
        let (u, v) = hit(&ring, &up_right, 0.5, 0.5).unwrap();
        assert!(u > 0.6 && v < 0.4, "{u} {v}");
        let back = Ray { origin: ray.origin, direction: [-ray.direction[0], -ray.direction[1], -ray.direction[2]] };
        assert_eq!(hit(&ring, &back, 0.5, 0.5), None);
        let wide = Ray { origin: ray.origin, direction: normalised(sub(add(centre, [ring.0[0][0], 0.0, ring.0[2][0]]), ray.origin)) };
        assert_eq!(hit(&ring, &wide, 0.5, 0.5), None);
        let (u, v) = plane_hit(&ring, &wide, 0.5, 0.5).unwrap();
        assert!((u - 2.5).abs() < 1e-3 && (v - 0.5).abs() < 1e-3, "{u} {v}");
        assert_eq!(plane_hit(&ring, &back, 0.5, 0.5), None);
    }

    #[test]
    fn a_ring_straight_overhead_faces_down_with_its_top_at_the_top_of_the_view() {
        let deg = f32::to_radians;
        let axis = |p: &Pose, c: usize| [p.0[0][c], p.0[1][c], p.0[2][c]];
        let head = Pose::translation(0.0, 1.6, 0.0).then(&Pose::yaw(deg(90.0))).then(&Pose::pitch(deg(90.0)));
        let ring = facing([0.0, 2.4, 0.0], &head);
        assert!(close(&axis(&ring, 2), &[0.0, -1.0, 0.0]), "faces down: {ring:?}");
        assert!(close(&axis(&ring, 1), &head.rotate([0.0, 1.0, 0.0])), "top at the top of the view: {ring:?}");
        for centre in [[0.2, 2.4, 0.0], [0.0, 2.4, 0.2], [0.0, 2.4, -0.2]] {
            let tilted = head.then(&Pose::roll(deg(30.0)));
            let ring = facing(centre, &tilted);
            assert!(dot(axis(&ring, 1), tilted.rotate([0.0, 1.0, 0.0])) > 0.95, "{centre:?}: {ring:?}");
        }
        let side = Pose::translation(0.0, 0.5, 0.0).then(&Pose::roll(deg(-90.0)));
        let ring = facing([0.0, 0.3, -0.8], &side);
        assert!(axis(&ring, 1)[0] > 0.95, "{ring:?}");
    }

    #[test]
    fn gaze_is_distance_and_angle_off_where_the_head_looks() {
        let head = Pose::translation(0.0, 1.6, 0.0);
        let (d, a) = gaze(&head, [0.0, 1.6, -0.4]);
        assert!((d - 0.4).abs() < 1e-5 && a < 1e-3, "{d} {a}");
        let (d, a) = gaze(&head, [0.3, 1.6, -0.3]);
        assert!((d - 0.424_264).abs() < 1e-4 && (a - 45.0).abs() < 1e-3, "{d} {a}");
        assert!(gaze(&head, [0.0, 1.6, 0.5]).1 > 179.0, "behind");
    }

    fn add(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
        [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
    }

    #[test]
    fn panels_sit_ahead_and_below_tipped_toward_the_eyes() {
        let p = panel(&Recentre::default(), 0.55, 0.42, 30.0).0;
        assert!(close(&[p[0][3], p[1][3], p[2][3]], &[0.0, -0.42, -0.55]));
        assert!(close(&[p[0][2], p[1][2], p[2][2]], &[0.0, 0.5, 0.866_025_4]));
        let r = Recentre { origin: [0.0, 1.5, 0.0], heading: FRAC_PI_2, ..Recentre::default() };
        let p = panel(&r, 2.0, 0.0, 0.0);
        assert!(close(&p.position(), &[-2.0, 1.5, 0.0]));
    }

    #[test]
    fn eye_views_turn_and_place_the_shader_ray() {
        let eye = Pose::translation(-0.032, 0.0, 0.0);
        let v = eye_view(&Recentre::default(), &Offset::default(), &Pose::IDENTITY, &eye);
        assert!(close(&v.position, &[-0.032, 0.0, 0.0]));
        assert!(close(&look(&v, [0.0, 0.0, 1.0]), &[0.0, 0.0, 1.0]));
        let v = eye_view(&Recentre::default(), &Offset::default(), &Pose::yaw(FRAC_PI_2), &eye);
        assert!(close(&look(&v, [0.0, 0.0, 1.0]), &[-1.0, 0.0, 0.0]));
        assert!(close(&v.position, &[0.0, 0.0, -0.032]));
        let head = Pose::yaw(FRAC_PI_2).then(&Pose::pitch(FRAC_PI_6));
        let v = eye_view(&Recentre::default(), &Offset::default(), &head, &Pose::IDENTITY);
        assert!(close(&look(&v, [0.0, 0.0, 1.0]), &[-0.866_025_4, 0.5, 0.0]));
        let head = Pose::yaw(FRAC_PI_2).then(&Pose::pitch(15f32.to_radians()));
        let v = eye_view(&Recentre::from_head(&head), &Offset::default(), &head, &Pose::IDENTITY);
        assert!(close(&look(&v, [0.0, 0.0, 1.0]), &[0.0, 0.258_819, 0.965_925_8]));
        assert!(close(&look(&v, [1.0, 0.0, 0.0]), &[1.0, 0.0, 0.0]));
    }

    #[test]
    fn a_turned_eye_sees_its_picture_moved_left_and_keeps_up() {
        let eye = Pose::translation(-0.032, 0.0, 0.0);
        let v = eye_view(&Recentre::default(), &Offset::default(), &Pose::IDENTITY, &eye);
        assert_eq!(v.turned(0.0), v);
        let t = v.turned(90.0);
        assert!(close(&look(&t, [0.0, 0.0, 1.0]), &[1.0, 0.0, 0.0]));
        assert!(close(&look(&t, [0.0, 1.0, 0.0]), &[0.0, 1.0, 0.0]));
        assert!(close(&t.position, &[0.0, 0.0, 0.032]));
    }

    #[test]
    fn an_offset_moves_the_video_round_the_head() {
        let r = Recentre { origin: [0.0, 1.5, 0.0], heading: 0.4, pitch: 0.5, roll: 0.0 };
        let head = Pose::translation(0.0, 1.5, 0.0).then(&Pose::yaw(0.4)).then(&Pose::pitch(0.5));
        let ahead = |o: Offset| look(&eye_view(&r, &o, &head, &Pose::IDENTITY), [0.0, 0.0, 1.0]);
        let turned = ahead(Offset { turn: 90.0, ..Offset::default() });
        assert!(close(&turned, &[1.0, 0.0, 0.0]), "{turned:?}");
        let tilted = ahead(Offset { tilt: 30.0, ..Offset::default() });
        assert!(close(&tilted, &[0.0, -0.5, 0.866_025_4]), "{tilted:?}");
        let rolled = look(&eye_view(&r, &Offset { roll: 90.0, ..Offset::default() }, &head, &Pose::IDENTITY), [1.0, 0.0, 0.0]);
        assert!(close(&rolled, &[0.0, -1.0, 0.0]), "{rolled:?}");
        let o = Offset { turn: 20.0, tilt: -15.0, roll: 40.0 };
        let round = o.rotation().then(&o.inverse());
        assert!(round.0.iter().zip(Pose::IDENTITY.0).all(|(a, b)| close(a, &b)));
        assert!(close(&eye_view(&r, &o, &head, &Pose::IDENTITY).position, &eye_view(&r, &Offset::default(), &head, &Pose::IDENTITY).position));
    }

    #[test]
    fn a_ray_in_the_video_frame_matches_the_eyes_view() {
        let r = Recentre { origin: [0.1, 1.5, -0.2], heading: 0.4, pitch: 0.5, roll: 0.9 };
        let o = Offset { turn: 25.0, tilt: -10.0, roll: 30.0 };
        let head = Pose::translation(0.3, 1.2, 0.1).then(&Pose::yaw(1.1)).then(&Pose::pitch(-0.3));
        let ray = Ray::from_pose(&head).to_video(&r, &o);
        let v = eye_view(&r, &o, &head, &Pose::IDENTITY);
        assert!(close(&ray.direction, &look(&v, [0.0, 0.0, 1.0])), "{ray:?}");
        assert!(close(&ray.origin, &v.position), "{ray:?}");
    }

    #[test]
    fn aiming_at_the_picture_finds_where_on_it() {
        let deg = f32::to_radians;
        let toward = |across: f32, up: f32| Ray { origin: [0.0; 3], direction: [deg(across).sin() * deg(up).cos(), deg(up).sin(), deg(across).cos() * deg(up).cos()] };
        let near = |a: Option<[f32; 2]>, b: [f32; 2]| a.is_some_and(|a| close(&a, &b));
        let pi = std::f32::consts::PI;
        assert!(near(toward(0.0, 0.0).on_equirect(pi), [0.5, 0.5]));
        assert!(near(toward(45.0, 0.0).on_equirect(pi), [0.75, 0.5]));
        assert!(near(toward(0.0, 45.0).on_equirect(pi), [0.5, 0.25]));
        assert_eq!(toward(120.0, 0.0).on_equirect(pi), None);
        assert!(near(toward(-90.0, 0.0).on_equirect(2.0 * pi), [0.25, 0.5]));
        assert!(near(toward(100.0, 0.0).on_equirect(220f32.to_radians()), [0.5 + 100.0 / 220.0, 0.5]));
        assert_eq!(toward(120.0, 0.0).on_equirect(220f32.to_radians()), None);
        assert!(near(toward(0.0, 0.0).on_fisheye(pi), [0.5, 0.5]));
        assert!(near(toward(0.0, 90.0).on_fisheye(pi), [0.5, 0.0]));
        assert!(near(toward(45.0, 0.0).on_fisheye(pi), [0.75, 0.5]));
        assert_eq!(toward(100.0, 0.0).on_fisheye(pi), None);
        let (w, h) = (3.0 * deg(50.0), 3.0 * deg(50.0) * 9.0 / 16.0);
        assert!(near(toward(0.0, 0.0).on_screen(3.0, w, h), [0.5, 0.5]));
        assert!(near(toward(12.5, 0.0).on_screen(3.0, w, h), [0.75, 0.5]));
        let up = Ray { origin: [0.0; 3], direction: normalised([0.0, h / 4.0, 3.0]) };
        assert!(near(up.on_screen(3.0, w, h), [0.5, 0.25]));
        assert_eq!(toward(30.0, 0.0).on_screen(3.0, w, h), None);
        assert_eq!(toward(0.0, 30.0).on_screen(3.0, w, h), None);
        let hand = Ray { origin: [0.3, -0.3, 0.0], direction: [0.0, 0.0, 1.0] };
        let [u, v] = hand.on_screen(3.0, w, h).unwrap();
        assert!((u - (0.5 + 0.3f32.atan2((9.0f32 - 0.09).sqrt()) * 3.0 / w)).abs() < 1e-4 && (v - (0.5 + 0.3 / h)).abs() < 1e-4, "{u} {v}");
    }
}
