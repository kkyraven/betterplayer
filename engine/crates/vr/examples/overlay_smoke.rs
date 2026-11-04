use std::f64::consts::PI;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("bands") {
        let seconds: f64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(0.0);
        match bands(seconds) {
            Ok(()) => println!("overlay_smoke bands: PASS"),
            Err(e) => {
                println!("overlay_smoke bands: FAIL {e}");
                std::process::exit(1);
            }
        }
        return;
    }
    let seconds: f64 = args.first().and_then(|s| s.parse().ok()).unwrap_or(10.0);
    if let Err(e) = run(seconds) {
        eprintln!("overlay_smoke: {e}");
        std::process::exit(1);
    }
}

fn run(seconds: f64) -> Result<(), String> {
    let mut overlays = bp_vr::Overlays::new()?;
    let screen = overlays.create("betterplayer.smoke.screen", "Screen", 1920, 1080, 2.4, 0.12)?;
    let deck = overlays.create("betterplayer.smoke.deck", "Deck", 1280, 440, 0.62, 0.0)?;
    overlays.paint(screen, &pattern(1920, 1080, [40, 60, 90]), 0, 0, 1920, 1080)?;
    overlays.paint(deck, &pattern(1280, 440, [90, 50, 120]), 0, 0, 1280, 440)?;
    overlays.paint(deck, &vec![255; 1280 * 20 * 4], 0, 420, 1280, 20)?;
    overlays.place(screen, 2.2, 0.05, 0.0)?;
    overlays.place(deck, 0.55, 0.42, 38.0)?;
    overlays.recentre(false)?;
    overlays.follow(screen, true)?;
    overlays.follow(deck, true)?;
    overlays.show(screen, true)?;
    overlays.show(deck, true)?;
    let start = std::time::Instant::now();
    let mut resized = false;
    while start.elapsed().as_secs_f64() < seconds {
        if !resized && start.elapsed().as_secs_f64() >= seconds / 2.0 {
            overlays.resize(screen, 2560, 1080)?;
            overlays.resize(screen, 2560, 1080)?;
            overlays.paint(screen, &pattern(2560, 1080, [40, 90, 60]), 0, 0, 2560, 1080)?;
            resized = true;
            println!("resized the screen to 2560x1080");
        }
        for e in overlays.poll() {
            println!("{e:?}");
        }
        std::thread::sleep(std::time::Duration::from_millis(16));
    }
    overlays.close();
    println!("closed");
    Ok(())
}

fn pattern(w: usize, h: usize, [b, g, r]: [u8; 3]) -> Vec<u8> {
    let mut px = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let bgra = if x < 120 && y < 120 {
                [30, 30, 220, 255]
            } else if x % 80 < 3 || y % 80 < 3 {
                [200, 200, 200, 255]
            } else {
                [b, g, r, 255]
            };
            px.extend_from_slice(&bgra);
        }
    }
    px
}

const DEG: f64 = PI / 180.0;
const RADIUS: f64 = 1.5;
const PPM: f64 = 1200.0;
const TOLERANCE: f64 = 1.5;
const CROSS_EVERY: u32 = 100;

#[derive(Clone, Copy, Debug)]
struct BandSpec {
    name: &'static str,
    centre_deg: f64,
    from_deg: f64,
    to_deg: f64,
    half_arc_deg: f64,
}

const BANDS: [BandSpec; 2] = [
    BandSpec { name: "rows", centre_deg: -4.25, from_deg: -21.0, to_deg: 12.5, half_arc_deg: 33.0 },
    BandSpec { name: "strip", centre_deg: -25.55, from_deg: -29.5, to_deg: -21.6, half_arc_deg: 33.0 },
];

#[derive(Clone, Copy, Debug)]
struct BandLayout {
    width: u32,
    height: u32,
    metres: f64,
    curvature: f64,
    distance: f64,
    drop: f64,
    pitch: f64,
}

fn band_layout(b: &BandSpec) -> BandLayout {
    let width = (2.0 * b.half_arc_deg * DEG * RADIUS * PPM).round();
    let height = (RADIUS * (((b.to_deg - b.centre_deg) * DEG).tan() - ((b.from_deg - b.centre_deg) * DEG).tan()) * PPM).round();
    let metres = width / PPM;
    let c = b.centre_deg * DEG;
    BandLayout { width: width as u32, height: height as u32, metres, curvature: metres / (2.0 * PI * RADIUS), distance: RADIUS * c.cos(), drop: -RADIUS * c.sin(), pitch: -b.centre_deg }
}

fn direction(az: f64, el: f64) -> [f64; 3] {
    [el.cos() * az.sin(), el.sin(), -el.cos() * az.cos()]
}

