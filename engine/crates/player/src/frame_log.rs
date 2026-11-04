use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

const KEPT: usize = 4096;
const SETTLED: u32 = 3;

static ON: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Drawn {
    pub at_ms: f64,
    pub cpu_ms: f64,
    pub lock_ms: f64,
    pub upload_ms: f64,
    pub upload_kib: u32,
    pub gap_ms: f64,
    pub wait_ms: f64,
    pub submit_ms: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Shown {
    pub index: u32,
    pub at_ms: f64,
    pub presents: u32,
    pub mispresented: u32,
    pub dropped: u32,
    pub reprojection: u32,
    pub gpu_ms: f32,
    pub post_gpu_ms: f32,
    pub interval_ms: f32,
    pub ready_ms: f32,
    pub compositor_ms: f32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Totals {
    pub presents: u32,
    pub dropped: u32,
    pub reprojected: u32,
    pub timed_out: u32,
    pub submits: u32,
}

type Held = (f64, f64, f64, String);
const LONG_MS: f64 = 2.0;

#[derive(Default)]
struct Log {
    drawn: VecDeque<Drawn>,
    shown: VecDeque<Shown>,
    held: VecDeque<Held>,
    last_index: Option<u32>,
    totals: Totals,
}

static LOG: Mutex<Log> = Mutex::new(Log { drawn: VecDeque::new(), shown: VecDeque::new(), held: VecDeque::new(), last_index: None, totals: Totals { presents: 0, dropped: 0, reprojected: 0, timed_out: 0, submits: 0 } });

fn log() -> std::sync::MutexGuard<'static, Log> {
    LOG.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn on() -> bool {
    static TRACE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    ON.load(Ordering::Relaxed) || *TRACE.get_or_init(|| std::env::var_os("BP_START_TRACE").is_some())
}

pub(crate) fn drawn(d: Drawn) {
    let mut l = log();
    l.drawn.push_back(d);
    while l.drawn.len() > KEPT {
        l.drawn.pop_front();
    }
}

pub(crate) fn shown(frames: &[Shown], now_ms: f64, totals: Totals) {
    let Some(latest) = frames.iter().max_by_key(|f| f.index) else { return };
    let (newest, offset) = (latest.index, now_ms - latest.at_ms);
    let mut l = log();
    l.totals = totals;
    for f in frames {
        if f.index + SETTLED > newest || l.last_index.is_some_and(|i| f.index <= i) {
            continue;
        }
        l.last_index = Some(f.index);
        l.shown.push_back(Shown { at_ms: f.at_ms + offset, ..*f });
    }
    while l.shown.len() > KEPT {
        l.shown.pop_front();
    }
}

pub(crate) fn section(asked: std::time::Instant, taken: std::time::Instant, at: &std::panic::Location) {
    let (waited, held) = (taken.duration_since(asked).as_secs_f64() * 1000.0, taken.elapsed().as_secs_f64() * 1000.0);
    if waited < LONG_MS && held < LONG_MS {
        return;
    }
    let file = at.file().rsplit(['/', '\\']).next().unwrap_or("");
    let what = format!("{file}:{} {:?}", at.line(), std::thread::current().id());
    let mut l = log();
    l.held.push_back((crate::portals::now_ms() - held, waited, held, what));
    while l.held.len() > KEPT {
        l.held.pop_front();
    }
}

pub(crate) fn session() {
    let mut l = log();
    l.last_index = None;
    l.totals = Totals::default();
}

pub fn json(since_ms: f64) -> String {
    ON.store(true, Ordering::Relaxed);
    let l = log();
    let t = l.totals;
    let mut out = format!(
        "{{\"totals\":{{\"presents\":{},\"dropped\":{},\"reprojected\":{},\"timedOut\":{},\"submits\":{}}},\"drawn\":[",
        t.presents, t.dropped, t.reprojected, t.timed_out, t.submits
    );
    for (i, d) in l.drawn.iter().filter(|d| d.at_ms >= since_ms).enumerate() {
        let _ = write!(out, "{}[{:.1},{:.3},{:.3},{:.3},{},{:.3},{:.3},{:.3}]", if i > 0 { "," } else { "" }, d.at_ms, d.cpu_ms, d.lock_ms, d.upload_ms, d.upload_kib, d.gap_ms, d.wait_ms, d.submit_ms);
    }
    out.push_str("],\"shown\":[");
    for (i, f) in l.shown.iter().filter(|f| f.at_ms >= since_ms).enumerate() {
        let _ = write!(
            out,
            "{}[{:.1},{},{},{},{},{},{:.3},{:.3},{:.3},{:.3},{:.3}]",
            if i > 0 { "," } else { "" },
            f.at_ms,
            f.index,
            f.presents,
            f.mispresented,
            f.dropped,
            f.reprojection,
            f.gpu_ms,
            f.post_gpu_ms,
            f.interval_ms,
            f.ready_ms,
            f.compositor_ms
        );
    }
    out.push_str("],\"held\":[");
    for (i, (at, waited, held, what)) in l.held.iter().filter(|h| h.0 >= since_ms).enumerate() {
        let _ = write!(out, "{}[{at:.1},{waited:.3},{held:.3},\"{what}\"]", if i > 0 { "," } else { "" });
    }
    out.push_str("]}");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_log_keeps_each_settled_frame_once_on_the_epoch_clock() {
        session();
        let f = |index: u32, s: f64| Shown { index, at_ms: s * 1000.0, presents: 1, ..Shown::default() };
        let totals = Totals { presents: 5, ..Totals::default() };
        let frames: Vec<Shown> = (1..=5).map(|i| f(i, 9.96 + i as f64 * 0.01)).collect();
        shown(&frames, 50_000.0, totals);
        let mut frames: Vec<Shown> = (2..=6).map(|i| f(i, 9.96 + i as f64 * 0.01)).collect();
        frames.push(f(0, 1.0));
        shown(&frames, 50_010.0, totals);
        let j: serde_json::Value = serde_json::from_str(&json(0.0)).unwrap();
        let shown = j["shown"].as_array().unwrap();
        let kept: Vec<u64> = shown.iter().map(|r| r[1].as_u64().unwrap()).collect();
        assert_eq!(kept, [1, 2, 3]);
        assert!((shown[0][0].as_f64().unwrap() - 49_960.0).abs() < 0.2);
        assert_eq!(j["totals"]["presents"], 5);
        assert!(on());
    }
}
