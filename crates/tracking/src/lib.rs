mod flow;

use std::collections::VecDeque;

use flow::Pyramid;


#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Default for Region {

    fn default() -> Region {
        Region { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }
    }
}

impl Region {
    fn clamped(self) -> Region {
        let x = self.x.clamp(0.0, 1.0);
        let y = self.y.clamp(0.0, 1.0);
        Region { x, y, w: self.w.clamp(0.01, 1.0 - x), h: self.h.clamp(0.01, 1.0 - y) }
    }
}


#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrackOptions {

    pub sensitivity: f64,

    pub cut_threshold: f64,

    pub ease_ms: f64,

    pub smoothing_ms: [f64; Component::COUNT],

    pub flourishes: bool,


    pub clamp_jumps: bool,
}

impl Default for TrackOptions {
    fn default() -> TrackOptions {
        TrackOptions { sensitivity: 1.0, cut_threshold: CUT_DIFF, ease_ms: 250.0, smoothing_ms: [SMOOTHING_MS; Component::COUNT], flourishes: true, clamp_jumps: true }
    }
}


#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Component {

    Stroke,

    Sway,

    Surge,

    Roll,

    Pitch,

    Twist,
}

impl Component {
    pub const COUNT: usize = 6;
    pub const ALL: [Component; Component::COUNT] = [Component::Stroke, Component::Sway, Component::Surge, Component::Roll, Component::Pitch, Component::Twist];

    pub fn index(self) -> usize {
        self as usize
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Component::Stroke => "stroke",
            Component::Sway => "sway",
            Component::Surge => "surge",
            Component::Roll => "roll",
            Component::Pitch => "pitch",
            Component::Twist => "twist",
        }
    }
}


pub type Motion = [f64; Component::COUNT];



#[derive(Clone, Copy, Debug)]
pub struct Sample {
    pub time_ms: f64,
    pub pos: f64,
    pub motion: Motion,
}



#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Locating,
    Tracking,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Locating => "locating",
            Phase::Tracking => "tracking",
        }
    }
}


const GRID_X: usize = 16;
const GRID_Y: usize = 12;

const DRIFT_FRAMES: usize = 90;

const SPAN_FRAMES: usize = 180;

const SPAN_MIN: usize = 30;

const FIXED_SPAN: f64 = 24.0;


const MIN_SPAN: f64 = 8.0;

pub const SMOOTHING_MS: f64 = 100.0;

pub const SMOOTHING_SIDE_MS: f64 = 300.0;

const WARMUP_FRAMES: u64 = 15;


const FLOURISH_BOUNCES: [f64; 2] = [0.58, 0.40];
const FLOURISH_LEG_MS: f64 = 97.0;


const FLOURISH_FULL: f64 = 0.5;
const FLOURISH_MIN: f64 = 0.08;

const MIN_TEXTURED: f64 = 0.2;

pub const CUT_DIFF: f64 = 18.0;


const CUT_HIST: f32 = 0.2;

fn is_cut(prev: &Pyramid, curr: &Pyramid, threshold: f64) -> bool {
    flow::mean_abs_diff(prev.cut_level(), curr.cut_level()) as f64 > threshold
        && flow::histogram_distance(&flow::histogram(prev.cut_level()), &flow::histogram(curr.cut_level())) > CUT_HIST
}



pub struct CutDetector {
    prev: Pyramid,
    curr: Pyramid,
    primed: bool,
}

impl Default for CutDetector {
    fn default() -> CutDetector {
        CutDetector::new()
    }
}

impl CutDetector {
    pub fn new() -> CutDetector {
        CutDetector { prev: Pyramid::new(4), curr: Pyramid::new(4), primed: false }
    }



    pub fn push(&mut self, gray: &[u8], w: usize, h: usize) -> bool {
        std::mem::swap(&mut self.prev, &mut self.curr);
        self.curr.fill(gray, w, h);
        if !self.primed {
            self.primed = true;
            return false;
        }
        is_cut(&self.prev, &self.curr, CUT_DIFF)
    }


    pub fn reset(&mut self) {
        self.primed = false;
    }
}




const JUMP_FACTOR: f64 = 2.5;
const JUMP_FLOOR: f64 = 4.0;

const PEAK_DECAY: f64 = 0.985;

const DEFAULT_DT_MS: f64 = 33.0;

const MAX_ERROR: f32 = 30.0;

const MIN_FIT_POINTS: usize = 6;


const MAX_RESIDUAL: f64 = 4.0;

const TRACE_MS: f64 = 2000.0;

const SAMPLE_CAP: usize = 300_000;

const THIN_TAIL_MS: f64 = 60_000.0;
const THIN_STEP_MS: f64 = 100.0;



#[derive(Clone, Copy, Debug)]
struct Point {
    u: f64,
    v: f64,
    dx: f64,
    dy: f64,
    w: f64,
}





