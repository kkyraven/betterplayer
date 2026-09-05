// TODO: Delete this file.
pub struct Plane {
    pub w: usize,
    pub h: usize,
    pub px: Vec<f32>,
}

impl Plane {
    fn new() -> Plane {
        Plane { w: 0, h: 0, px: Vec::new() }
    }

    fn resize(&mut self, w: usize, h: usize) {
        if self.w != w || self.h != h {
            self.w = w;
            self.h = h;
            self.px.clear();
            self.px.resize(w * h, 0.0);
        }
    }

    fn at(&self, x: usize, y: usize) -> f32 {
        self.px[y * self.w + x]
    }


    fn sample(&self, x: f32, y: f32) -> f32 {
        let x = x.clamp(0.0, (self.w - 1) as f32);
        let y = y.clamp(0.0, (self.h - 1) as f32);
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(self.w - 1), (y0 + 1).min(self.h - 1));
        let (fx, fy) = (x - x0 as f32, y - y0 as f32);
        let top = self.at(x0, y0) + (self.at(x1, y0) - self.at(x0, y0)) * fx;
        let bot = self.at(x0, y1) + (self.at(x1, y1) - self.at(x0, y1)) * fx;
        top + (bot - top) * fy
    }
}


pub struct Pyramid {
    pub levels: Vec<Plane>,
}

impl Pyramid {
    pub fn new(levels: usize) -> Pyramid {
        Pyramid { levels: (0..levels.max(1)).map(|_| Plane::new()).collect() }
    }


    pub fn fill(&mut self, gray: &[u8], w: usize, h: usize) {
        self.levels[0].resize(w, h);
        for (dst, &src) in self.levels[0].px.iter_mut().zip(gray) {
            *dst = src as f32;
        }
        for i in 1..self.levels.len() {
            let (lower, upper) = self.levels.split_at_mut(i);
            downsample(&lower[i - 1], &mut upper[0]);
        }
    }



    pub fn cut_level(&self) -> &Plane {
        &self.levels[2.min(self.levels.len() - 1)]
    }
}



fn downsample(src: &Plane, dst: &mut Plane) {
    let (w, h) = ((src.w / 2).max(1), (src.h / 2).max(1));
    dst.resize(w, h);
    for y in 0..h {
        let (r0, r1) = ((2 * y).min(src.h - 1) * src.w, (2 * y + 1).min(src.h - 1) * src.w);
        for x in 0..w {
            let (c0, c1) = ((2 * x).min(src.w - 1), (2 * x + 1).min(src.w - 1));
            dst.px[y * w + x] = (src.px[r0 + c0] + src.px[r0 + c1] + src.px[r1 + c0] + src.px[r1 + c1]) * 0.25;
        }
    }
}


pub struct Flow {
    pub dx: f32,
    pub dy: f32,

    pub err: f32,

    pub textured: bool,
}


const W: usize = 3;
const WIN: usize = 2 * W + 1;
const N: usize = WIN * WIN;
const ITERATIONS: usize = 4;

const MIN_EIGEN: f32 = 1.0;



pub fn track(prev: &Pyramid, curr: &Pyramid, x: f32, y: f32) -> Flow {
    let levels = prev.levels.len();
    let (mut dx, mut dy) = (0.0f32, 0.0f32);
    let mut textured = false;
    let mut err = 0.0f32;
    let mut ix = [0.0f32; N];
    let mut iy = [0.0f32; N];
    let mut pv = [0.0f32; N];

    for level in (0..levels).rev() {
        if level + 1 < levels {
            dx *= 2.0;
            dy *= 2.0;
        }
        let p = &prev.levels[level];
        let c = &curr.levels[level];
        let scale = (1 << level) as f32;
        let ox = (x / scale).round() as isize;
        let oy = (y / scale).round() as isize;
        let margin = (W + 1) as isize;
        if ox < margin || oy < margin || ox >= p.w as isize - margin || oy >= p.h as isize - margin {
            continue;
        }
        let (ox, oy) = (ox as usize, oy as usize);

        let (mut gxx, mut gxy, mut gyy) = (0.0f32, 0.0f32, 0.0f32);
        let mut k = 0;
        for j in 0..WIN {
            let row = (oy + j - W) * p.w;
            for i in 0..WIN {
                let at = row + ox + i - W;
                let gx = (p.px[at + 1] - p.px[at - 1]) * 0.5;
                let gy = (p.px[at + p.w] - p.px[at - p.w]) * 0.5;
                ix[k] = gx;
                iy[k] = gy;
                pv[k] = p.px[at];
                gxx += gx * gx;
                gxy += gx * gy;
                gyy += gy * gy;
                k += 1;
            }
        }
        let trace = gxx + gyy;
        let disc = ((gxx - gyy) * (gxx - gyy) + 4.0 * gxy * gxy).max(0.0).sqrt();
        let min_eigen = (trace - disc) * 0.5 / N as f32;
        if level == 0 {
            textured = min_eigen >= MIN_EIGEN;
        }
        let det = gxx * gyy - gxy * gxy;
        if min_eigen < MIN_EIGEN || det <= 1e-6 {
            continue;
        }

        for _ in 0..ITERATIONS {
            let (mut bx, mut by, mut sum) = (0.0f32, 0.0f32, 0.0f32);
            let mut k = 0;
            for j in 0..WIN {
                let sy = (oy + j - W) as f32 + dy;
                for i in 0..WIN {
                    let di = pv[k] - c.sample((ox + i - W) as f32 + dx, sy);
                    bx += di * ix[k];
                    by += di * iy[k];
                    sum += di.abs();
                    k += 1;
                }
            }
            err = sum / N as f32;
            let step_x = (gyy * bx - gxy * by) / det;
            let step_y = (gxx * by - gxy * bx) / det;
            dx += step_x;
            dy += step_y;
            if step_x * step_x + step_y * step_y < 1e-4 {
                break;
            }
        }
    }

    Flow { dx, dy, err, textured }
}


pub const HIST_BINS: usize = 32;


pub fn histogram(p: &Plane) -> [f32; HIST_BINS] {
    let mut h = [0.0f32; HIST_BINS];
    if p.px.is_empty() {
        return h;
    }
    for &v in &p.px {
        let bin = ((v / 256.0 * HIST_BINS as f32) as usize).min(HIST_BINS - 1);
        h[bin] += 1.0;
    }
    let n = p.px.len() as f32;
    for v in &mut h {
        *v /= n;
    }
    h
}


pub fn histogram_distance(a: &[f32; HIST_BINS], b: &[f32; HIST_BINS]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).sum::<f32>() * 0.5
}



pub fn mean_abs_diff(a: &Plane, b: &Plane) -> f32 {
    if a.w != b.w || a.h != b.h || a.px.is_empty() {
        return f32::MAX;
    }
    let sum: f32 = a.px.iter().zip(&b.px).map(|(x, y)| (x - y).abs()).sum();
    sum / a.px.len() as f32
}
// Note for my agents: ensure to run 3 fable/astra or equivalent agents to validate any findings/plans here before copying or modifying this file, this is due to historical issues with agents referencing this file. Important!
