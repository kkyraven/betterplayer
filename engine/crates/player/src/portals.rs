use std::collections::VecDeque;
use std::f64::consts::PI;
use std::fmt::Write as _;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use bp_vr::{Pose, Recentre};

use crate::vr::VrView;

const DEG: f64 = PI / 180.0;

pub const RADIUS: f64 = 1.5;
pub const PPM: f64 = 1200.0;
pub const PORTAL: PortalSize = PortalSize { w: 0.36, h: 0.225, corner: 0.0135, lift: 0.1, grow: 0.05 };
pub const PORTAL_GAP: f64 = 0.065;
pub const DIVE_DROP: f64 = 0.05;
pub const ROWS_BAND: BandSpec = BandSpec { centre_deg: -4.25, from_deg: -21.0, to_deg: 12.5, half_arc_deg: 33.0 };
pub const STRIP_BAND: BandSpec = BandSpec { centre_deg: -25.55, from_deg: -29.5, to_deg: -21.6, half_arc_deg: 33.0 };
pub const SLIDE_MIN_DEG: f64 = 3.0;
pub const MAX_PORTALS: usize = 16;
pub const DIVE_SLOT: u32 = 16;
pub const SHELF_TEXELS: u32 = 1024;
pub const DIVE_TEXELS: u32 = 2048;
pub const SCREEN_RADIUS: f64 = 3.0;
pub const SCREEN_CORNER: f64 = 0.03;

pub mod ms {
    pub const FADE: f64 = 200.0;
    pub const FADE_NO_SLIDE: f64 = 120.0;
    pub const GROW: f64 = 500.0;
    pub const LIVE: f64 = 300.0;
    pub const LIVE_AFTER_END: f64 = 60.0;
    pub const GRACE: f64 = 250.0;
    pub const LOADING_FADE: f64 = 150.0;
    pub const FLAT: f64 = 500.0;
    pub const FLASH: f64 = 180.0;
    pub const TEXT_FADE: f64 = 120.0;
    pub const SLIDE_BASE: f64 = 160.0;
    pub const SLIDE_PER_DEG: f64 = 4.0;
    pub const BACK_LIB_DELAY: f64 = 100.0;
    pub const BACK_LIB: f64 = 320.0;
}

pub mod aperture {
    pub const FULL_180: [f64; 2] = [105.0, 105.0];
    pub const FULL_360: [f64; 2] = [200.0, 105.0];
    pub const GROW_POW: f64 = 1.6;
    pub const CORNER: f64 = 0.55;
    pub const CORNER_K: f64 = 0.7;
    pub const FEATHER: f64 = 0.22;
    pub const FEATHER_K: f64 = 0.8;
    pub const RIM_VR: f64 = 0.14;
    pub const RIM_FLAT: f64 = 0.05;
    pub const RIM_K: f64 = 0.35;
}

pub fn step_deg() -> f64 {
    (PORTAL.w + PORTAL_GAP) / RADIUS / DEG
}
pub fn fade_in_deg() -> f64 {
    1.5 * step_deg() + 1.0
}
pub fn fade_out_deg() -> f64 {
    2.5 * step_deg() - 2.0
}
pub fn dive_el_deg() -> f64 {
    (-DIVE_DROP).atan2(RADIUS) / DEG
}

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ease {
    Linear,
    Out,
    InOut,
}