#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FlowPoint {
    pub u: f32,
    pub v: f32,
    pub dx: f32,
    pub dy: f32,
    pub err: f32,
    pub textured: f32,
}


struct Chain {
    level: f64,
    drift: VecDeque<f64>,
    drift_sum: f64,
    span: VecDeque<f64>,

    normalised: f64,
    smooth: f64,

    out: f64,

    held: Option<(f64, f64)>,

    peak: f64,
}

impl Chain {
    fn new() -> Chain {
        Chain { level: 0.0, drift: VecDeque::new(), drift_sum: 0.0, span: VecDeque::new(), normalised: 0.5, smooth: 0.5, out: 0.5, held: None, peak: 0.0 }
    }


    fn clamp_jump(&self, signal: &mut f64) -> bool {
        let limit = JUMP_FACTOR * self.peak + JUMP_FLOOR;
        if signal.abs() > limit {
            *signal = signal.signum() * limit;
            return true;
        }
        false
    }




    fn push(&mut self, signal: f64, dt_ms: f64, smoothing_ms: f64, ease_ms: f64, sorted: &mut Vec<f64>) -> f64 {
        self.peak = signal.abs().max(self.peak * PEAK_DECAY);
        self.level += signal;
        let detrended = self.detrend(self.level);
        let normalised = self.normalise(detrended, sorted);
        self.normalised = normalised;
        let alpha = if smoothing_ms > 0.0 { 1.0 - (-dt_ms / smoothing_ms).exp() } else { 1.0 };
        self.smooth += alpha * (normalised - self.smooth);
        let raw = soft_limit(self.smooth);
        self.out = match self.held {
            Some((from, elapsed)) => {
                let elapsed = elapsed + dt_ms;
                let u = if ease_ms > 0.0 { (elapsed / ease_ms).min(1.0) } else { 1.0 };
                self.held = (u < 1.0).then_some((from, elapsed));
                from + (raw - from) * u * u * (3.0 - 2.0 * u)
            }
            None => raw,
        };
        self.out
    }


    fn detrend(&mut self, level: f64) -> f64 {
        self.drift.push_back(level);
        self.drift_sum += level;
        if self.drift.len() > DRIFT_FRAMES {
            self.drift_sum -= self.drift.pop_front().unwrap();
        }
        level - self.drift_sum / self.drift.len() as f64
    }



    fn normalise(&mut self, detrended: f64, sorted: &mut Vec<f64>) -> f64 {
        self.span.push_back(detrended);
        if self.span.len() > SPAN_FRAMES {
            self.span.pop_front();
        }
        if self.span.len() >= SPAN_MIN {
            sorted.clear();
            sorted.extend(self.span.iter().copied());
            sorted.sort_unstable_by(f64::total_cmp);
            let last = sorted.len() - 1;
            let lo = sorted[(last as f64 * 0.1).round() as usize];
            let hi = sorted[(last as f64 * 0.9).round() as usize];
            return 0.5 + (detrended - (lo + hi) / 2.0) / (hi - lo).max(MIN_SPAN);
        }
        0.5 + detrended / FIXED_SPAN
    }



    fn restart(&mut self) {
        self.level = 0.0;
        self.drift.clear();
        self.drift_sum = 0.0;
        self.span.clear();
        self.normalised = 0.5;
        self.smooth = 0.5;
        self.peak = 0.0;
        self.held = Some((self.out, 0.0));
    }
}


#[derive(Default)]
struct Flourish {


    low: Option<(f64, bool)>,

    playing: Option<(f64, f64)>,
}

impl Flourish {

    fn push(&mut self, normalised: f64, dt_ms: f64) -> f64 {
        if normalised > 0.5 {
            self.low = None;
        } else {
            let (low, fired) = self.low.map_or((normalised, false), |(l, f)| (l.min(normalised), f));
            let overshoot = -low;
            if !fired && overshoot >= FLOURISH_MIN && normalised > low + 0.05 {
                self.playing = Some(((overshoot / FLOURISH_FULL).min(1.0), 0.0));
                self.low = Some((low, true));
            } else {
                self.low = Some((low, fired));
            }
        }
        let Some((strength, elapsed)) = self.playing else { return 0.0 };
        let elapsed = elapsed + dt_ms;
        let leg = (elapsed / FLOURISH_LEG_MS) as usize;
        if leg >= FLOURISH_BOUNCES.len() * 2 {
            self.playing = None;
            return 0.0;
        }
        self.playing = Some((strength, elapsed));
        let u = elapsed / FLOURISH_LEG_MS - leg as f64;
        let height = FLOURISH_BOUNCES[leg / 2] * strength;
        if leg % 2 == 0 { height * u } else { height * (1.0 - u) }
    }

