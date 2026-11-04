use crate::maths::{Pose, Ray, Recentre, dot, sub};

pub const BAR_TEXELS: [u32; 2] = [240, 90];
const PILL: [f32; 2] = [0.84, 0.27];
const PILL_RGB: [f32; 3] = [238.0 / 255.0, 240.0 / 255.0, 244.0 / 255.0];
const PILL_ALPHA: f32 = 0.4;
const PILL_ALPHA_LIT: f32 = 0.66;
pub const CLOSE_TEXELS: u32 = BAR_TEXELS[1];
const DISC: f32 = 0.72;
const DISC_RGB: [f32; 3] = [10.0 / 255.0, 12.0 / 255.0, 16.0 / 255.0];
const DISC_ALPHA: f32 = 0.8;
const CROSS: [f32; 3] = [6.0, 18.0, 2.0];
const BAR_WIDTH: f32 = 0.12;
const BAR_GAP: f32 = 0.004;
const PITCH_MAX: f32 = 70.0;
const LEVEL: f32 = 0.1;
const REACH_SPARE: f32 = 0.1;
const PUSH_RATE: f32 = 0.5;
const PUSH_DEAD: f32 = 0.25;

pub type Place = (f32, f32, f32);

pub type Reach = [f32; 2];

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Moved {
    pub yaw: f32,
    pub pitch: f32,
    pub distance: Option<f32>,
}

impl Moved {
    pub fn within(self, place: Place, reach: Reach) -> Moved {
        Moved { yaw: wrap(self.yaw), pitch: clamp_pitch(place, self.pitch), distance: self.distance.map(|d| d.clamp(reach[0], reach[1])) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Push {
    Still,
    Moved,
    End,
}

pub fn pushed(place: Place, moved: &Moved) -> Place {
    let (distance, drop, pitch) = place;
    match moved.distance {
        Some(to) => (to, drop * to / distance, pitch),
        None => place,
    }
}

fn clamp_pitch(place: Place, pitch: f32) -> f32 {
    let rest = rest(place);
    pitch.clamp(-PITCH_MAX - rest, PITCH_MAX - rest)
}

fn rest((distance, drop, _): Place) -> f32 {
    (-drop).atan2(distance).to_degrees()
}

pub fn moved_panel(anchor: &Recentre, place: Place, moved: &Moved) -> Pose {
    let (distance, drop, pitch) = pushed(place, moved);
    let round = Pose::yaw(moved.yaw.to_radians()).then(&Pose::pitch(moved.pitch.to_radians()));
    anchor.to_tracking().then(&round).then(&Pose::translation(0.0, -drop, -distance)).then(&Pose::pitch(-pitch.to_radians()))
}

pub fn bar_metres(place: Place) -> f32 {
    BAR_WIDTH * radius(place)
}

pub fn bar_pose(panel: &Pose, place: Place, height: f32, above: bool) -> Pose {
    let bar = bar_metres(place) * BAR_TEXELS[1] as f32 / BAR_TEXELS[0] as f32;
    let lift = height / 2.0 + BAR_GAP * radius(place) + bar / 2.0;
    panel.then(&Pose::translation(0.0, if above { lift } else { -lift }, 0.0))
}

pub fn bar_texels(lit: bool) -> Vec<u8> {
    let [w, h] = BAR_TEXELS;
    let alpha = if lit { PILL_ALPHA_LIT } else { PILL_ALPHA };
    let r = PILL[1] * h as f32 / 2.0;
    let half = PILL[0] * w as f32 / 2.0 - r;
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let px = ((x as f32 + 0.5) - w as f32 / 2.0).abs();
            let py = ((y as f32 + 0.5) - h as f32 / 2.0).abs();
            let d = (px - half).max(0.0).hypot(py) - r;
            let a = alpha * (0.5 - d).clamp(0.0, 1.0);
            let byte = |v: f32| (v * 255.0).round() as u8;
            out.extend([byte(PILL_RGB[2] * a), byte(PILL_RGB[1] * a), byte(PILL_RGB[0] * a), byte(a)]);
        }
    }
    out
}

pub fn close_pose(bar: &Pose, place: Place) -> Pose {
    let side = bar_metres(place) * CLOSE_TEXELS as f32 / BAR_TEXELS[0] as f32;
    bar.then(&Pose::translation(bar_metres(place) / 2.0 + BAR_GAP * radius(place) + side / 2.0, 0.0, 0.0))
}

pub fn close_metres(place: Place) -> f32 {
    bar_metres(place) * CLOSE_TEXELS as f32 / BAR_TEXELS[0] as f32
}

pub fn close_texels(lit: bool) -> Vec<u8> {
    let n = CLOSE_TEXELS as f32;
    let alpha = if lit { PILL_ALPHA_LIT } else { PILL_ALPHA };
    let disc = DISC * n / 2.0;
    let unit = DISC * n / 24.0;
    let [from, to, thick] = CROSS;
    let line = |p: [f32; 2], a: [f32; 2], b: [f32; 2]| {
        let (d, q) = ([b[0] - a[0], b[1] - a[1]], [p[0] - a[0], p[1] - a[1]]);
        let t = ((q[0] * d[0] + q[1] * d[1]) / (d[0] * d[0] + d[1] * d[1])).clamp(0.0, 1.0);
        (q[0] - d[0] * t).hypot(q[1] - d[1] * t)
    };
    let mut out = Vec::with_capacity((CLOSE_TEXELS * CLOSE_TEXELS * 4) as usize);
    for y in 0..CLOSE_TEXELS {
        for x in 0..CLOSE_TEXELS {
            let (px, py) = (x as f32 + 0.5 - n / 2.0, y as f32 + 0.5 - n / 2.0);
            let wash = DISC_ALPHA * (0.5 - (px.hypot(py) - disc)).clamp(0.0, 1.0);
            let p = [px / unit + 12.0, py / unit + 12.0];
            let d = line(p, [to, from], [from, to]).min(line(p, [from, from], [to, to])) - thick / 2.0;
            let mark = alpha * (0.5 - d * unit).clamp(0.0, 1.0);
            let a = mark + wash * (1.0 - mark);
            let byte = |v: f32| (v * 255.0).round() as u8;
            let c = |i: usize| byte(PILL_RGB[i] * mark + DISC_RGB[i] * wash * (1.0 - mark));
            out.extend([c(2), c(1), c(0), byte(a)]);
        }
    }
    out
}

#[derive(Clone, Copy, Debug)]
pub struct PanelGrab {
    radius: f32,
    place: Place,
    last: (Option<f32>, f32),
}

impl PanelGrab {
    pub fn start(anchor: &Recentre, place: Place, moved: &Moved, ray: &Ray) -> Option<PanelGrab> {
        let radius = sphere(anchor, pushed(place, moved), ray);
        let last = on_sphere(anchor, radius, ray)?;
        Some(PanelGrab { radius, place, last })
    }