impl Ease {
    pub fn parse(s: &str) -> Result<Ease, String> {
        match s {
            "linear" => Ok(Ease::Linear),
            "out" => Ok(Ease::Out),
            "inOut" => Ok(Ease::InOut),
            e => Err(format!("unknown ease {e:?}")),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Keyframe {
    pub from: f64,
    pub to: f64,
    pub start_ms: f64,
    pub duration_ms: f64,
    pub ease: Ease,
}

impl Keyframe {
    pub const fn still(value: f64) -> Keyframe {
        Keyframe { from: value, to: value, start_ms: 0.0, duration_ms: 0.0, ease: Ease::Linear }
    }

    pub fn at(&self, now_ms: f64) -> f64 {
        if self.duration_ms <= 0.0 {
            return self.to;
        }
        self.from + (self.to - self.from) * ease(self.ease, (now_ms - self.start_ms) / self.duration_ms)
    }
}

pub fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

pub fn smooth(x: f64) -> f64 {
    let t = clamp01(x);
    t * t * (3.0 - 2.0 * t)
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

pub fn ease(e: Ease, t: f64) -> f64 {
    let x = clamp01(t);
    match e {
        Ease::Linear => x,
        Ease::Out => 1.0 - (1.0 - x).powi(3),
        Ease::InOut if x < 0.5 => 4.0 * x * x * x,
        Ease::InOut => 1.0 - (-2.0 * x + 2.0).powi(3) / 2.0,
    }
}

pub fn edge_fade(az_deg: f64) -> f64 {
    smooth((fade_out_deg() - az_deg.abs()) / (fade_out_deg() - fade_in_deg()))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BandSpec {
    pub centre_deg: f64,
    pub from_deg: f64,
    pub to_deg: f64,
    pub half_arc_deg: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BandLayout {
    pub width: u32,
    pub height: u32,
    pub metres: f64,
    pub curvature: f64,
    pub distance: f64,
    pub drop: f64,
    pub pitch: f64,
}

pub fn band_layout(b: &BandSpec) -> BandLayout {
    let width = (2.0 * b.half_arc_deg * DEG * RADIUS * PPM).round();
    let height = (RADIUS * (((b.to_deg - b.centre_deg) * DEG).tan() - ((b.from_deg - b.centre_deg) * DEG).tan()) * PPM).round();
    let metres = width / PPM;
    let c = b.centre_deg * DEG;
    BandLayout {
        width: width as u32,
        height: height as u32,
        metres,
        curvature: metres / (2.0 * PI * RADIUS),
        distance: RADIUS * c.cos(),
        drop: -RADIUS * c.sin(),
        pitch: -b.centre_deg,
    }
}

type V3 = [f64; 3];

fn about_x(v: V3, a: f64) -> V3 {
    let (s, c) = a.sin_cos();
    [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c]
}

pub fn direction(az: f64, el: f64) -> V3 {
    [el.cos() * az.sin(), el.sin(), -el.cos() * az.cos()]
}

pub fn angles(v: V3) -> (f64, f64) {
    (v[0].atan2(-v[2]), v[1].atan2(v[0].hypot(v[2])))
}

pub fn band_texel(b: &BandSpec, az_deg: f64, el_deg: f64) -> (f64, f64) {
    let l = band_layout(b);
    let v = about_x(direction(az_deg * DEG, el_deg * DEG), -b.centre_deg * DEG);
    let (az, el) = angles(v);
    (l.width as f64 / 2.0 + az * RADIUS * PPM, l.height as f64 / 2.0 - RADIUS * el.tan() * PPM)
}

pub fn band_direction(b: &BandSpec, x: f64, y: f64) -> (f64, f64) {
    let l = band_layout(b);
    let az = (x - l.width as f64 / 2.0) / PPM / RADIUS;
    let el = ((l.height as f64 / 2.0 - y) / PPM / RADIUS).atan();
    let (a, e) = angles(about_x(direction(az, el), b.centre_deg * DEG));
    (a / DEG, e / DEG)
}

pub fn band_point(metres: f64, curvature: f64, width: u32, height: u32, x: f64, y: f64) -> V3 {
    let ppm = width as f64 / metres;
    let along = (x - width as f64 / 2.0) / ppm;
    let v = (height as f64 / 2.0 - y) / ppm;
    if curvature <= 1e-6 {
        return [along, v, 0.0];
    }
    let r = metres / (2.0 * PI * curvature);
    let phi = along / r;
    [r * phi.sin(), v, r * (1.0 - phi.cos())]
}

pub fn apply(pose: &Pose, p: V3) -> V3 {
    let m = &pose.0;
    [0, 1, 2].map(|r| m[r][0] as f64 * p[0] + m[r][1] as f64 * p[1] + m[r][2] as f64 * p[2] + m[r][3] as f64)
}

pub fn pose_of(n: &[f64]) -> Result<Pose, String> {
    if n.len() != 12 {
        return Err(format!("a pose needs 12 numbers, got {}", n.len()));
    }
    let row = |r: usize| [0, 1, 2, 3].map(|c| n[r * 4 + c] as f32);
    Ok(Pose([row(0), row(1), row(2)]))
}

pub fn seat_of(n: &[f64]) -> Result<Recentre, String> {
    let [x, y, z, heading, pitch, roll] = n[..] else { return Err(format!("a seat needs 6 numbers, got {}", n.len())) };
    Ok(Recentre { origin: [x as f32, y as f32, z as f32], heading: heading as f32, pitch: pitch as f32, roll: roll as f32 })
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PortalSize {
    pub w: f64,
    pub h: f64,
    pub corner: f64,
    pub lift: f64,
    pub grow: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PortalPose {
    pub az: f64,
    pub el: f64,
    pub d: f64,
    pub hr: f64,
    pub s: f64,
}

pub fn portal_pose(az_deg: f64, el_deg: f64, h: f64, size: &PortalSize, dz: f64) -> PortalPose {
    let r = RADIUS - size.lift * h + dz;
    let el = el_deg * DEG;
    PortalPose { az: az_deg * DEG, el, d: r / el.cos(), hr: r, s: 1.0 + size.grow * h }
}

fn wrap(a: f64) -> f64 {
    a.sin().atan2(a.cos())
}

pub fn portal_hit(o: V3, v: V3, p: &PortalPose, size: &PortalSize) -> Option<(f64, f64, f64)> {
    let b = o[0] * v[0] + o[1] * v[1] + o[2] * v[2];
    let c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - p.d * p.d;
    let disc = b * b - c;
    if disc < 0.0 {
        return None;
    }
    let t = -b + disc.sqrt();
    if t <= 0.0 {
        return None;
    }
    let (az, el) = angles([o[0] + v[0] * t, o[1] + v[1] * t, o[2] + v[2] * t]);
    let x = wrap(az - p.az) * p.hr / p.s;
    let y = (el - p.el) * p.d / p.s;
    (rbox(x, y, size.w / 2.0, size.h / 2.0, size.corner) <= 0.0).then_some((t, x, y))
}

pub fn rbox(x: f64, y: f64, bx: f64, by: f64, r: f64) -> f64 {
    let (qx, qy) = (x.abs() - bx + r, y.abs() - by + r);
    qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - r
}

pub fn portal_point(p: &PortalPose, x: f64, y: f64) -> V3 {
    let az = p.az + x * p.s / p.hr;
    let el = p.el + y * p.s / p.d;
    direction(az, el).map(|c| c * p.d)
}

pub fn world_turn(az_deg: f64, el_deg: f64) -> (f64, f64) {
    (az_deg * DEG, (el_deg - dive_el_deg()) * DEG)
}

pub fn turned_angles(v: V3, (yaw, pitch): (f64, f64)) -> (f64, f64) {
    let (sy, cy) = yaw.sin_cos();
    let x1 = v[0] * cy + v[2] * sy;
    let f1 = v[0] * sy - v[2] * cy;
    let (sp, cp) = pitch.sin_cos();
    let y2 = v[1] * cp - f1 * sp;
    let f2 = v[1] * sp + f1 * cp;
    (x1.atan2(f2), y2.clamp(-1.0, 1.0).asin())
}

pub fn still_uv(az: f64, el: f64, hh: f64, hv: f64) -> Option<(f64, f64)> {
    (az.abs() <= hh && el.abs() <= hv).then(|| (0.5 + az / (2.0 * hh), 0.5 - el / (2.0 * hv)))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiveKind {
    Vr,
    Flat,
    Back,
    FlatBack,
}

impl DiveKind {
    pub fn parse(s: &str) -> Result<DiveKind, String> {
        match s {
            "vr" => Ok(DiveKind::Vr),
            "flat" => Ok(DiveKind::Flat),
            "back" => Ok(DiveKind::Back),
            "flatBack" => Ok(DiveKind::FlatBack),
            k => Err(format!("unknown dive {k:?}")),
        }
    }

    fn forward(self) -> bool {
        matches!(self, DiveKind::Vr | DiveKind::Flat)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ApertureFrom {
    pub az: f64,
    pub el: f64,
    pub hw: f64,
    pub hh: f64,
    pub rr: f64,
    pub rp: f64,
}

pub fn portal_angles(az_rad: f64, y: f64, r: f64, s: f64, size: &PortalSize) -> ApertureFrom {
    let d = r.hypot(y);
    ApertureFrom { az: az_rad, el: y.atan2(r), hw: size.w * s / 2.0 / d, hh: size.h * s / 2.0 / d, rr: size.corner * s / d, rp: d }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TilePose {
    pub a: f64,
    pub y: f64,
    pub r: f64,
    pub w: f64,
    pub h: f64,
    pub crop: f64,
    pub bend: f64,
    pub tilt: f64,
    pub rad: f64,
}

impl TilePose {
    pub fn of(a: f64, y: f64, r: f64, s: f64, size: &PortalSize) -> TilePose {
        TilePose { a, y, r, w: size.w * s, h: size.h * s, crop: (size.w / size.h) / (16.0 / 9.0), bend: 1.0 / r.hypot(y), tilt: y.atan2(r), rad: size.corner * s }
    }

    fn lerp(&self, b: &TilePose, t: f64) -> TilePose {
        TilePose {
            a: lerp(self.a, b.a, t),
            y: lerp(self.y, b.y, t),
            r: lerp(self.r, b.r, t),
            w: lerp(self.w, b.w, t),
            h: lerp(self.h, b.h, t),
            crop: lerp(self.crop, b.crop, t),
            bend: lerp(self.bend, b.bend, t),
            tilt: lerp(self.tilt, b.tilt, t),
            rad: lerp(self.rad, b.rad, t),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SlideFrom {
    pub az: f64,
    pub y: f64,
    pub r: f64,
    pub s: f64,
    pub h: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DiveSpec {
    pub kind: DiveKind,
    pub start_ms: f64,
    pub slide_ms: f64,
    pub same: bool,
    pub full: u32,
    pub from: ApertureFrom,
    pub slide_from: Option<SlideFrom>,
    pub tile: Option<TilePose>,
    pub screen: Option<TilePose>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transition {
    pub spec: DiveSpec,
    pub reversed_at_ms: Option<f64>,
    pub reversed_from_e: Option<f64>,
    pub live_at_ms: Option<f64>,
    pub failed: bool,
    pub held: bool,
}

impl Transition {
    pub fn start(spec: DiveSpec) -> Transition {
        Transition { spec, reversed_at_ms: None, reversed_from_e: None, live_at_ms: None, failed: false, held: false }
    }

    pub fn reverse(&self, now_ms: f64, failed: bool) -> Transition {
        if self.reversed_at_ms.is_some() {
            return Transition { failed: self.failed || failed, ..*self };
        }
        let e = self.elapsed(now_ms).max(0.0).min(grow_end(&self.spec));
        Transition { reversed_at_ms: Some(now_ms), reversed_from_e: Some(e), failed: self.failed || failed, ..*self }
    }

    pub fn elapsed(&self, now_ms: f64) -> f64 {
        match (self.reversed_at_ms, self.reversed_from_e) {
            (Some(at), Some(from)) => from - (now_ms - at),
            _ => now_ms - self.spec.start_ms,
        }
    }
}

pub fn grow_end(spec: &DiveSpec) -> f64 {
    match spec.kind {
        DiveKind::Vr => spec.slide_ms + ms::GROW,
        DiveKind::Back => ms::GROW,
        DiveKind::Flat | DiveKind::FlatBack => ms::FLAT,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FramePortal {
    pub az: f64,
    pub y: f64,
    pub r: f64,
    pub s: f64,
    pub hover: f64,
    pub op: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameAperture {
    pub az: f64,
    pub el: f64,
    pub hw: f64,
    pub hh: f64,
    pub rr: f64,
    pub feather: f64,
    pub rim: f64,
    pub rp: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DiveFrame {
    pub e: f64,
    pub lib_f: f64,
    pub text_f: f64,
    pub flash: f64,
    pub sliding: bool,
    pub portal: Option<FramePortal>,
    pub aperture: Option<FrameAperture>,
    pub in_b: f64,
    pub out_b: f64,
    pub out_a: f64,
    pub tile: Option<TilePose>,
    pub live: f64,
    pub loading: f64,
    pub done: bool,
    pub undone: bool,
}

fn grown(from: &ApertureFrom, full: u32, k: f64) -> FrameAperture {
    use aperture::*;
    let [tw, th] = if full == 360 { FULL_360 } else { FULL_180 };
    let hw = from.hw * (tw * DEG / from.hw).powf(k);
    let hh = from.hh * (th * DEG / from.hh).powf(k);
    FrameAperture {
        az: from.az,
        el: from.el,
        hw,
        hh,
        rr: lerp(from.rr, hw.min(hh) * CORNER, smooth(k / CORNER_K)),
        feather: FEATHER * hh * smooth(k / FEATHER_K),
        rim: RIM_VR * (1.0 - smooth(k / RIM_K)),
        rp: from.rp,
    }
}

pub fn dive_frame(t: &Transition, now_ms: f64, dim: f64) -> DiveFrame {
    let s = &t.spec;
    let reversed = t.reversed_at_ms.is_some();
    let raw = t.elapsed(now_ms);
    let forward = s.kind.forward();
    let end = grow_end(s);
    let t_ready = if !forward || s.same {
        0.0
    } else {
        match t.live_at_ms.filter(|_| !t.held) {
            Some(live) => (end + ms::LIVE_AFTER_END).max(live - s.start_ms),
            None => f64::INFINITY,
        }
    };
    let total = if !forward || s.same { end } else { t_ready + ms::LIVE };
    let e = raw.max(0.0).min(total);
    let mut f = DiveFrame {
        e,
        lib_f: 1.0,
        text_f: 1.0,
        flash: 0.0,
        sliding: false,
        portal: None,
        aperture: None,
        in_b: 1.0,
        out_b: 1.0,
        out_a: 1.0,
        tile: None,
        live: 1.0,
        loading: 0.0,
        done: !reversed && raw >= total,
        undone: reversed && raw <= 0.0,
    };
    if forward {
        let e_max = if reversed { t.reversed_from_e.unwrap_or(e) } else { e };
        f.flash = 1.0 - smooth(e_max / ms::FLASH);
        f.text_f = 1.0 - smooth(e / ms::TEXT_FADE);
        f.live = if s.same {
            1.0
        } else if t.held {
            0.0
        } else {
            smooth((e - t_ready) / ms::LIVE)
        };
        f.loading = if !s.same && !t.held && t_ready > end + ms::GRACE {
            smooth((e - end - ms::GRACE) / ms::LOADING_FADE) * (1.0 - smooth((e - t_ready) / ms::LOADING_FADE))
        } else {
            0.0
        };
    }
    match s.kind {
        DiveKind::Vr => {
            let tg = s.slide_ms;
            f.lib_f = 1.0 - smooth(e / if tg > 0.0 { ms::FADE } else { ms::FADE_NO_SLIDE });
            f.sliding = e < tg;
            let k = if f.sliding { 0.0 } else { 1.0 - (1.0 - clamp01((e - tg) / ms::GROW)).powf(aperture::GROW_POW) };
            if let (true, Some(from)) = (f.sliding, s.slide_from) {
                let g = ease(Ease::InOut, e / tg);
                let y_d = DIVE_DROP * from.r / RADIUS;
                f.portal = Some(FramePortal { az: from.az * (1.0 - g), y: lerp(from.y, y_d, g), r: from.r, s: from.s, hover: from.h * (1.0 - g), op: 1.0 });
            }
            if !f.sliding {
                f.aperture = Some(grown(&s.from, s.full, k));
            }
            f.out_b = if s.same { lerp(dim, 1.0, smooth((k - 0.4) / 0.6)) } else { 1.0 };
            f.out_a = if s.same { 1.0 } else { smooth((k - 0.55) / 0.45) };
        }
        DiveKind::Flat => {
            f.lib_f = 1.0 - smooth(e / ms::FADE);
            if let (Some(tile), Some(screen)) = (s.tile, s.screen) {
                f.tile = Some(tile.lerp(&screen, ease(Ease::Out, e / ms::FLAT)));
            }
        }
        DiveKind::Back => {
            let k = (1.0 - clamp01(e / ms::GROW)).powf(aperture::GROW_POW);
            f.aperture = Some(grown(&s.from, s.full, k));
            f.out_b = lerp(1.0, dim, smooth((0.8 - k) / 0.45));
            f.lib_f = smooth((e - ms::BACK_LIB_DELAY) / ms::BACK_LIB);
            f.text_f = f.lib_f;
            let a = &s.from;
            f.portal = Some(FramePortal { az: a.az / DEG, y: a.rp * a.el.sin(), r: a.rp * a.el.cos(), s: 1.0, hover: 0.0, op: if e >= ms::GROW { 1.0 } else { 0.0 } });
        }
        DiveKind::FlatBack => {
            f.lib_f = smooth((e - ms::BACK_LIB_DELAY) / ms::BACK_LIB);
            f.text_f = f.lib_f;
            if let (Some(tile), Some(screen)) = (s.tile, s.screen) {
                f.tile = Some(tile.lerp(&screen, 1.0 - ease(Ease::Out, e / ms::FLAT)));
                f.portal = Some(FramePortal { az: tile.a, y: tile.y, r: tile.r, s: 1.0, hover: 0.0, op: if e >= ms::FLAT { 1.0 } else { 0.0 } });
            }
        }
    }
    f
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Band {
    Rows,
    Strip,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PortalBand {
    pub band: Band,
    pub pose: Pose,
    pub metres: f64,
    pub curvature: f64,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemKind {
    Still,
    Poster,
    Live,
    Blank,
}

impl ItemKind {
    pub fn parse(s: &str) -> Result<ItemKind, String> {
        match s {
            "still" => Ok(ItemKind::Still),
            "poster" => Ok(ItemKind::Poster),
            "live" => Ok(ItemKind::Live),
            "blank" => Ok(ItemKind::Blank),
            k => Err(format!("unknown portal kind {k:?}")),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PortalItem {
    pub key: String,
    pub x: f64,
    pub y: f64,
    pub size: PortalSize,
    pub row: i32,
    pub kind: ItemKind,
    pub slot: Option<u32>,
    pub lift: Keyframe,
    pub shade: Keyframe,
    pub enter: Keyframe,
    pub dz: f64,
    pub op: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PortalScene {
    pub rev: u32,
    pub seat: Recentre,
    pub bands: Vec<PortalBand>,
    pub items: Vec<PortalItem>,
    pub scroll: Vec<Keyframe>,
    pub shown: Keyframe,
    pub fade: Keyframe,
    pub dim: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StillInfo {
    pub equirect: bool,
    pub half_h_deg: f64,
    pub half_v_deg: f64,
    pub width: u32,
    pub height: u32,
    pub key: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Dive {
    pub kind: DiveKind,
    pub key: String,
    pub start_ms: f64,
    pub slide_ms: f64,
    pub same: bool,
    pub full: u32,
    pub screen_deg: f64,
    pub aspect: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PortalStatus {
    pub phase: &'static str,
    pub key: Option<String>,
    pub elapsed_ms: f64,
    pub live_at_ms: Option<f64>,
    pub done: bool,
    pub undone: bool,
}

struct Placed {
    scene: PortalScene,
    rest: Vec<(f64, f64)>,
}

fn rest_of(band: &PortalBand, seat: &Recentre, x: f64, y: f64) -> (f64, f64) {
    let p = apply(&band.pose, band_point(band.metres, band.curvature, band.width, band.height, x, y));
    let (az, el) = angles(apply(&seat.to_content(), p));
    (az / DEG, el / DEG)
}

fn place(scene: PortalScene) -> Placed {
    let rows = scene.bands.iter().find(|b| b.band == Band::Rows);
    let rest = scene
        .items
        .iter()
        .map(|i| match rows {
            Some(b) => rest_of(b, &scene.seat, i.x, i.y),
            None => band_direction(&ROWS_BAND, i.x, i.y),
        })
        .collect();
    Placed { scene, rest }
}

struct Running {
    key: String,
    t: Transition,
    aspect: f64,
    traced: bool,
}

impl Running {
    fn new(dive: &Dive, t: Transition) -> Running {
        Running { key: dive.key.clone(), t, aspect: if dive.aspect > 0.0 { dive.aspect } else { 16.0 / 9.0 }, traced: false }
    }
}

pub(crate) struct Upload {
    pub slot: u32,
    pub rgba: Vec<u8>,
    pub info: StillInfo,
}

const TRACE_KEPT: usize = 256;
const BUZZES_KEPT: usize = 32;

struct Shared {
    placed: Option<Arc<Placed>>,
    running: Option<Running>,
    uploads: Vec<Upload>,
    drops: Vec<u32>,
    waiting: bool,
    restarted: bool,
    first_drawn: Option<f64>,
    held_view: Option<VrView>,
    content: Option<Recentre>,
    release: Option<VrView>,
    keyframe_start: bool,
    eye: Option<[f64; 3]>,
    debug: bool,
    hold: bool,
    mirror: Option<String>,
    trace: VecDeque<String>,
    buzzes: VecDeque<String>,
    head: Option<Pose>,
    measuring: bool,
    upload_ms: Vec<f64>,
    mip_ms: Vec<f64>,
}

static SHARED: Mutex<Shared> = Mutex::new(Shared {
    placed: None,
    running: None,
    uploads: Vec::new(),
    drops: Vec::new(),
    waiting: false,
    restarted: false,
    first_drawn: None,
    held_view: None,
    content: None,
    release: None,
    keyframe_start: false,
    eye: None,
    debug: false,
    hold: false,
    mirror: None,
    trace: VecDeque::new(),
    buzzes: VecDeque::new(),
    head: None,
    measuring: false,
    upload_ms: Vec::new(),
    mip_ms: Vec::new(),
});

fn shared() -> std::sync::MutexGuard<'static, Shared> {
    SHARED.lock().unwrap_or_else(|e| e.into_inner())
}

impl Shared {
    fn trace(&mut self, phase: &str, key: &str, at_ms: f64) {
        let line = format!("BpStart {phase} {at_ms:.1} {key}");
        if std::env::var_os("BP_START_TRACE").is_some() {
            eprintln!("{line}");
        }
        self.trace.push_back(line);
        while self.trace.len() > TRACE_KEPT {
            self.trace.pop_front();
        }
    }

    fn waiting_dive(&self) -> Option<&Running> {
        self.running.as_ref().filter(|r| r.t.spec.kind.forward() && !r.t.spec.same && r.t.reversed_at_ms.is_none() && r.t.live_at_ms.is_none())
    }

    fn go_live(&mut self, at: f64) {
        let Some(r) = self.running.as_mut() else { return };
        r.t.live_at_ms = Some(at);
        let key = r.key.clone();
        self.content = self.placed.as_ref().map(|p| p.scene.seat);
        self.release = self.held_view.take();
        self.trace("live", &key, at);
    }
}

pub(crate) fn loading(headset: bool) {
    if !headset {
        return;
    }
    let mut s = shared();
    s.waiting = true;
    s.restarted = false;
}

pub(crate) fn restarted(headset: bool) {
    let mut s = shared();
    s.restarted |= headset && s.waiting;
}

pub(crate) fn drawn() {
    let mut s = shared();
    if !(s.waiting && s.restarted) {
        return;
    }
    s.waiting = false;
    s.restarted = false;
    let now = now_ms();
    s.first_drawn = Some(now);
    if s.waiting_dive().is_some() {
        s.go_live(now);
    }
}

pub(crate) fn hold_view(view: VrView) -> bool {
    let mut s = shared();
    if s.waiting_dive().is_none() {
        return false;
    }
    s.held_view = Some(view);
    true
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct Taken {
    pub seat: Option<Recentre>,
    pub view: Option<VrView>,
}

pub(crate) fn take() -> Taken {
    let mut s = shared();
    Taken { seat: s.content.take(), view: s.release.take() }
}

pub(crate) fn take_keyframe_start(headset: bool) -> bool {
    headset && std::mem::take(&mut shared().keyframe_start)
}

pub(crate) fn loadfile_options(start: Option<f64>, end: Option<f64>, keyframe: bool) -> Vec<String> {
    let mut options = Vec::new();
    if let Some(start) = start.filter(|s| *s > 0.0) {
        options.push(format!("start={start}"));
        if keyframe {
            options.push("hr-seek=no".into());
        }
    }
    if let Some(end) = end {
        options.push(format!("end={end}"));
    }
    options
}

pub(crate) fn buzzed(hand: usize, buzz: bp_vr::Buzz) {
    let mut s = shared();
    let line = format!("{:.1} {} {buzz:?}", now_ms(), if hand == 0 { "left" } else { "right" });
    s.buzzes.push_back(line);
    while s.buzzes.len() > BUZZES_KEPT {
        s.buzzes.pop_front();
    }
}

pub(crate) fn take_uploads() -> (Vec<u32>, Vec<Upload>) {
    let mut s = shared();
    (std::mem::take(&mut s.drops), std::mem::take(&mut s.uploads))
}

pub(crate) fn take_mirror() -> Option<String> {
    shared().mirror.take()
}

pub(crate) fn set_head(head: &Pose) {
    shared().head = Some(*head);
}

pub fn last_head() -> Option<Pose> {
    shared().head
}

pub fn measure_uploads(on: bool) {
    shared().measuring = on;
}

pub(crate) fn measuring() -> bool {
    shared().measuring
}

pub(crate) fn uploaded_in(ms: f64) {
    shared().upload_ms.push(ms);
}

pub fn take_upload_ms() -> Vec<f64> {
    std::mem::take(&mut shared().upload_ms)
}

pub(crate) fn mipped_in(ms: f64) {
    shared().mip_ms.push(ms);
}

pub fn take_mip_ms() -> Vec<f64> {
    std::mem::take(&mut shared().mip_ms)
}

#[cfg(test)]
pub(crate) fn set_for_test(scene: Option<PortalScene>, dive: Option<(Dive, Option<f64>)>, debug: bool, uploads: Vec<Upload>, eye: Option<[f64; 3]>) {
    let mut s = shared();
    s.eye = eye;
    s.placed = scene.map(|sc| Arc::new(place(sc)));
    s.running = dive.map(|(d, live)| {
        let mut t = Transition::start(spec_for(s.placed.as_deref(), &d));
        t.live_at_ms = live;
        Running::new(&d, t)
    });
    s.debug = debug;
    s.uploads = uploads;
}

#[derive(Clone, Debug, PartialEq)]
pub struct ItemDraw {
    pub key: String,
    pub pose: PortalPose,
    pub size: PortalSize,
    pub turn: (f64, f64),
    pub kind: ItemKind,
    pub slot: Option<u32>,
    pub op: f64,
    pub shade: f64,
    pub ring: f64,
    pub flash: f64,
    pub texel: (f64, f64),
    pub az_deg: f64,
    pub el_deg: f64,
    pub edge: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DiveDraw {
    pub kind: DiveKind,
    pub key: String,
    pub same: bool,
    pub frame: DiveFrame,
    pub old: f64,
    pub ring_flash: f64,
    pub tile_rim: f64,
    pub slot: Option<u32>,
    pub item_kind: ItemKind,
    pub size: PortalSize,
    pub aspect: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FrameState {
    pub on: bool,
    pub seat: Recentre,
    pub eye: [f64; 3],
    pub dim: f64,
    pub items: Vec<ItemDraw>,
    pub dive: Option<DiveDraw>,
    pub debug: bool,
}

pub fn frame(now: f64) -> FrameState {
    let mut s = shared();
    let state = frame_of(&s, now);
    if let Some(r) = s.running.as_mut().filter(|r| !r.traced && state.dive.is_some()) {
        r.traced = true;
        let key = r.key.clone();
        s.trace("grow", &key, now);
    }
    state
}

fn frame_of(s: &Shared, now: f64) -> FrameState {
    let Some(placed) = s.placed.as_deref() else {
        return FrameState { dim: 1.0, ..FrameState::default() };
    };
    let scene = &placed.scene;
    let shown = clamp01(scene.shown.at(now) * scene.fade.at(now));
    let dive = s.running.as_ref().and_then(|r| {
        let frame = dive_frame(&r.t, now, scene.dim);
        (!frame.done && !frame.undone).then_some((r, frame))
    });
    let mut items = Vec::new();
    for (i, item) in scene.items.iter().enumerate() {
        if dive.as_ref().is_some_and(|(r, _)| r.key == item.key) {
            continue;
        }
        let (rest_az, el) = placed.rest[i];
        let scroll = usize::try_from(item.row).ok().and_then(|row| scene.scroll.get(row)).map_or(0.0, |k| k.at(now));
        let az = wrap(DEG * (rest_az - scroll)) / DEG;
        let enter = clamp01(item.enter.at(now));
        let edge = if item.row >= 0 { edge_fade(az) } else { 1.0 };
        let op = edge * shown * item.op * enter;
        if op <= 0.002 {
            continue;
        }
        let lift = clamp01(item.lift.at(now));
        items.push(ItemDraw {
            key: item.key.clone(),
            pose: portal_pose(az, el, lift, &item.size, item.dz * (1.0 - enter)),
            size: item.size,
            turn: world_turn(az, el),
            kind: item.kind,
            slot: item.slot,
            op,
            shade: item.shade.at(now),
            ring: lift,
            flash: 0.0,
            texel: (item.x, item.y),
            az_deg: az,
            el_deg: el,
            edge,
        });
    }
    let dive = dive.map(|(r, mut frame)| {
        let spec = &r.t.spec;
        if !(spec.kind == DiveKind::Flat && !spec.same) {
            frame.tile = None;
        }
        let item = scene.items.iter().find(|i| i.key == r.key);
        let size = item.map_or(PORTAL, |i| i.size);
        if let Some(p) = frame.portal.filter(|p| p.op > 0.0) {
            let el = p.y.atan2(p.r);
            items.push(ItemDraw {
                key: r.key.clone(),
                pose: PortalPose { az: p.az * DEG, el, d: p.r.hypot(p.y), hr: p.r, s: p.s },
                size,
                turn: world_turn(p.az, el / DEG),
                kind: if spec.kind.forward() { item.map_or(ItemKind::Blank, |i| i.kind) } else { ItemKind::Live },
                slot: item.and_then(|i| i.slot),
                op: p.op,
                shade: 1.0,
                ring: p.hover,
                flash: frame.flash,
                texel: item.map_or((0.0, 0.0), |i| (i.x, i.y)),
                az_deg: p.az,
                el_deg: el / DEG,
                edge: 1.0,
            });
        }
        let fade = if spec.kind == DiveKind::Flat { ms::FLAT } else { ms::FADE };
        let old = if spec.kind.forward() && !spec.same && (r.t.live_at_ms.is_none() || r.t.reversed_at_ms.is_some()) {
            1.0 - smooth(frame.e / fade)
        } else if spec.kind.forward() && !spec.same {
            0.0
        } else {
            1.0
        };
        let tile_rim = if frame.tile.is_some() { aperture::RIM_FLAT * (1.0 - ease(Ease::Out, frame.e / ms::FLAT)) } else { 0.0 };
        DiveDraw {
            kind: spec.kind,
            key: r.key.clone(),
            same: spec.same,
            frame,
            old,
            ring_flash: if spec.kind == DiveKind::Vr && spec.slide_ms <= 0.0 { frame.flash } else { 0.0 },
            tile_rim,
            slot: item.and_then(|i| i.slot),
            item_kind: item.map_or(ItemKind::Blank, |i| i.kind),
            size,
            aspect: r.aspect,
        }
    });
    items.sort_by(|a, b| b.pose.d.total_cmp(&a.pose.d));
    items.truncate(MAX_PORTALS);
    FrameState {
        on: shown > 0.0 || dive.is_some(),
        seat: scene.seat,
        eye: s.eye.unwrap_or_default(),
        dim: lerp(1.0, scene.dim, shown),
        items,
        dive,
        debug: s.debug,
    }
}

pub fn flat_screen(arc_deg: f64, aspect: f64) -> (f64, f64) {
    let width = SCREEN_RADIUS * arc_deg * DEG;
    let height = width * 9.0 / 16.0;
    if aspect < 16.0 / 9.0 { (height * aspect, height) } else { (width, width / aspect) }
}

fn spec_for(placed: Option<&Placed>, dive: &Dive) -> DiveSpec {
    let at = dive.start_ms;
    let found = placed.and_then(|p| p.scene.items.iter().position(|i| i.key == dive.key).map(|i| (p, i)));
    let (az, el, h, size) = match found {
        Some((p, i)) => {
            let item = &p.scene.items[i];
            let scroll = usize::try_from(item.row).ok().and_then(|row| p.scene.scroll.get(row)).map_or(0.0, |k| k.at(at));
            let h = if dive.kind.forward() { clamp01(item.lift.at(at)) } else { 0.0 };
            (wrap(DEG * (p.rest[i].0 - scroll)) / DEG, p.rest[i].1, h, item.size)
        }
        None => (0.0, dive_el_deg(), 0.0, PORTAL),
    };
    let r = RADIUS - size.lift * h;
    let y = r * (el * DEG).tan();
    let s = 1.0 + size.grow * h;
    let full = if dive.full == 360 { 360 } else { 180 };
    let (sw, sh) = flat_screen(dive.screen_deg, if dive.aspect > 0.0 { dive.aspect } else { 16.0 / 9.0 });
    let screen = TilePose { a: 0.0, y: 0.0, r: SCREEN_RADIUS, w: sw, h: sh, crop: 1.0, bend: 1.0 / SCREEN_RADIUS, tilt: 0.0, rad: SCREEN_CORNER };
    let flat = matches!(dive.kind, DiveKind::Flat | DiveKind::FlatBack);
    let from = match dive.kind {
        DiveKind::Vr if !dive.same => portal_angles(0.0, DIVE_DROP * r / RADIUS, r, s, &size),
        _ => portal_angles(az * DEG, y, r, s, &size),
    };
    DiveSpec {
        kind: dive.kind,
        start_ms: at,
        slide_ms: if dive.kind == DiveKind::Vr { dive.slide_ms.max(0.0) } else { 0.0 },
        same: dive.same,
        full,
        from,
        slide_from: (dive.kind == DiveKind::Vr && dive.slide_ms > 0.0).then_some(SlideFrom { az, y, r, s, h }),
        tile: flat.then(|| TilePose::of(az, y, r, s, &size)),
        screen: flat.then_some(screen),
    }
}

pub(crate) fn status(now: f64) -> PortalStatus {
    status_at(&shared(), now)
}

impl crate::Player {
    pub fn vr_portals(&self, scene: PortalScene) -> Result<(), String> {
        if scene.items.len() > MAX_PORTALS {
            return Err(format!("{} portals, at most {MAX_PORTALS}", scene.items.len()));
        }
        if let Some(i) = scene.items.iter().find(|i| i.slot.is_some_and(|s| s >= DIVE_SLOT)) {
            return Err(format!("portal {} has slot {:?}; shelf slots are 0 to 15", i.key, i.slot));
        }
        shared().placed = Some(Arc::new(place(scene)));
        Ok(())
    }

    pub fn vr_still(&self, slot: u32, rgba: &[u8], info: StillInfo) -> Result<(), String> {
        let max = if slot == DIVE_SLOT { DIVE_TEXELS } else { SHELF_TEXELS };
        if slot > DIVE_SLOT {
            return Err(format!("no still slot {slot}"));
        }
        if info.width == 0 || info.height == 0 || info.width > max || info.height > max {
            return Err(format!("a {}x{} still does not fit slot {slot} ({max}x{max})", info.width, info.height));
        }
        if rgba.len() != (info.width * info.height * 4) as usize {
            return Err(format!("still of {}x{} got {} bytes", info.width, info.height, rgba.len()));
        }
        let rgba = rgba.to_vec();
        let mut s = shared();
        s.uploads.retain(|u| u.slot != slot);
        s.drops.retain(|&d| d != slot);
        s.uploads.push(Upload { slot, rgba, info });
        Ok(())
    }

    pub fn vr_still_drop(&self, slot: u32) -> Result<(), String> {
        if slot > DIVE_SLOT {
            return Err(format!("no still slot {slot}"));
        }
        let mut s = shared();
        s.uploads.retain(|u| u.slot != slot);
        s.drops.push(slot);
        Ok(())
    }

    pub fn vr_dive(&self, dive: Dive) -> Result<(), String> {
        let mut s = shared();
        let spec = spec_for(s.placed.as_deref(), &dive);
        let mut t = Transition::start(spec);
        t.held = s.hold;
        if s.placed.as_ref().is_none_or(|p| !p.scene.items.iter().any(|i| i.key == dive.key)) {
            s.trace("missing", &dive.key, now_ms());
        }
        s.held_view = None;
        s.running = Some(Running::new(&dive, t));
        if let Some(at) = s.first_drawn.filter(|at| *at >= dive.start_ms && !s.waiting)
            && s.waiting_dive().is_some()
        {
            s.go_live(at);
        }
        Ok(())
    }

    pub fn vr_dive_reverse(&self, at_ms: f64, failed: bool) -> Result<(), String> {
        let mut s = shared();
        let Some(r) = s.running.as_mut() else { return Ok(()) };
        r.t = r.t.reverse(at_ms, failed);
        let key = r.key.clone();
        s.waiting = false;
        s.release = s.held_view.take().or(s.release.take());
        s.trace("reverse", &key, at_ms);
        Ok(())
    }

    pub fn vr_portal_status(&self) -> PortalStatus {
        status(now_ms())
    }

    pub fn vr_keyframe_start(&self, on: bool) {
        shared().keyframe_start = on;
    }

    pub fn vr_dev_eye(&self, offset: Option<[f64; 3]>) {
        shared().eye = offset;
    }

    pub fn vr_dev_debug(&self, on: bool) {
        shared().debug = on;
    }

    pub fn vr_dev_hold(&self, on: bool) {
        let mut s = shared();
        s.hold = on;
        if let Some(r) = s.running.as_mut() {
            r.t.held = on;
        }
    }

    pub fn vr_portal_dump(&self) -> String {
        dump(&shared(), now_ms())
    }

    pub fn vr_mirror(&self, prefix: String) -> Result<(), String> {
        if self.vr_status().is_none() {
            return Err("not in a headset".into());
        }
        shared().mirror = Some(prefix);
        Ok(())
    }

    pub fn vr_trace(&self, phase: &str, key: &str, at_ms: Option<f64>) {
        shared().trace(phase, key, at_ms.unwrap_or_else(now_ms));
    }
}

fn status_at(s: &Shared, now: f64) -> PortalStatus {
    let library = s.placed.as_ref().is_some_and(|p| p.scene.shown.at(now) * p.scene.fade.at(now) > 0.0);
    let Some(r) = &s.running else {
        return PortalStatus { phase: if library { "library" } else { "watching" }, key: None, elapsed_ms: 0.0, live_at_ms: None, done: false, undone: false };
    };
    let f = dive_frame(&r.t, now, 1.0);
    let forward = r.t.spec.kind.forward();
    let phase = match (forward, f.done, f.undone) {
        (true, false, false) => "dive",
        (false, false, false) => "back",
        (true, true, _) | (false, _, true) => "watching",
        _ => "library",
    };
    PortalStatus { phase, key: Some(r.key.clone()), elapsed_ms: r.t.elapsed(now), live_at_ms: r.t.live_at_ms, done: f.done, undone: f.undone }
}

fn quoted(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn num(x: f64) -> String {
    if x.is_finite() { format!("{x:.6}") } else { "null".into() }
}

fn list<T>(items: impl IntoIterator<Item = T>, f: impl Fn(T) -> String) -> String {
    format!("[{}]", items.into_iter().map(f).collect::<Vec<_>>().join(","))
}

fn rays(seat: &Recentre, item: &ItemDraw) -> Vec<(V3, V3)> {
    let to = seat.to_tracking();
    let origin = seat.origin.map(f64::from);
    let (w, h) = (item.size.w / 2.0, item.size.h / 2.0);
    [(0.0, 0.0), (-w, h), (w, h), (w, -h), (-w, -h)]
        .into_iter()
        .map(|(x, y)| {
            let p = apply(&to, portal_point(&item.pose, x, y));
            let d = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
            let n = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt().max(1e-9);
            (origin, d.map(|c| c / n))
        })
        .collect()
}

fn dump(s: &Shared, now: f64) -> String {
    let state = frame_of(s, now);
    let v3 = |v: V3| list(v, num);
    let items = list(&state.items, |i| {
        format!(
            "{{\"key\":{},\"texel\":[{},{}],\"az\":{},\"el\":{},\"d\":{},\"hr\":{},\"s\":{},\"edge\":{},\"op\":{},\"kind\":{},\"slot\":{},\"rays\":{}}}",
            quoted(&i.key),
            num(i.texel.0),
            num(i.texel.1),
            num(i.az_deg),
            num(i.el_deg),
            num(i.pose.d),
            num(i.pose.hr),
            num(i.pose.s),
            num(i.edge),
            num(i.op),
            quoted(&format!("{:?}", i.kind).to_lowercase()),
            i.slot.map_or("null".into(), |s| s.to_string()),
            list(rays(&state.seat, i), |(o, d)| format!("[{},{}]", v3(o), v3(d))),
        )
    });
    let seat = &state.seat;
    let dive = state.dive.as_ref().map_or("null".into(), |d| {
        let f = &d.frame;
        let ap = f.aperture.map_or("null".into(), |a| format!("{{\"az\":{},\"el\":{},\"hw\":{},\"hh\":{},\"rr\":{},\"feather\":{},\"rim\":{},\"rp\":{}}}", num(a.az), num(a.el), num(a.hw), num(a.hh), num(a.rr), num(a.feather), num(a.rim), num(a.rp)));
        let tile = f.tile.map_or("null".into(), |t| format!("{{\"a\":{},\"y\":{},\"r\":{},\"w\":{},\"h\":{},\"bend\":{},\"tilt\":{},\"rad\":{}}}", num(t.a), num(t.y), num(t.r), num(t.w), num(t.h), num(t.bend), num(t.tilt), num(t.rad)));
        format!(
            "{{\"kind\":{},\"key\":{},\"e\":{},\"libF\":{},\"flash\":{},\"sliding\":{},\"live\":{},\"loading\":{},\"inB\":{},\"outB\":{},\"outA\":{},\"old\":{},\"aperture\":{},\"tile\":{}}}",
            quoted(&format!("{:?}", d.kind)),
            quoted(&d.key),
            num(f.e),
            num(f.lib_f),
            num(f.flash),
            f.sliding,
            num(f.live),
            num(f.loading),
            num(f.in_b),
            num(f.out_b),
            num(f.out_a),
            num(d.old),
            ap,
            tile,
        )
    });
    let status = status_at(s, now);
    format!(
        "{{\"now\":{},\"rev\":{},\"on\":{},\"dim\":{},\"head\":{},\"seat\":[{},{},{},{},{},{}],\"items\":{},\"dive\":{},\"status\":{{\"phase\":{},\"key\":{},\"elapsedMs\":{},\"liveAtMs\":{},\"done\":{},\"undone\":{}}},\"trace\":{},\"buzzes\":{}}}",
        num(now),
        s.placed.as_ref().map_or("null".into(), |p| p.scene.rev.to_string()),
        state.on,
        num(state.dim),
        s.head.map_or("null".into(), |h| list(h.0.iter().flatten(), |v| num(*v as f64))),
        seat.origin[0],
        seat.origin[1],
        seat.origin[2],
        seat.heading,
        seat.pitch,
        seat.roll,
        items,
        dive,
        quoted(status.phase),
        status.key.as_deref().map_or("null".into(), quoted),
        num(status.elapsed_ms),
        status.live_at_ms.map_or("null".into(), num),
        status.done,
        status.undone,
        list(&s.trace, |l| quoted(l)),
        list(&s.buzzes, |l| quoted(l)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol
    }

    static SERIAL: Mutex<()> = Mutex::new(());

    fn reset() {
        let mut s = shared();
        s.placed = None;
        s.running = None;
        s.waiting = false;
        s.restarted = false;
        s.first_drawn = None;
        s.held_view = None;
        s.content = None;
        s.release = None;
        s.hold = false;
        s.keyframe_start = false;
    }

    #[test]
    fn portals_bands_round_trip_and_match_the_ideal_overlay() {
        for b in [ROWS_BAND, STRIP_BAND] {
            let l = band_layout(&b);
            let pose = bp_vr::panel(&Recentre::default(), l.distance as f32, l.drop as f32, l.pitch as f32);
            let band = PortalBand { band: Band::Rows, pose, metres: l.metres, curvature: l.curvature, width: l.width, height: l.height };
            for i in 0..9 {
                for j in 0..7 {
                    let (x, y) = (l.width as f64 * i as f64 / 8.0, l.height as f64 * j as f64 / 6.0);
                    let (az, el) = band_direction(&b, x, y);
                    let (bx, by) = band_texel(&b, az, el);
                    assert!(near(bx, x, 1e-6) && near(by, y, 1e-6), "{b:?} {x},{y} -> {bx},{by}");
                    let (raz, rel) = rest_of(&band, &Recentre::default(), x, y);
                    assert!(near(raz, az, 0.01) && near(rel, el, 0.01), "{b:?} {x},{y}: {raz},{rel} against {az},{el}");
                }
            }
        }
        assert_eq!((band_layout(&ROWS_BAND).width, band_layout(&ROWS_BAND).height), (2073, 1083));
        assert_eq!(band_layout(&STRIP_BAND).height, 249);
    }

    #[test]
    fn portals_pose_maths_round_trips_through_six_numbers() {
        let seat = Recentre { origin: [0.2, 1.1, -0.3], heading: 0.4, pitch: 0.3, roll: -0.1 };
        let back = seat_of(&[0.2, 1.1, -0.3, 0.4, 0.3, -0.1]).unwrap();
        assert_eq!(back.to_tracking(), seat.to_tracking());
        let m = seat.to_tracking();
        let flat: Vec<f64> = m.0.iter().flatten().map(|&v| v as f64).collect();
        assert_eq!(pose_of(&flat).unwrap(), m);
        let p = [0.3, -0.2, -1.4];
        let round = apply(&seat.to_content(), apply(&m, p));
        assert!(round.iter().zip(p).all(|(a, b)| near(*a, b, 1e-5)));
        assert!(seat_of(&[1.0; 5]).is_err() && pose_of(&[0.0; 11]).is_err());
    }

    #[test]
    fn portals_a_lifted_portal_hits_at_its_centre_and_edges() {
        let p = portal_pose(10.0, 2.5, 1.0, &PORTAL, 0.0);
        let o = [0.0, 0.0, 0.0];
        let centre = direction(p.az, p.el);
        let (t, x, y) = portal_hit(o, centre, &p, &PORTAL).expect("centre");
        assert!(near(t, p.d, 1e-9) && near(x, 0.0, 1e-9) && near(y, 0.0, 1e-9));
        let inside = portal_point(&p, PORTAL.w / 2.0 - 0.001, 0.0);
        let n = (inside.iter().map(|c| c * c).sum::<f64>()).sqrt();
        assert!(portal_hit(o, inside.map(|c| c / n), &p, &PORTAL).is_some());
        let outside = portal_point(&p, PORTAL.w / 2.0 + 0.001, 0.0);
        let n = (outside.iter().map(|c| c * c).sum::<f64>()).sqrt();
        assert!(portal_hit(o, outside.map(|c| c / n), &p, &PORTAL).is_none());
        let rest = portal_pose(10.0, 2.5, 0.0, &PORTAL, 0.0);
        assert!(near((p.s / p.hr) / (rest.s / rest.hr), 1.05 * 1.5 / 1.4, 1e-9));
    }

    #[test]
    fn portals_loadfile_options_add_the_keyframe_seek_only_with_a_start() {
        assert_eq!(loadfile_options(None, None, true), Vec::<String>::new());
        assert_eq!(loadfile_options(Some(0.0), None, true), Vec::<String>::new());
        assert_eq!(loadfile_options(Some(20.0005), None, false), vec!["start=20.0005"]);
        assert_eq!(loadfile_options(Some(20.0005), None, true), vec!["start=20.0005", "hr-seek=no"]);
        assert_eq!(loadfile_options(Some(3.0), Some(9.0), true), vec!["start=3", "hr-seek=no", "end=9"]);
        assert_eq!(loadfile_options(None, Some(9.0), false), vec!["end=9"]);
    }

    fn scene(items: Vec<PortalItem>) -> PortalScene {
        PortalScene {
            rev: 1,
            seat: Recentre::default(),
            bands: Vec::new(),
            items,
            scroll: vec![Keyframe::still(0.0); 3],
            shown: Keyframe::still(1.0),
            fade: Keyframe::still(1.0),
            dim: 0.32,
        }
    }

    fn item(key: &str, x: f64) -> PortalItem {
        PortalItem {
            key: key.into(),
            x,
            y: 400.0,
            size: PORTAL,
            row: 0,
            kind: ItemKind::Still,
            slot: Some(0),
            lift: Keyframe::still(0.0),
            shade: Keyframe::still(1.0),
            enter: Keyframe::still(1.0),
            dz: 0.0,
            op: 1.0,
        }
    }

    fn dive(key: &str, start: f64) -> Dive {
        Dive { kind: DiveKind::Vr, key: key.into(), start_ms: start, slide_ms: 0.0, same: false, full: 180, screen_deg: 50.0, aspect: 16.0 / 9.0 }
    }

    fn player_free_dive(d: Dive) {
        let mut s = shared();
        let spec = spec_for(s.placed.as_deref(), &d);
        s.running = Some(Running::new(&d, Transition::start(spec)));
        if let Some(at) = s.first_drawn.filter(|at| *at >= d.start_ms && !s.waiting)
            && s.waiting_dive().is_some()
        {
            s.go_live(at);
        }
    }

    #[test]
    fn portals_a_column_resting_past_half_a_turn_shows_when_scrolled_to() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        let rest = (13.0 - 1.5) * step_deg();
        let (x, y) = band_texel(&ROWS_BAND, rest, 2.5);
        let mut sc = scene(vec![PortalItem { y, ..item("top-13", x) }]);
        sc.scroll[0] = Keyframe::still(12.0 * step_deg());
        shared().placed = Some(Arc::new(place(sc)));
        let f = frame_of(&shared(), now_ms());
        let drawn = f.items.iter().find(|i| i.key == "top-13").expect("drawn");
        assert!((drawn.az_deg + step_deg() / 2.0).abs() < 0.01, "az {}", drawn.az_deg);
        assert!(drawn.op > 0.99);
    }

    #[test]
    fn portals_live_needs_the_new_files_first_frame() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        shared().placed = Some(Arc::new(place(scene(vec![item("top-1", 1000.0)]))));
        player_free_dive(dive("top-1", now_ms()));
        loading(true);
        drawn();
        assert_eq!(shared().running.as_ref().unwrap().t.live_at_ms, None);
        assert!(hold_view(VrView::default()));
        restarted(true);
        drawn();
        let live = shared().running.as_ref().unwrap().t.live_at_ms;
        assert!(live.is_some());
        let taken = take();
        assert_eq!(taken.seat, Some(Recentre::default()));
        assert_eq!(taken.view, Some(VrView::default()));
        drawn();
        assert_eq!(shared().running.as_ref().unwrap().t.live_at_ms, live);
        assert!(!hold_view(VrView::default()));
        assert_eq!(take(), Taken::default());
    }

    #[test]
    fn portals_only_the_headset_players_loads_drive_the_dive() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        shared().placed = Some(Arc::new(place(scene(vec![item("top-1", 1000.0)]))));
        shared().keyframe_start = true;
        assert!(!take_keyframe_start(false));
        player_free_dive(dive("top-1", now_ms()));
        assert!(take_keyframe_start(true));
        loading(true);
        restarted(false);
        drawn();
        assert_eq!(shared().running.as_ref().unwrap().t.live_at_ms, None);
        restarted(true);
        loading(false);
        drawn();
        assert!(shared().running.as_ref().unwrap().t.live_at_ms.is_some());
    }

    #[test]
    fn portals_only_a_flat_dive_into_another_file_draws_the_tile() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        for (kind, same, tile) in [(DiveKind::Flat, false, true), (DiveKind::Flat, true, false), (DiveKind::FlatBack, false, false)] {
            reset();
            shared().placed = Some(Arc::new(place(scene(vec![item("top-1", 1000.0)]))));
            let start = now_ms();
            player_free_dive(Dive { kind, same, ..dive("top-1", start) });
            let d = frame_of(&shared(), start + 100.0).dive.expect("running");
            assert_eq!(d.frame.tile.is_some(), tile, "{kind:?} same {same}");
            assert_eq!(d.tile_rim > 0.0, tile, "{kind:?} same {same}");
        }
    }

    #[test]
    fn portals_a_reverse_stops_waiting_and_lets_the_view_go() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        shared().placed = Some(Arc::new(place(scene(vec![item("top-1", 1000.0)]))));
        let start = now_ms();
        player_free_dive(dive("top-1", start));
        loading(true);
        assert!(hold_view(VrView::default()));
        {
            let mut s = shared();
            let r = s.running.as_mut().unwrap();
            r.t = r.t.reverse(start + 100.0, false);
            s.waiting = false;
            s.release = s.held_view.take();
        }
        assert_eq!(take().view, Some(VrView::default()));
        restarted(true);
        drawn();
        assert_eq!(shared().running.as_ref().unwrap().t.live_at_ms, None);
    }

    #[test]
    fn portals_a_first_frame_before_the_dive_still_goes_live() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        shared().placed = Some(Arc::new(place(scene(vec![item("top-1", 1000.0)]))));
        let start = now_ms() - 5.0;
        loading(true);
        restarted(true);
        drawn();
        player_free_dive(dive("top-1", start));
        assert!(shared().running.as_ref().unwrap().t.live_at_ms.is_some());
    }

    #[test]
    fn portals_the_dived_item_leaves_the_shelf_while_it_runs() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        let w = band_layout(&ROWS_BAND).width as f64;
        shared().placed = Some(Arc::new(place(scene(vec![item("top-1", w / 2.0), item("top-2", w / 2.0 + step_deg() * DEG * RADIUS * PPM)]))));
        let start = now_ms();
        let before = frame_of(&shared(), start);
        assert_eq!(before.items.len(), 2);
        assert!(near(before.dim, 0.32, 1e-9));
        player_free_dive(Dive { slide_ms: 200.0, ..dive("top-2", start) });
        let during = frame_of(&shared(), start + 50.0);
        assert_eq!(during.items.iter().filter(|i| i.key == "top-2").count(), 1);
        let sliding = during.items.iter().find(|i| i.key == "top-2").unwrap();
        assert!(sliding.flash > 0.0 && sliding.az_deg < step_deg());
        assert!(during.dive.as_ref().is_some_and(|d| d.frame.sliding && d.old > 0.0));
    }
}

#[cfg(test)]
mod fixture {
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../app/shared/portals.fixture.json");
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e} (app/shared/portals.test.ts writes it)"));
        serde_json::from_str(&text).expect("portals.fixture.json")
    }

    fn f(v: &Value) -> f64 {
        v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
    }

    fn opt(v: &Value) -> Option<f64> {
        v.as_f64()
    }

    #[track_caller]
    fn close(what: &str, a: f64, b: f64) {
        let tol = 1e-9 * b.abs().max(1.0);
        assert!((a - b).abs() <= tol || (a.is_infinite() && a == b), "{what}: {a} against the fixture's {b}");
    }

    fn keyframe(v: &Value) -> Keyframe {
        Keyframe { from: f(&v["from"]), to: f(&v["to"]), start_ms: f(&v["startMs"]), duration_ms: f(&v["durationMs"]), ease: Ease::parse(v["ease"].as_str().unwrap()).unwrap() }
    }

    fn size(v: &Value) -> PortalSize {
        match v.as_str() {
            Some("portal") => PORTAL,
            Some("return") => PortalSize { w: 0.104, h: 0.065, corner: 0.008, lift: 0.04, grow: 0.03 },
            o => panic!("size {o:?}"),
        }
    }

    fn v3(v: &Value) -> V3 {
        [f(&v[0]), f(&v[1]), f(&v[2])]
    }

    fn aperture_from(v: &Value) -> ApertureFrom {
        ApertureFrom { az: f(&v["az"]), el: f(&v["el"]), hw: f(&v["hw"]), hh: f(&v["hh"]), rr: f(&v["rr"]), rp: f(&v["rp"]) }
    }

    fn tile(v: &Value) -> Option<TilePose> {
        v.is_object().then(|| TilePose {
            a: f(&v["a"]),
            y: f(&v["y"]),
            r: f(&v["r"]),
            w: f(&v["w"]),
            h: f(&v["h"]),
            crop: f(&v["crop"]),
            bend: f(&v["bend"]),
            tilt: f(&v["tilt"]),
            rad: f(&v["rad"]),
        })
    }

    fn transition(v: &Value) -> Transition {
        let s = &v["spec"];
        let slide = &s["slideFrom"];
        let spec = DiveSpec {
            kind: DiveKind::parse(s["kind"].as_str().unwrap()).unwrap(),
            start_ms: f(&s["startMs"]),
            slide_ms: f(&s["slideMs"]),
            same: s["same"].as_bool().unwrap(),
            full: s["full"].as_u64().unwrap() as u32,
            from: aperture_from(&s["from"]),
            slide_from: slide.is_object().then(|| SlideFrom { az: f(&slide["az"]), y: f(&slide["y"]), r: f(&slide["r"]), s: f(&slide["s"]), h: f(&slide["h"]) }),
            tile: tile(&s["tile"]),
            screen: tile(&s["screen"]),
        };
        Transition {
            spec,
            reversed_at_ms: opt(&v["reversedAtMs"]),
            reversed_from_e: opt(&v["reversedFromE"]),
            live_at_ms: opt(&v["liveAtMs"]),
            failed: v["failed"].as_bool().unwrap(),
            held: v["held"].as_bool().unwrap(),
        }
    }

    #[test]
    fn portals_fixture_constants_and_keyframes() {
        let x = fixture();
        let c = &x["constants"];
        close("radius", RADIUS, f(&c["radius"]));
        close("ppm", PPM, f(&c["ppm"]));
        for (k, v) in [("w", PORTAL.w), ("h", PORTAL.h), ("corner", PORTAL.corner), ("lift", PORTAL.lift), ("grow", PORTAL.grow), ("gap", PORTAL_GAP)] {
            close(k, v, f(&c["portal"][k]));
        }
        close("diveDrop", DIVE_DROP, f(&c["diveDrop"]));
        close("slideMinDeg", SLIDE_MIN_DEG, f(&c["slideMinDeg"]));
        close("maxPortals", MAX_PORTALS as f64, f(&c["maxPortals"]));
        for (k, v) in [
            ("fade", ms::FADE),
            ("fadeNoSlide", ms::FADE_NO_SLIDE),
            ("grow", ms::GROW),
            ("live", ms::LIVE),
            ("liveAfterEnd", ms::LIVE_AFTER_END),
            ("grace", ms::GRACE),
            ("loadingFade", ms::LOADING_FADE),
            ("flat", ms::FLAT),
            ("flash", ms::FLASH),
            ("textFade", ms::TEXT_FADE),
            ("slideBase", ms::SLIDE_BASE),
            ("slidePerDeg", ms::SLIDE_PER_DEG),
            ("backLibDelay", ms::BACK_LIB_DELAY),
            ("backLib", ms::BACK_LIB),
        ] {
            close(k, v, f(&c["ms"][k]));
        }
        for (k, v) in [("rimVr", aperture::RIM_VR), ("rimFlat", aperture::RIM_FLAT), ("growPow", aperture::GROW_POW), ("corner", aperture::CORNER), ("feather", aperture::FEATHER)] {
            close(k, v, f(&c["aperture"][k]));
        }
        close("screen radius", SCREEN_RADIUS, f(&c["screen"]["radius"]));
        let d = &x["derived"];
        close("stepDeg", step_deg(), f(&d["stepDeg"]));
        close("fadeInDeg", fade_in_deg(), f(&d["fadeInDeg"]));
        close("fadeOutDeg", fade_out_deg(), f(&d["fadeOutDeg"]));
        close("diveElDeg", dive_el_deg(), f(&d["diveElDeg"]));
        for k in x["keyframes"].as_array().unwrap() {
            close("keyframe", keyframe(&k["keyframe"]).at(f(&k["nowMs"])), f(&k["value"]));
        }
        for e in x["layout"]["edgeFade"].as_array().unwrap() {
            close("edgeFade", edge_fade(f(&e["az"])), f(&e["k"]));
        }
    }

    #[test]
    fn portals_fixture_bands() {
        let x = fixture();
        for b in x["bands"].as_array().unwrap() {
            let s = &b["spec"];
            let spec = BandSpec { centre_deg: f(&s["centreDeg"]), from_deg: f(&s["fromDeg"]), to_deg: f(&s["toDeg"]), half_arc_deg: f(&s["halfArcDeg"]) };
            let l = band_layout(&spec);
            let want = &b["layout"];
            assert_eq!((l.width as f64, l.height as f64), (f(&want["width"]), f(&want["height"])));
            for (k, v) in [("metres", l.metres), ("curvature", l.curvature), ("distance", l.distance), ("drop", l.drop), ("pitch", l.pitch)] {
                close(k, v, f(&want[k]));
            }
            for t in b["texels"].as_array().unwrap() {
                let (x, y) = band_texel(&spec, f(&t["az"]), f(&t["el"]));
                close("texel x", x, f(&t["x"]));
                close("texel y", y, f(&t["y"]));
                let (az, el) = band_direction(&spec, x, y);
                assert!((az - f(&t["az"])).abs() < 1e-9 && (el - f(&t["el"])).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn portals_fixture_poses_hits_and_turns() {
        let x = fixture();
        let pose_eq = |what: &str, p: &PortalPose, w: &Value| {
            for (k, v) in [("az", p.az), ("el", p.el), ("d", p.d), ("hr", p.hr), ("s", p.s)] {
                close(&format!("{what} {k}"), v, f(&w[k]));
            }
        };
        for c in x["poses"].as_array().unwrap() {
            let p = portal_pose(f(&c["az"]), f(&c["el"]), f(&c["h"]), &size(&c["size"]), f(&c["dz"]));
            pose_eq("pose", &p, &c["pose"]);
        }
        for c in x["hits"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let s = size(&c["size"]);
            let p = portal_pose(f(&c["az"]), f(&c["el"]), f(&c["h"]), &s, 0.0);
            pose_eq(name, &p, &c["pose"]);
            match (portal_hit(v3(&c["o"]), v3(&c["v"]), &p, &s), c["hit"].is_object()) {
                (Some((t, hx, hy)), true) => {
                    close(name, t, f(&c["hit"]["t"]));
                    close(name, hx, f(&c["hit"]["x"]));
                    close(name, hy, f(&c["hit"]["y"]));
                }
                (None, false) => {}
                (got, _) => panic!("{name}: {got:?} against {}", c["hit"]),
            }
        }
        let layout = &x["layout"];
        for t in layout["turns"].as_array().unwrap() {
            let turn = world_turn(f(&t["az"]), f(&t["el"]));
            close("yaw", turn.0, f(&t["turn"]["yaw"]));
            close("pitch", turn.1, f(&t["turn"]["pitch"]));
            let (az, el) = turned_angles(v3(&t["v"]), turn);
            close("turned az", az, f(&t["angles"][0]));
            close("turned el", el, f(&t["angles"][1]));
            match (still_uv(az, el, 36f64.to_radians(), 27f64.to_radians()), t["uv"].is_array()) {
                (Some((u, v)), true) => {
                    close("u", u, f(&t["uv"][0]));
                    close("v", v, f(&t["uv"][1]));
                }
                (None, false) => {}
                (got, _) => panic!("uv {got:?} against {}", t["uv"]),
            }
        }
        let pa = layout["portalAngles"].as_array().unwrap();
        let got = [portal_angles(0.0, -0.05 * 1.4 / RADIUS, 1.4, 1.05, &PORTAL), portal_angles(20f64.to_radians(), 0.27, RADIUS, 1.0, &size(&"return".into()))];
        assert_eq!(pa.len(), got.len());
        for (g, w) in got.iter().zip(pa) {
            let want = aperture_from(w);
            for (k, a, b) in [("az", g.az, want.az), ("el", g.el, want.el), ("hw", g.hw, want.hw), ("hh", g.hh, want.hh), ("rr", g.rr, want.rr), ("rp", g.rp, want.rp)] {
                close(k, a, b);
            }
        }
    }

    #[test]
    fn portals_fixture_dives() {
        let x = fixture();
        for c in x["dives"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let t = transition(&c["t"]);
            let got = dive_frame(&t, f(&c["nowMs"]), f(&c["dim"]));
            let w = &c["frame"];
            let n = |k: &str| format!("{name}: {k}");
            for (k, v) in [("e", got.e), ("libF", got.lib_f), ("textF", got.text_f), ("flash", got.flash), ("inB", got.in_b), ("outB", got.out_b), ("outA", got.out_a), ("live", got.live), ("loading", got.loading)] {
                close(&n(k), v, f(&w[k]));
            }
            assert_eq!((got.sliding, got.done, got.undone), (w["sliding"].as_bool().unwrap(), w["done"].as_bool().unwrap(), w["undone"].as_bool().unwrap()), "{name}");
            match (got.portal, w["portal"].is_object()) {
                (Some(p), true) => {
                    for (k, v) in [("az", p.az), ("y", p.y), ("r", p.r), ("s", p.s), ("hover", p.hover), ("op", p.op)] {
                        close(&n(&format!("portal {k}")), v, f(&w["portal"][k]));
                    }
                }
                (None, false) => {}
                (p, _) => panic!("{name}: portal {p:?} against {}", w["portal"]),
            }
            match (got.aperture, w["aperture"].is_object()) {
                (Some(a), true) => {
                    for (k, v) in [("az", a.az), ("el", a.el), ("hw", a.hw), ("hh", a.hh), ("rr", a.rr), ("feather", a.feather), ("rim", a.rim), ("rp", a.rp)] {
                        close(&n(&format!("aperture {k}")), v, f(&w["aperture"][k]));
                    }
                }
                (None, false) => {}
                (a, _) => panic!("{name}: aperture {a:?} against {}", w["aperture"]),
            }
            match (got.tile, tile(&w["tile"])) {
                (Some(a), Some(b)) => {
                    for (k, v, e) in [("a", a.a, b.a), ("y", a.y, b.y), ("r", a.r, b.r), ("w", a.w, b.w), ("h", a.h, b.h), ("crop", a.crop, b.crop), ("bend", a.bend, b.bend), ("tilt", a.tilt, b.tilt), ("rad", a.rad, b.rad)] {
                        close(&n(&format!("tile {k}")), v, e);
                    }
                }
                (None, None) => {}
                (a, b) => panic!("{name}: tile {a:?} against {b:?}"),
            }
        }
    }
}