    fn reset(&mut self) {
        *self = Flourish::default();
    }
}

pub struct Tracker {
    options: TrackOptions,
    region: Option<Region>,
    prev: Pyramid,
    curr: Pyramid,
    have_prev: bool,
    size: (usize, usize),

    points: Vec<(f32, f32)>,

    errors: Vec<f32>,

    field: Vec<Point>,

    grid: Vec<FlowPoint>,

    signals: Motion,

    sorted: Vec<f64>,
    frames: u64,

    since_cut: u64,
    cuts: u64,
    jumps: u64,
    drops: u64,
    last_time_ms: Option<f64>,
    textured: f64,
    chains: [Chain; Component::COUNT],
    flourish: Flourish,
    phase: Phase,
    motion: Motion,
    samples: Vec<Sample>,
}

impl Tracker {
    pub fn new(options: TrackOptions) -> Tracker {
        Tracker {
            options,
            region: None,
            prev: Pyramid::new(4),
            curr: Pyramid::new(4),
            have_prev: false,
            size: (0, 0),
            points: Vec::new(),
            errors: Vec::new(),
            field: Vec::new(),
            grid: Vec::new(),
            signals: [0.0; Component::COUNT],
            sorted: Vec::new(),
            frames: 0,
            since_cut: 0,
            cuts: 0,
            jumps: 0,
            drops: 0,
            last_time_ms: None,
            textured: 0.0,
            chains: std::array::from_fn(|_| Chain::new()),
            flourish: Flourish::default(),
            phase: Phase::Idle,
            motion: [0.5; Component::COUNT],
            samples: Vec::new(),
        }
    }


    pub fn set_region(&mut self, region: Option<Region>) {
        let region = region.map(Region::clamped);
        if self.region != region {
            self.region = region;
            self.build_points();
            self.restart();
        }
    }

    pub fn region(&self) -> Option<Region> {
        self.region
    }

    pub fn set_options(&mut self, options: TrackOptions) {
        self.options = options;
    }

    pub fn options(&self) -> TrackOptions {
        self.options
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }


    pub fn position(&self) -> f64 {
        self.motion[Component::Stroke.index()]
    }


    pub fn motion(&self) -> Motion {
        self.motion
    }




    pub fn field(&self) -> &[FlowPoint] {
        &self.grid
    }




    pub fn signals(&self) -> Motion {
        self.signals
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }


    pub fn cuts(&self) -> u64 {
        self.cuts
    }


    pub fn jumps(&self) -> u64 {
        self.jumps
    }



    pub fn drops(&self) -> u64 {
        self.drops
    }


    pub fn samples(&self) -> &[Sample] {
        &self.samples
    }



    pub fn samples_since(&self, time_ms: f64) -> &[Sample] {
        let mut i = self.samples.len();
        while i > 0 && self.samples[i - 1].time_ms >= time_ms {
            i -= 1;
        }
        &self.samples[i..]
    }


    pub fn trace(&self) -> &[Sample] {
        match self.samples.last() {
            Some(last) => self.samples_since(last.time_ms - TRACE_MS),
            None => &[],
        }
    }



    pub fn push(&mut self, gray: &[u8], width: usize, height: usize, time_ms: f64) -> Option<Sample> {
        if width < 16 || height < 16 || gray.len() < width * height {
            return None;
        }
        if self.size != (width, height) {
            self.size = (width, height);
            self.build_points();
            self.have_prev = false;
        }
        self.curr.fill(gray, width, height);
        self.frames += 1;
        let dt_ms = self.last_time_ms.map_or(DEFAULT_DT_MS, |t| (time_ms - t).clamp(1.0, 100.0));
        self.last_time_ms = Some(time_ms);

        if !self.have_prev {
            std::mem::swap(&mut self.prev, &mut self.curr);
            self.have_prev = true;
            self.phase = Phase::Locating;
            self.clear_field();
            return None;
        }



        if is_cut(&self.prev, &self.curr, self.options.cut_threshold) {
            self.cuts += 1;
            self.restart();
            std::mem::swap(&mut self.prev, &mut self.curr);
            self.phase = Phase::Locating;
            self.clear_field();
            return None;
        }

        let signal = self.frame_signal();
        self.signals = signal;
        std::mem::swap(&mut self.prev, &mut self.curr);
        self.since_cut += 1;
        self.phase = if self.since_cut < WARMUP_FRAMES || self.textured < MIN_TEXTURED { Phase::Locating } else { Phase::Tracking };

        let warm = self.since_cut >= WARMUP_FRAMES;
        let mut jumped = false;
        for (i, chain) in self.chains.iter_mut().enumerate() {
            let mut s = signal[i] * self.options.sensitivity;
            if self.options.clamp_jumps && warm {
                jumped |= chain.clamp_jump(&mut s);
            }
            self.motion[i] = chain.push(s, dt_ms, self.options.smoothing_ms[i], self.options.ease_ms, &mut self.sorted);
        }
        self.jumps += jumped as u64;
        let stroke = Component::Stroke.index();
        if self.options.flourishes && warm && self.chains[stroke].held.is_none() {
            let bounce = self.flourish.push(self.chains[stroke].normalised, dt_ms);
            self.motion[stroke] = (self.motion[stroke] + bounce).min(1.0);
        }

        let sample = Sample { time_ms, pos: self.motion[stroke], motion: self.motion };
        self.samples.push(sample);
        if self.samples.len() > SAMPLE_CAP {
            self.thin();
        }
        Some(sample)
    }