    pub fn push(&mut self, anchor: &Recentre, ray: &Ray, along: f32, dt: f32, reach: Reach, moved: &mut Moved) -> Push {
        let speed = ((along.abs() - PUSH_DEAD) / (1.0 - PUSH_DEAD)).min(1.0);
        if speed <= 0.0 || dt <= 0.0 {
            return Push::Still;
        }
        let from = moved.distance.unwrap_or(self.place.0);
        let to = (from * (PUSH_RATE * speed * along.signum() * dt).exp()).clamp(reach[0], reach[1]);
        if to == from {
            return Push::Still;
        }
        moved.distance = Some(to);
        self.radius = sphere(anchor, pushed(self.place, moved), ray);
        if let Some(at) = on_sphere(anchor, self.radius, ray) {
            self.last = at;
        }
        if to == reach[0] || to == reach[1] { Push::End } else { Push::Moved }
    }

    pub fn drag(&mut self, anchor: &Recentre, ray: &Ray, moved: &mut Moved) -> bool {
        let Some(at) = on_sphere(anchor, self.radius, ray) else { return false };
        let before = *moved;
        if let (Some(from), Some(to)) = (self.last.0, at.0) {
            moved.yaw = wrap(moved.yaw + wrap(to - from));
        }
        moved.pitch = clamp_pitch(self.place, moved.pitch + at.1 - self.last.1);
        self.last = at;
        (moved.yaw - before.yaw).abs() > 1e-3 || (moved.pitch - before.pitch).abs() > 1e-3
    }
}

fn radius((distance, drop, _): Place) -> f32 {
    distance.hypot(drop)
}

fn sphere(anchor: &Recentre, place: Place, ray: &Ray) -> f32 {
    let reach = sub(ray.origin, anchor.origin);
    radius(place).max(dot(reach, reach).sqrt() + REACH_SPARE)
}

fn on_sphere(anchor: &Recentre, radius: f32, ray: &Ray) -> Option<(Option<f32>, f32)> {
    let m = anchor.to_content();
    let [x, y, z] = ray.origin;
    let o = m.then(&Pose::translation(x, y, z)).position();
    let d = m.rotate(ray.direction);
    let b = dot(o, d);
    let disc = b * b - (dot(o, o) - radius * radius);
    if disc < 0.0 {
        return None;
    }
    let t = -b + disc.sqrt();
    if t <= 0.0 {
        return None;
    }
    let h = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    let across = (h[0].hypot(h[2]) > LEVEL * radius).then(|| (-h[0]).atan2(-h[2]).to_degrees());
    Some((across, (h[1] / radius).clamp(-1.0, 1.0).asin().to_degrees()))
}

fn wrap(degrees: f32) -> f32 {
    (degrees + 180.0).rem_euclid(360.0) - 180.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maths::{normalised, panel};

    const DECK: Place = (0.8, 0.38, 25.0);
    const REACH: Reach = [0.5, 1.2];

    fn round(yaw: f32, pitch: f32) -> Moved {
        Moved { yaw, pitch, distance: None }
    }

    fn anchor() -> Recentre {
        Recentre::from_head(&Pose::translation(0.3, 1.2, -0.4).then(&Pose::yaw(30f32.to_radians())))
    }

    fn ray_to(from: [f32; 3], moved: Moved) -> Ray {
        Ray { origin: from, direction: normalised(sub(moved_panel(&anchor(), DECK, &moved).position(), from)) }
    }

    #[test]
    fn unmoved_it_sits_where_it_always_did() {
        let (a, (d, drop, p)) = (anchor(), DECK);
        assert_eq!(moved_panel(&a, DECK, &Moved::default()), panel(&a, d, drop, p));
    }

    #[test]
    fn what_the_ray_grabbed_stays_under_it() {
        for from in [anchor().origin, [0.55, 0.85, -0.5]] {
            let mut moved = Moved::default();
            let mut g = PanelGrab::start(&anchor(), DECK, &moved, &ray_to(from, moved)).unwrap();
            for target in [round(-40.0, 10.0), round(25.0, 30.0), round(170.0, -5.0)] {
                assert!(g.drag(&anchor(), &ray_to(from, target), &mut moved));
                assert!((moved.yaw - target.yaw).abs() < 0.01 && (moved.pitch - target.pitch).abs() < 0.01, "{moved:?} for {target:?} from {from:?}");
            }
            assert!(!g.drag(&anchor(), &ray_to(from, round(170.0, -5.0)), &mut moved), "a still ray moves nothing");
        }
    }

    #[test]
    fn it_turns_the_short_way_round_and_stops_short_of_straight_up() {
        let from = anchor().origin;
        let mut moved = round(170.0, 0.0);
        let mut g = PanelGrab::start(&anchor(), DECK, &moved, &ray_to(from, moved)).unwrap();
        g.drag(&anchor(), &ray_to(from, round(-170.0, 0.0)), &mut moved);
        assert!((moved.yaw + 170.0).abs() < 0.01, "{moved:?}");
        g.drag(&anchor(), &Ray { origin: from, direction: [0.0, 1.0, 0.0] }, &mut moved);
        assert!((moved.pitch - (PITCH_MAX - rest(DECK))).abs() < 0.01, "{moved:?}");
    }

    #[test]
    fn the_stick_pushes_it_along_the_line_from_the_head_and_stops_at_its_reach() {
        let (a, from) = (anchor(), [0.55, 0.85, -0.5]);
        let mut moved = round(20.0, 5.0);
        let ray = ray_to(from, moved);
        let mut g = PanelGrab::start(&a, DECK, &moved, &ray).unwrap();
        let out = |m: &Moved| sub(moved_panel(&a, DECK, m).position(), a.origin);
        let before = out(&moved);
        assert_eq!(g.push(&a, &ray, 0.2, 0.5, REACH, &mut moved), Push::Still, "inside the dead zone");
        assert_eq!(g.push(&a, &ray, 1.0, 0.5, REACH, &mut moved), Push::Moved);
        let k = 0.25f32.exp();
        assert!((moved.distance.unwrap() - 0.8 * k).abs() < 1e-4, "{moved:?}");
        let after = out(&moved);
        assert!((0..3).all(|i| (after[i] - before[i] * k).abs() < 1e-4), "{after:?} from {before:?}");
        assert!(!g.drag(&a, &ray, &mut moved), "the drag follows the new sphere without a jump");
        assert_eq!(g.push(&a, &ray, 1.0, 1.0, REACH, &mut moved), Push::End);
        assert_eq!(moved.distance, Some(REACH[1]));
        assert_eq!(g.push(&a, &ray, 1.0, 1.0, REACH, &mut moved), Push::Still, "held at the end");
        assert_eq!(g.push(&a, &ray, -1.0, 10.0, REACH, &mut moved), Push::End);
        assert_eq!(moved.distance, Some(REACH[0]));
    }

    #[test]
    fn the_bar_is_the_quests_light_grey_pill_brighter_when_lit() {
        let [w, h] = BAR_TEXELS;
        let (rest, lit) = (bar_texels(false), bar_texels(true));
        let at = |x: u32, y: u32| (y * w + x) as usize * 4;
        let centre = at(w / 2, h / 2);
        assert_eq!(&rest[centre..centre + 4], &[98, 96, 95, 102]);
        assert_eq!(&lit[centre..centre + 4], &[161, 158, 157, 168]);
        assert_eq!(&rest[..4], &[0, 0, 0, 0], "clear round it");
        assert!(rest.chunks(4).all(|p| p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3]), "premultiplied");
        let across = (0..w).filter(|&x| rest[at(x, h / 2) + 3] > 51).count();
        let down = (0..h).filter(|&y| rest[at(w / 2, y) + 3] > 51).count();
        assert_eq!((across, down), (202, 24));
    }

