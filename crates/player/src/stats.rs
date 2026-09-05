use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const WINDOW: usize = 600;

#[derive(Default)]
struct Inner {
    frames: u64,
    dropped: u64,
    skipped: u64,
    render_errors: u64,
    gl_errors: u64,
    last_gl_error: u32,
    render_ms: VecDeque<f32>,
    readback_ms: VecDeque<f32>,
    interval_ms: VecDeque<f32>,
    present_ms: VecDeque<f32>,
    last_frame: Option<Instant>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Percentiles {
    pub mean: f32,
    pub p50: f32,
    pub p95: f32,
    pub max: f32,
}

#[derive(Clone, Debug, Default)]
pub struct RenderSnapshot {
    pub frames: u64,
    pub dropped: u64,

    pub skipped: u64,
    pub render_errors: u64,
    pub gl_errors: u64,
    pub last_gl_error: u32,

    pub render: Percentiles,

    pub readback: Percentiles,

    pub interval: Percentiles,

    pub present: Percentiles,
}

pub struct RenderStats {
    inner: Mutex<Inner>,
}

impl RenderStats {
    pub fn new() -> RenderStats {
        RenderStats { inner: Mutex::new(Inner::default()) }
    }

    pub fn record(&self, render_ms: f32, readback_ms: f32, dropped: bool) {
        let mut s = self.inner.lock().unwrap();
        let now = Instant::now();
        if let Some(prev) = s.last_frame {
            push(&mut s.interval_ms, now.duration_since(prev).as_secs_f32() * 1000.0);
        }
        s.last_frame = Some(now);
        s.frames += 1;
        if dropped {
            s.dropped += 1;
        }
        push(&mut s.render_ms, render_ms);
        push(&mut s.readback_ms, readback_ms);
    }


    pub fn acquired(&self, since_publish: Duration) {
        push(&mut self.inner.lock().unwrap().present_ms, since_publish.as_secs_f32() * 1000.0);
    }

    pub fn render_error(&self) {
        self.inner.lock().unwrap().render_errors += 1;
    }

    pub fn skipped(&self) {
        self.inner.lock().unwrap().skipped += 1;
    }

    pub fn gl_error(&self, code: u32) {
        let mut s = self.inner.lock().unwrap();
        s.gl_errors += 1;
        s.last_gl_error = code;
    }

    pub fn snapshot(&self) -> RenderSnapshot {
        let s = self.inner.lock().unwrap();
        RenderSnapshot {
            frames: s.frames,
            dropped: s.dropped,
            skipped: s.skipped,
            render_errors: s.render_errors,
            gl_errors: s.gl_errors,
            last_gl_error: s.last_gl_error,
            render: percentiles(&s.render_ms),
            readback: percentiles(&s.readback_ms),
            interval: percentiles(&s.interval_ms),
            present: percentiles(&s.present_ms),
        }
    }
}

fn push(q: &mut VecDeque<f32>, v: f32) {
    if q.len() == WINDOW {
        q.pop_front();
    }
    q.push_back(v);
}

pub fn percentiles(q: &VecDeque<f32>) -> Percentiles {
    if q.is_empty() {
        return Percentiles::default();
    }
    let mut v: Vec<f32> = q.iter().copied().collect();
    v.sort_by(|a, b| a.total_cmp(b));
    let at = |p: f32| v[((v.len() - 1) as f32 * p).round() as usize];
    Percentiles {
        mean: v.iter().sum::<f32>() / v.len() as f32,
        p50: at(0.5),
        p95: at(0.95),
        max: v[v.len() - 1],
    }
}