    fn frame_signal(&mut self) -> [f64; Component::COUNT] {
        let (w, h) = self.size;
        let r = self.region.unwrap_or_default();
        let (cx, cy) = ((r.x + r.w / 2.0) * w as f64, (r.y + r.h / 2.0) * h as f64);
        let (hw, hh) = ((r.w * w as f64 / 2.0).max(1.0), (r.h * h as f64 / 2.0).max(1.0));
        self.field.clear();
        self.grid.clear();
        let mut textured = 0usize;
        for (i, &(px, py)) in self.points.iter().enumerate() {
            let f = flow::track(&self.prev, &self.curr, px, py);
            self.grid.push(FlowPoint { u: px, v: py, dx: f.dx, dy: f.dy, err: f.err, textured: f.textured as u8 as f32 });
            if !f.textured {
                continue;
            }
            textured += 1;
            self.errors[i] = self.errors[i] * 0.8 + f.err * 0.2;
            if self.errors[i] > MAX_ERROR {
                continue;
            }
            let magnitude = (f.dx * f.dx + f.dy * f.dy).sqrt() as f64;
            self.field.push(Point { u: (px as f64 - cx) / hw, v: (py as f64 - cy) / hh, dx: f.dx as f64, dy: f.dy as f64, w: magnitude + 0.01 });
        }
        self.textured = if self.points.is_empty() { 0.0 } else { textured as f64 / self.points.len() as f64 };
        let mut out = [0.0; Component::COUNT];
        if self.field.len() < MIN_FIT_POINTS {
            return out;
        }

        out[Component::Stroke.index()] = -weighted_median(&mut self.field, |p| p.dy);
        out[Component::Sway.index()] = weighted_median(&mut self.field, |p| p.dx);
        let Some(a) = fit_affine(&mut self.field, &mut self.sorted) else {
            self.drops += 1;
            return out;
        };

        let s = (hw + hh) / 2.0;
        out[Component::Surge.index()] = (a.b + a.f) / 2.0 * s;
        out[Component::Roll.index()] = (a.e - a.c) / 2.0 * s;

        out[Component::Pitch.index()] = (a.b - a.f) / 2.0 * s;
        out[Component::Twist.index()] = (a.c + a.e) / 2.0 * s;
        out
    }


    fn restart(&mut self) {
        for c in &mut self.chains {
            c.restart();
        }
        self.flourish.reset();
        self.since_cut = 0;
        for e in &mut self.errors {
            *e = 0.0;
        }
    }

    fn build_points(&mut self) {
        let (w, h) = self.size;
        let r = self.region.unwrap_or_default();
        let (x0, y0) = (r.x * w as f64, r.y * h as f64);
        let (rw, rh) = (r.w * w as f64, r.h * h as f64);
        self.points.clear();
        for j in 0..GRID_Y {
            for i in 0..GRID_X {
                let x = x0 + (i as f64 + 0.5) / GRID_X as f64 * rw;
                let y = y0 + (j as f64 + 0.5) / GRID_Y as f64 * rh;
                self.points.push((x as f32, y as f32));
            }
        }
        self.errors.clear();
        self.errors.resize(self.points.len(), 0.0);
        self.clear_field();
    }


    fn clear_field(&mut self) {
        self.grid.clear();
        self.grid.extend(self.points.iter().map(|&(u, v)| FlowPoint { u, v, ..FlowPoint::default() }));
        self.signals = [0.0; Component::COUNT];
    }



    fn thin(&mut self) {
        let Some(last) = self.samples.last().copied() else { return };
        let cutoff = last.time_ms - THIN_TAIL_MS;
        let mut kept = f64::NEG_INFINITY;
        let mut out = Vec::with_capacity(self.samples.len() / 2);
        for s in &self.samples {
            if s.time_ms >= cutoff {
                out.push(*s);
            } else if s.time_ms - kept >= THIN_STEP_MS {
                out.push(*s);
                kept = s.time_ms;
            }
        }
        self.samples = out;
    }
}