    #[test]
    fn the_close_button_is_lucides_x_on_a_dark_disc_right_of_the_bar() {
        let n = CLOSE_TEXELS;
        let (rest, lit) = (close_texels(false), close_texels(true));
        let at = |x: u32, y: u32| (y * n + x) as usize * 4;
        let centre = at(n / 2, n / 2);
        assert!(rest[centre + 3] > 200 && rest[centre] > 90 && lit[centre] > rest[centre], "{:?}", &rest[centre..centre + 4]);
        let wash = at(n / 2, n / 2 + (n as f32 * 0.25) as u32);
        assert!(rest[wash + 3] > 190 && rest[wash] < 20, "{:?}", &rest[wash..wash + 4]);
        assert_eq!(&rest[..4], &[0, 0, 0, 0]);
        assert!(rest.chunks(4).all(|p| p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3]), "premultiplied");
        let bar = bar_pose(&Pose::IDENTITY, DECK, 0.3, false);
        let close = close_pose(&bar, DECK);
        let gap = close.position()[0] - bar.position()[0] - bar_metres(DECK) / 2.0 - close_metres(DECK) / 2.0;
        assert!(gap > 0.0 && (close.position()[1] - bar.position()[1]).abs() < 1e-6, "{gap}");
    }

    #[test]
    fn a_saved_offset_is_kept_within_what_a_drag_reaches() {
        let rest = rest(DECK);
        let m = Moved { distance: Some(5.0), ..round(370.0, 120.0) }.within(DECK, REACH);
        assert!((m.yaw - 10.0).abs() < 0.01 && (m.pitch - (PITCH_MAX - rest)).abs() < 0.01 && m.distance == Some(REACH[1]), "{m:?}");
        let m = round(-20.0, -90.0).within(DECK, REACH);
        assert!(m.yaw == -20.0 && (m.pitch - (-PITCH_MAX - rest)).abs() < 0.01 && m.distance.is_none(), "{m:?}");
        let fine = Moved { distance: Some(1.1), ..round(30.0, 10.0) };
        assert_eq!(fine.within(DECK, REACH), fine);
    }
}