fn band_direction(b: &BandSpec, x: f64, y: f64) -> [f64; 3] {
    let l = band_layout(b);
    let az = (x - l.width as f64 / 2.0) / PPM / RADIUS;
    let el = ((l.height as f64 / 2.0 - y) / PPM / RADIUS).atan();
    let v = direction(az, el);
    let (s, c) = (b.centre_deg * DEG).sin_cos();
    [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c]
}

fn band_point(l: &BandLayout, x: f64, y: f64) -> [f64; 3] {
    let ppm = l.width as f64 / l.metres;
    let along = (x - l.width as f64 / 2.0) / ppm;
    let v = (l.height as f64 / 2.0 - y) / ppm;
    let r = l.metres / (2.0 * PI * l.curvature);
    let phi = along / r;
    [r * phi.sin(), v, r * (1.0 - phi.cos())]
}

fn apply(pose: &bp_vr::Pose, p: [f64; 3], translate: bool) -> [f64; 3] {
    let m = &pose.0;
    let t = if translate { 1.0 } else { 0.0 };
    [0, 1, 2].map(|r| m[r][0] as f64 * p[0] + m[r][1] as f64 * p[1] + m[r][2] as f64 * p[2] + m[r][3] as f64 * t)
}

fn crosses(w: u32, h: u32) -> Vec<u8> {
    let mut px = vec![0u8; (w * h * 4) as usize];
    let mut put = |x: i64, y: i64| {
        if (0..w as i64).contains(&x) && (0..h as i64).contains(&y) {
            let i = ((y as u32 * w + x as u32) * 4) as usize;
            px[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
        }
    };
    for cy in (0..h).step_by(CROSS_EVERY as usize) {
        for cx in (0..w).step_by(CROSS_EVERY as usize) {
            for d in -6..=6 {
                put(cx as i64 + d, cy as i64);
                put(cx as i64, cy as i64 + d);
            }
        }
    }
    px
}

#[derive(Default)]
struct Tally {
    crosses: usize,
    over: usize,
    misses: usize,
    worst: f64,
    at: (u32, u32),
    sum: f64,
    missed: Vec<(u32, u32)>,
}

impl Tally {
    fn add(&mut self, hit: Option<(f32, f32)>, x: u32, y: u32) {
        self.crosses += 1;
        let Some((hx, hy)) = hit else {
            self.misses += 1;
            self.missed.push((x, y));
            return;
        };
        let e = (hx as f64 - x as f64 - 0.5).hypot(hy as f64 - y as f64 - 0.5);
        self.sum += e;
        if e > TOLERANCE {
            self.over += 1;
        }
        if e > self.worst {
            (self.worst, self.at) = (e, (x, y));
        }
    }

    fn line(&self, what: &str) -> String {
        format!(
            "{what}: {} crosses, {} misses, {} over {TOLERANCE} texels, mean {:.4}, worst {:.4} at {:?}; missed {:?}",
            self.crosses,
            self.misses,
            self.over,
            self.sum / (self.crosses - self.misses).max(1) as f64,
            self.worst,
            self.at,
            self.missed
        )
    }

    fn ok(&self) -> bool {
        self.misses == 0 && self.over == 0 && self.crosses > 0
    }
}

fn bands(seconds: f64) -> Result<(), String> {
    let mut overlays = bp_vr::Overlays::new()?;
    let mut made = Vec::new();
    for b in &BANDS {
        let l = band_layout(b);
        let id = overlays.create(&format!("betterplayer.smoke.band.{}", b.name), b.name, l.width, l.height, l.metres as f32, l.curvature as f32)?;
        overlays.paint(id, &crosses(l.width, l.height), 0, 0, l.width, l.height)?;
        overlays.place(id, l.distance as f32, l.drop as f32, l.pitch as f32)?;
        made.push((b, l, id));
    }
    overlays.recentre(false)?;
    for (_, _, id) in &made {
        overlays.show(*id, false)?;
    }
    let start = std::time::Instant::now();
    let seat = loop {
        overlays.poll();
        if let Some(seat) = overlays.seat() {
            break seat;
        }
        if start.elapsed().as_secs() > 10 {
            return Err("the head was never tracked (no seat after 10 s)".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(16));
    };
    for _ in 0..10 {
        overlays.poll();
        std::thread::sleep(std::time::Duration::from_millis(16));
    }
    println!("seat: {seat:?}");
    let to = seat.to_tracking();
    let origin = seat.origin;
    let mut failed = Vec::new();
    for (b, l, id) in &made {
        let pose = overlays.pose(*id)?;
        let placed = bp_vr::panel(&seat, l.distance as f32, l.drop as f32, l.pitch as f32);
        let off = (0..3).map(|r| (pose.0[r][3] - placed.0[r][3]).abs()).fold(0.0f32, f32::max);
        println!("{} band: {}x{} texels, {:.4} m, curvature {:.5}; pose {:?} ({off:.5} m from where `place` puts it)", b.name, l.width, l.height, l.metres, l.curvature, pose.0);
        let (mut ideal, mut model) = (Tally::default(), Tally::default());
        for y in (0..l.height).step_by(CROSS_EVERY as usize) {
            for x in (0..l.width).step_by(CROSS_EVERY as usize) {
                let d = apply(&to, band_direction(b, x as f64 + 0.5, y as f64 + 0.5), false).map(|c| c as f32);
                ideal.add(overlays.intersect(*id, &bp_vr::Ray { origin, direction: d })?, x, y);
                let p = apply(&pose, band_point(l, x as f64 + 0.5, y as f64 + 0.5), true);
                let v = [p[0] - origin[0] as f64, p[1] - origin[1] as f64, p[2] - origin[2] as f64];
                let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
                model.add(overlays.intersect(*id, &bp_vr::Ray { origin, direction: v.map(|c| (c / n) as f32) })?, x, y);
            }
        }
        let (cx, cy) = (l.width as f64 / 2.0, l.height as f64 / 2.0);
        let c0 = apply(&to, band_direction(b, cx, cy), false).map(|c| c as f32);
        let c1 = apply(&to, band_direction(b, cx + DEG * RADIUS * PPM, cy), false).map(|c| c as f32);
        println!(
            "  control: centre {:?}, 1 degree right {:?}",
            overlays.intersect(*id, &bp_vr::Ray { origin, direction: c0 })?,
            overlays.intersect(*id, &bp_vr::Ray { origin, direction: c1 })?
        );
        println!("  {}", ideal.line("bandDirection from the seat"));
        println!("  {}", model.line("band_point through the pose"));
        if !ideal.ok() {
            failed.push(format!("{} bandDirection (worst {:.2} texels at {:?}, {} misses)", b.name, ideal.worst, ideal.at, ideal.misses));
        }
        if !model.ok() {
            failed.push(format!("{} band_point (worst {:.2} texels at {:?}, {} misses)", b.name, model.worst, model.at, model.misses));
        }
    }
    let until = std::time::Instant::now();
    while until.elapsed().as_secs_f64() < seconds {
        overlays.poll();
        std::thread::sleep(std::time::Duration::from_millis(16));
    }
    overlays.close();
    if failed.is_empty() { Ok(()) } else { Err(failed.join("; ")) }
}

#[cfg(test)]
mod fixture {
    use super::*;

    #[test]
    fn the_band_model_matches_the_apps() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../app/shared/portals.fixture.json");
        let x: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).expect(path)).expect("fixture");
        let f = |v: &serde_json::Value| v.as_f64().unwrap();
        for b in x["bands"].as_array().unwrap() {
            let spec = BANDS.iter().find(|s| s.name == b["band"].as_str().unwrap()).unwrap();
            let s = &b["spec"];
            assert_eq!([spec.centre_deg, spec.from_deg, spec.to_deg, spec.half_arc_deg], [f(&s["centreDeg"]), f(&s["fromDeg"]), f(&s["toDeg"]), f(&s["halfArcDeg"])]);
            let l = band_layout(spec);
            let w = &b["layout"];
            assert_eq!((l.width as f64, l.height as f64), (f(&w["width"]), f(&w["height"])));
            for (got, want) in [(l.metres, &w["metres"]), (l.curvature, &w["curvature"]), (l.distance, &w["distance"]), (l.drop, &w["drop"]), (l.pitch, &w["pitch"])] {
                assert!((got - f(want)).abs() < 1e-9, "{} layout {got} against {want}", spec.name);
            }
            for t in b["texels"].as_array().unwrap() {
                let d = band_direction(spec, f(&t["x"]), f(&t["y"]));
                let (az, el) = (d[0].atan2(-d[2]) / DEG, d[1].atan2(d[0].hypot(d[2])) / DEG);
                assert!((az - f(&t["az"])).abs() < 1e-9 && (el - f(&t["el"])).abs() < 1e-9, "{} texel {t}: {az}, {el}", spec.name);
            }
            let pose = bp_vr::panel(&bp_vr::Recentre::default(), l.distance as f32, l.drop as f32, l.pitch as f32);
            for (x, y) in [(0.0, 0.0), (l.width as f64 / 2.0, l.height as f64 / 2.0), (l.width as f64, l.height as f64 * 0.3)] {
                let p = apply(&pose, band_point(&l, x, y), true);
                let d = band_direction(spec, x, y);
                let n = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
                assert!((0..3).all(|i| (p[i] / n - d[i]).abs() < 1e-5), "{} {x},{y}", spec.name);
            }
        }
    }
}