fn weighted_median(field: &mut [Point], key: impl Fn(&Point) -> f64) -> f64 {
    field.sort_unstable_by(|a, b| key(a).total_cmp(&key(b)));
    let total: f64 = field.iter().map(|p| p.w).sum();
    let mut acc = 0.0;
    for p in field.iter() {
        acc += p.w;
        if acc >= total * 0.5 {
            return key(p);
        }
    }
    field.last().map_or(0.0, key)
}


#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Affine {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
}


const FIT_ROUNDS: usize = 3;






fn fit_affine(field: &mut [Point], sorted: &mut Vec<f64>) -> Option<Affine> {
    if field.len() < MIN_FIT_POINTS {
        return None;
    }
    let mut fit = solve(field.iter().map(|p| (p, p.w)))?;
    let mut median = f64::MAX;
    for _ in 0..FIT_ROUNDS {
        sorted.clear();
        sorted.extend(field.iter().map(|p| residual(&fit, p)));
        sorted.sort_unstable_by(f64::total_cmp);
        median = sorted[sorted.len() / 2];
        let scale = median * 1.4826 + 0.1;
        let next = solve(field.iter().map(|p| {
            let r = residual(&fit, p) / (3.0 * scale);
            (p, if r >= 1.0 { 0.0 } else { p.w * (1.0 - r * r) * (1.0 - r * r) })
        }));
        match next {
            Some(n) => fit = n,
            None => break,
        }
    }
    (median <= MAX_RESIDUAL).then_some(fit)
}

fn residual(fit: &Affine, p: &Point) -> f64 {
    let rx = p.dx - (fit.a + fit.b * p.u + fit.c * p.v);
    let ry = p.dy - (fit.d + fit.e * p.u + fit.f * p.v);
    (rx * rx + ry * ry).sqrt()
}


fn solve<'a>(points: impl Iterator<Item = (&'a Point, f64)>) -> Option<Affine> {
    let mut m = [[0.0f64; 3]; 3];
    let mut rx = [0.0f64; 3];
    let mut ry = [0.0f64; 3];
    for (p, w) in points {
        let row = [1.0, p.u, p.v];
        for i in 0..3 {
            for j in 0..3 {
                m[i][j] += w * row[i] * row[j];
            }
            rx[i] += w * row[i] * p.dx;
            ry[i] += w * row[i] * p.dy;
        }
    }
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-9 {
        return None;
    }
    let inv = [
        [(m[1][1] * m[2][2] - m[1][2] * m[2][1]) / det, (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / det, (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / det],
        [(m[1][2] * m[2][0] - m[1][0] * m[2][2]) / det, (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / det, (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / det],
        [(m[1][0] * m[2][1] - m[1][1] * m[2][0]) / det, (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / det, (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / det],
    ];
    let mul = |r: &[f64; 3]| [inv[0][0] * r[0] + inv[0][1] * r[1] + inv[0][2] * r[2], inv[1][0] * r[0] + inv[1][1] * r[1] + inv[1][2] * r[2], inv[2][0] * r[0] + inv[2][1] * r[1] + inv[2][2] * r[2]];
    let x = mul(&rx);
    let y = mul(&ry);
    Some(Affine { a: x[0], b: x[1], c: x[2], d: y[0], e: y[1], f: y[2] })
}



fn soft_limit(x: f64) -> f64 {
    const KNEE: f64 = 0.15;
    if x > KNEE && x < 1.0 - KNEE {
        x
    } else if x <= KNEE {
        KNEE * (1.0 + ((x - KNEE) / KNEE).tanh())
    } else {
        1.0 - KNEE + KNEE * ((x - (1.0 - KNEE)) / KNEE).tanh()
    }
}

#[cfg(test)]
mod tests {
    use super::*;



    fn frame(w: usize, h: usize, cx: f64, cy: f64, out: &mut Vec<u8>) {
        out.clear();
        out.resize(w * h, 0);
        let (rw, rh) = (200.0, 120.0);
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = (x as f64, y as f64);
                let bg = 110.0 + 40.0 * (fx * 0.21).sin() * (fy * 0.17).cos() + 25.0 * ((fx + fy) * 0.07).sin();
                let (u, v) = (fx - cx, fy - cy);

                let fg = 140.0 + 35.0 * (u * 0.31).sin() * (v * 0.29).cos() + 30.0 * (u * 0.07 + v * 0.05).sin();

                let mask = edge(rw / 2.0 - u.abs()) * edge(rh / 2.0 - v.abs());
                out[y * w + x] = (bg + (fg - bg) * mask).clamp(0.0, 255.0) as u8;
            }
        }
    }

    fn edge(d: f64) -> f64 {
        let t = (d / 4.0 + 0.5).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    }


    fn other_frame(w: usize, h: usize, out: &mut Vec<u8>) {
        out.clear();
        out.resize(w * h, 0);
        for y in 0..h {
            for x in 0..w {
                let v = 30.0 + 30.0 * ((x + y) as f64 * 0.5).sin();
                out[y * w + x] = v as u8;
            }
        }
    }


    fn correlation(a: &[f64], b: &[f64]) -> f64 {
        let n = a.len() as f64;
        let (ma, mb) = (a.iter().sum::<f64>() / n, b.iter().sum::<f64>() / n);
        let cov: f64 = a.iter().zip(b).map(|(x, y)| (x - ma) * (y - mb)).sum();
        let va: f64 = a.iter().map(|x| (x - ma) * (x - ma)).sum::<f64>().sqrt();
        let vb: f64 = b.iter().map(|y| (y - mb) * (y - mb)).sum::<f64>().sqrt();
        if va * vb == 0.0 { 0.0 } else { cov / (va * vb) }
    }

    fn swing(v: &[f64]) -> f64 {
        v.iter().cloned().fold(f64::MIN, f64::max) - v.iter().cloned().fold(f64::MAX, f64::min)
    }

    const W: usize = 384;
    const H: usize = 216;

    const PERIOD: f64 = 30.0;



    fn oscillate(vertical: bool, frames: usize) -> (Tracker, Vec<Motion>, Vec<f64>) {
        let mut t = Tracker::new(TrackOptions::default());
        let mut buf = Vec::new();
        let (mut motion, mut offset) = (Vec::new(), Vec::new());
        for i in 0..frames {
            let o = 25.0 * (i as f64 / PERIOD * std::f64::consts::TAU).sin();
            let (cx, cy) = if vertical { (W as f64 / 2.0, H as f64 / 2.0 + o) } else { (W as f64 / 2.0 + o, H as f64 / 2.0) };
            frame(W, H, cx, cy, &mut buf);
            if let Some(s) = t.push(&buf, W, H, i as f64 * 1000.0 / 30.0) {
                motion.push(s.motion);
                offset.push(o);
            }
        }
        (t, motion, offset)
    }

    fn component(motion: &[Motion], c: Component) -> Vec<f64> {
        motion.iter().map(|m| m[c.index()]).collect()
    }

    #[test]
    fn follows_the_moving_rectangle() {
        let (t, motion, down) = oscillate(true, 200);
        assert_eq!(t.phase(), Phase::Tracking);

        let pos = &component(&motion, Component::Stroke)[60..];
        let down = &down[60..];
        assert!(swing(pos) > 0.3, "position should swing with the rectangle: {}", swing(pos));

        let corr = correlation(pos, down);
        assert!(corr < -0.8, "position should follow the rectangle inverted: {corr}");
    }

    #[test]
    fn sideways_motion_is_sway_not_stroke() {
        let (_, motion, right) = oscillate(false, 200);
        let sway = &component(&motion, Component::Sway)[60..];
        let stroke = &component(&motion, Component::Stroke)[60..];
        assert!(swing(sway) > 0.3, "sway should swing: {}", swing(sway));
        assert!(correlation(sway, &right[60..]) > 0.8, "sway follows the rectangle's x");
        assert!(swing(stroke) < swing(sway) * 0.5, "stroke should stay quieter than sway: {} vs {}", swing(stroke), swing(sway));
    }

    #[test]
    fn affine_fit_recovers_a_known_transform() {
        let truth = Affine { a: 1.5, b: 0.2, c: -0.1, d: -2.0, e: 0.3, f: 0.4 };
        let mut field = Vec::new();
        for j in 0..12 {
            for i in 0..16 {
                let (u, v) = ((i as f64 + 0.5) / 8.0 - 1.0, (j as f64 + 0.5) / 6.0 - 1.0);
                let dx = truth.a + truth.b * u + truth.c * v;
                let dy = truth.d + truth.e * u + truth.f * v;
                field.push(Point { u, v, dx, dy, w: 1.0 });
            }
        }
        let close = |fit: Affine, tol: f64| {
            for (got, want) in [(fit.a, truth.a), (fit.b, truth.b), (fit.c, truth.c), (fit.d, truth.d), (fit.e, truth.e), (fit.f, truth.f)] {
                assert!((got - want).abs() < tol, "fit {got} vs {want}: {fit:?}");
            }
        };
        close(fit_affine(&mut field.clone(), &mut Vec::new()).unwrap(), 1e-6);

        for p in field.iter_mut().take(20) {
            p.dx += 30.0;
            p.dy -= 25.0;
        }
        close(fit_affine(&mut field, &mut Vec::new()).unwrap(), 0.05);
    }

    #[test]
    fn the_field_has_a_point_per_grid_position() {
        let mut t = Tracker::new(TrackOptions::default());
        let mut buf = Vec::new();
        frame(W, H, W as f64 / 2.0, H as f64 / 2.0, &mut buf);
        t.push(&buf, W, H, 0.0);

        assert_eq!(t.field().len(), GRID_X * GRID_Y);
        assert!(t.field().iter().all(|p| p.dx == 0.0 && p.dy == 0.0));
        assert_eq!(t.signals(), [0.0; Component::COUNT]);

        frame(W, H, W as f64 / 2.0, H as f64 / 2.0 + 6.0, &mut buf);
        t.push(&buf, W, H, 33.0);
        assert_eq!(t.field().len(), GRID_X * GRID_Y);
        let inside = t.field().iter().filter(|p| p.textured > 0.0 && p.dy > 3.0).count();
        assert!(inside > 20, "the moved rectangle should show in the field: {inside} points");

        assert!(t.signals()[Component::Stroke.index()] < -1.0, "stroke signal {:?}", t.signals());
    }

    #[test]
    fn a_static_video_stays_at_rest() {
        let mut t = Tracker::new(TrackOptions::default());
        let mut buf = Vec::new();
        frame(W, H, W as f64 / 2.0, H as f64 / 2.0, &mut buf);
        let mut last = [0.5; Component::COUNT];
        for i in 0..120 {
            if let Some(s) = t.push(&buf, W, H, i as f64 * 33.0) {
                last = s.motion;
            }
        }
        assert_eq!(t.phase(), Phase::Tracking);
        for v in last {
            assert!((v - 0.5).abs() < 0.05, "a still frame should rest at the middle: {last:?}");
        }
    }

    #[test]
    fn cut_detector_fires_on_a_new_scene_only() {
        let (mut a, mut b) = (Vec::new(), Vec::new());
        frame(W, H, W as f64 / 2.0, H as f64 / 2.0, &mut a);
        other_frame(W, H, &mut b);
        let mut d = CutDetector::new();
        assert!(!d.push(&a, W, H), "the first frame primes");
        assert!(!d.push(&a, W, H), "the same picture is not a cut");
        assert!(d.push(&b, W, H), "a different picture is");
        d.reset();
        assert!(!d.push(&a, W, H), "after a reset the first frame primes again");
    }

    #[test]
    fn a_scene_cut_returns_to_locating() {
        let mut t = Tracker::new(TrackOptions::default());
        let mut buf = Vec::new();
        for i in 0..60 {
            let cy = H as f64 / 2.0 + 25.0 * (i as f64 / PERIOD * std::f64::consts::TAU).sin();
            frame(W, H, W as f64 / 2.0, cy, &mut buf);
            t.push(&buf, W, H, i as f64 * 33.0);
        }
        assert_eq!(t.phase(), Phase::Tracking);
        other_frame(W, H, &mut buf);
        assert!(t.push(&buf, W, H, 60.0 * 33.0).is_none(), "the cut frame has no usable flow");
        assert_eq!(t.phase(), Phase::Locating);
    }


    #[test]
    fn a_scene_cut_eases_instead_of_stepping() {
        let mut t = Tracker::new(TrackOptions::default());
        let mut buf = Vec::new();
        let mut last = 0.5;

        for i in 0..68 {
            let cy = H as f64 / 2.0 + 25.0 * (i as f64 / PERIOD * std::f64::consts::TAU).sin();
            frame(W, H, W as f64 / 2.0, cy, &mut buf);
            if let Some(s) = t.push(&buf, W, H, i as f64 * 33.0) {
                last = s.pos;
            }
        }
        assert!((last - 0.5).abs() > 0.2, "cut at a stroke's end so there is somewhere to ease from: {last}");
        other_frame(W, H, &mut buf);
        t.push(&buf, W, H, 68.0 * 33.0);
        assert_eq!(t.cuts(), 1);
        let mut max_step = 0.0f64;
        let mut prev = last;
        for i in 69..120 {
            if let Some(s) = t.push(&buf, W, H, i as f64 * 33.0) {
                max_step = max_step.max((s.pos - prev).abs());
                prev = s.pos;
            }
        }
        assert!(max_step < 0.12, "the ease should spread the move over frames: {max_step}");
        assert!((prev - 0.5).abs() < 0.05, "a still scene rests at the middle after the ease: {prev}");
    }



    #[test]
    fn a_sudden_jump_is_clamped() {
        let run = |clamp: bool| {
            let mut t = Tracker::new(TrackOptions { clamp_jumps: clamp, ..TrackOptions::default() });
            let mut buf = Vec::new();
            let (mut before, mut after) = ([0.5; Component::COUNT], [0.5; Component::COUNT]);

            for i in 0..92 {
                let mut cy = H as f64 / 2.0 + 10.0 * (i as f64 / PERIOD * std::f64::consts::TAU).sin();
                if i >= 90 {
                    cy += 25.0;
                }
                frame(W, H, W as f64 / 2.0, cy, &mut buf);
                if let Some(s) = t.push(&buf, W, H, i as f64 * 33.0) {
                    if i == 89 {
                        before = s.motion;
                    }
                    if i == 90 {
                        after = s.motion;
                    }
                }
            }
            assert_eq!(t.cuts(), 0, "a leap is not a cut");
            (t.jumps(), std::array::from_fn::<f64, { Component::COUNT }, _>(|i| (after[i] - before[i]).abs()))
        };
        let (jumps, clamped) = run(true);
        let (_, free) = run(false);
        assert!(jumps >= 1, "the leap should count as a jump");
        let stroke = Component::Stroke.index();
        assert!(clamped[stroke] < free[stroke] * 0.7, "clamped {} vs free {}", clamped[stroke], free[stroke]);
        for c in Component::ALL.into_iter().filter(|c| !matches!(c, Component::Stroke | Component::Sway)) {
            assert!(clamped[c.index()] < 0.1, "{} stepped {} on the leap", c.as_str(), clamped[c.index()]);
        }
    }



    #[test]
    fn a_deep_stroke_bounces_at_the_bottom() {


        let mut keys: Vec<(f64, f64)> = vec![(0.0, 0.0)];
        let (mut f, mut v) = (8.0, 10.0);
        while f < 240.0 {
            keys.push((f, if f == 158.0 { 20.0 } else { v }));
            f += if f == 158.0 { 30.0 } else { 15.0 };
            v = -v;
        }
        let cy = |i: f64| {
            let k = keys.windows(2).find(|w| i >= w[0].0 && i < w[1].0).unwrap();
            let u = (i - k[0].0) / (k[1].0 - k[0].0);
            k[0].1 + (k[1].1 - k[0].1) * (1.0 - (u * std::f64::consts::PI).cos()) / 2.0
        };
        let bumps = |flourishes: bool| {
            let mut t = Tracker::new(TrackOptions { flourishes, ..TrackOptions::default() });
            let mut buf = Vec::new();
            let mut pos = Vec::new();
            for i in 0..200 {
                frame(W, H, W as f64 / 2.0, H as f64 / 2.0 + cy(i as f64), &mut buf);
                if let Some(s) = t.push(&buf, W, H, i as f64 * 33.0) {
                    pos.push((i, s.pos));
                }
            }
            let peaks = |from: usize, to: usize| {
                pos.windows(3).filter(|w| (from..to).contains(&w[1].0) && w[1].1 > w[0].1 + 0.01 && w[1].1 > w[2].1 + 0.01).count()
            };

            (peaks(129, 142), peaks(159, 173))
        };
        assert_eq!(bumps(true), (0, 2), "two bounces after the deep trough only");
        assert_eq!(bumps(false), (0, 0), "no bounces with flourishes off");
    }


    #[test]
    fn a_big_move_is_not_a_cut() {
        let mut t = Tracker::new(TrackOptions::default());
        let mut buf = Vec::new();
        for i in 0..40 {
            let cy = if i % 2 == 0 { H as f64 * 0.3 } else { H as f64 * 0.7 };
            frame(W, H, W as f64 / 2.0, cy, &mut buf);
            t.push(&buf, W, H, i as f64 * 33.0);
        }
        assert_eq!(t.cuts(), 0, "moving pixels alone must not count as a cut");
    }

    #[test]
    fn samples_are_queryable_and_thinned() {
        let (t, _, _) = oscillate(true, 100);
        assert_eq!(t.samples().len(), 99, "one sample per frame after the first");
        let since = t.samples_since(1000.0);
        assert!(since.iter().all(|s| s.time_ms >= 1000.0));
        assert!(!since.is_empty() && since.len() < 99);
        let trace = t.trace();
        assert!(trace.len() <= 61 && !trace.is_empty(), "two seconds at 30 fps: {}", trace.len());
    }


    #[test]
    fn per_frame_cost() {
        let mut t = Tracker::new(TrackOptions::default());
        let mut buf = Vec::new();
        let mut frames = Vec::new();
        for i in 0..60 {
            let cy = H as f64 / 2.0 + 25.0 * (i as f64 / PERIOD * std::f64::consts::TAU).sin();
            frame(W, H, W as f64 / 2.0, cy, &mut buf);
            frames.push(buf.clone());
        }
        for f in &frames {
            t.push(f, W, H, 0.0);
        }
        let runs = 300;
        let start = std::time::Instant::now();
        for i in 0..runs {
            t.push(&frames[i % frames.len()], W, H, i as f64 * 33.0);
        }
        let per = start.elapsed().as_secs_f64() * 1000.0 / runs as f64;
        println!("tracker: {per:.3} ms per {W}x{H} frame");
    }
}
