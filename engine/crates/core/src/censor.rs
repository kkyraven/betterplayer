use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use bp_detect::{Detection, Detector, Kind, ModelSpec, Rect, Skin, SkinMask, Variant};
use bp_player::FrameTap;

const ENTER: f32 = 0.3;
pub(crate) const KEEP: f32 = 0.12;
const MATCH_IOU: f64 = 0.3;
const HOLD_MS: f64 = 300.0;

#[derive(Clone, Debug, PartialEq)]
pub struct CensorModels {
    pub detector: Arc<ModelSpec>,
    pub skin: Option<Vec<Variant>>,
    pub cache_dir: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub enum CensorStatus {
    #[default]
    Loading,
    Ready,
    Error(String),
}

#[derive(Clone, Debug, Default)]
pub struct CensorRun {
    pub status: CensorStatus,
    pub serial: u64,
    pub runs: u64,
    pub run_ms: f64,
    pub boxes: Vec<Rect>,
    pub mask_version: u64,
    pub mask: Option<Arc<SkinMask>>,
}

#[derive(Default)]
struct Slot {
    rgb: Vec<u8>,
    width: usize,
    height: usize,
    serial: Option<u64>,
    load: Option<CensorModels>,
    kinds: Vec<Kind>,
    stop: bool,
}

struct Inner {
    slot: Mutex<Slot>,
    ready: Condvar,
    run: Mutex<CensorRun>,
    width: AtomicUsize,
}

#[derive(Clone, Copy)]
pub(crate) struct Held {
    rect: Rect,
    seen: Instant,
}

pub struct Censor {
    inner: Arc<Inner>,
    models: CensorModels,
    thread: Option<JoinHandle<()>>,
}

impl Censor {
    pub fn start(models: CensorModels, kinds: Vec<Kind>) -> Censor {
        let inner = Arc::new(Inner {
            slot: Mutex::new(Slot { load: Some(models.clone()), kinds, ..Slot::default() }),
            ready: Condvar::new(),
            run: Mutex::new(CensorRun::default()),
            width: AtomicUsize::new(0),
        });
        let thread = {
            let inner = inner.clone();
            std::thread::Builder::new().name("bp-censor".into()).spawn(move || run(&inner)).ok()
        };
        Censor { inner, models, thread }
    }

    pub fn set_models(&mut self, models: CensorModels) {
        if models == self.models {
            return;
        }
        self.models = models.clone();
        self.inner.width.store(0, Ordering::Relaxed);
        self.inner.run.lock().unwrap().status = CensorStatus::Loading;
        self.inner.slot.lock().unwrap().load = Some(models);
        self.inner.ready.notify_one();
    }

    pub fn set_kinds(&self, kinds: Vec<Kind>) {
        self.inner.slot.lock().unwrap().kinds = kinds;
    }

    pub fn tap(&self, bgra: bool) -> FrameTap {
        let inner = self.inner.clone();
        Arc::new(move |bytes: &[u8], w: u32, h: u32, serial: u64| {
            let target = inner.width.load(Ordering::Relaxed);
            if target == 0 {
                return;
            }
            let mut slot = inner.slot.lock().unwrap();
            if slot.stop {
                return;
            }
            let (width, height) = shrink(bytes, w as usize, h as usize, target, bgra, &mut slot.rgb);
            slot.width = width;
            slot.height = height;
            slot.serial = Some(serial);
            drop(slot);
            inner.ready.notify_one();
        })
    }

    pub fn run(&self, mask_version: u64) -> CensorRun {
        let r = self.inner.run.lock().unwrap();
        CensorRun { boxes: r.boxes.clone(), mask: r.mask.as_ref().filter(|_| r.mask_version != mask_version).cloned(), status: r.status.clone(), ..*r }
    }
}

impl Drop for Censor {
    fn drop(&mut self) {
        self.inner.slot.lock().unwrap().stop = true;
        self.inner.ready.notify_all();
        self.thread.take();
    }
}

fn shrink(bytes: &[u8], w: usize, h: usize, target: usize, bgra: bool, out: &mut Vec<u8>) -> (usize, usize) {
    let tw = target.min(w).max(1);
    let th = ((h * tw) as f64 / w as f64).round().max(1.0) as usize;
    out.resize(tw * th * 3, 0);
    let (r, b) = if bgra { (2, 0) } else { (0, 2) };
    if bytes.len() < w * h * 4 {
        return (0, 0);
    }
    for y in 0..th {
        let row = (y * h / th) * w;
        for x in 0..tw {
            let i = (row + x * w / tw) * 4;
            let o = (y * tw + x) * 3;
            out[o] = bytes[i + r];
            out[o + 1] = bytes[i + 1];
            out[o + 2] = bytes[i + b];
        }
    }
    (tw, th)
}

fn iou(a: &Rect, b: &Rect) -> f64 {
    let ix = ((a.x + a.w).min(b.x + b.w) - a.x.max(b.x)).max(0.0);
    let iy = ((a.y + a.h).min(b.y + b.h) - a.y.max(b.y)).max(0.0);
    let inter = ix * iy;
    let union = a.w * a.h + b.w * b.h - inter;
    if union <= 0.0 { 0.0 } else { inter / union }
}

pub(crate) fn follow(dets: &[Detection], kinds: &[Kind], held: &mut Vec<Held>, now: Instant) -> Vec<Rect> {
    let mut next: Vec<Held> = Vec::new();
    let mut matched = vec![false; held.len()];
    for d in dets.iter().filter(|d| kinds.iter().any(|k| k.matches(d.class))) {
        let prev = held.iter().position(|h| iou(&h.rect, &d.rect) >= MATCH_IOU);
        if d.confidence >= ENTER || (d.confidence >= KEEP && prev.is_some()) {
            if let Some(i) = prev {
                matched[i] = true;
            }
            next.push(Held { rect: d.rect, seen: now });
        }
    }
    for (h, m) in held.iter().zip(matched) {
        if !m && now.duration_since(h.seen).as_secs_f64() * 1000.0 < HOLD_MS {
            next.push(*h);
        }
    }
    *held = next;
    held.iter().map(|h| h.rect).collect()
}

fn run(inner: &Inner) {
    let mut detector: Option<Detector> = None;
    let mut skin: Option<Skin> = None;
    let mut held: Vec<Held> = Vec::new();
    let mut rgb = Vec::new();
    loop {
        let (load, kinds, frame) = {
            let mut slot = inner.slot.lock().unwrap();
            while slot.serial.is_none() && slot.load.is_none() && !slot.stop {
                slot = inner.ready.wait(slot).unwrap();
            }
            if slot.stop {
                return;
            }
            let frame = slot.serial.take().map(|serial| {
                std::mem::swap(&mut rgb, &mut slot.rgb);
                (serial, slot.width, slot.height)
            });
            (slot.load.take(), slot.kinds.clone(), frame)
        };
        if let Some(m) = load {
            detector = None;
            held.clear();
            inner.width.store(0, Ordering::Relaxed);
            inner.run.lock().unwrap().status = CensorStatus::Loading;
            let loaded = Detector::load(m.detector.clone(), m.cache_dir.as_deref());
            skin = m.skin.clone().and_then(|v| Skin::load(v, m.cache_dir.as_deref(), bp_detect::skin::CENSOR_CELLS).map_err(|e| eprintln!("bp-core: censor: skin: {e}")).ok());
            let mut run = inner.run.lock().unwrap();
            match loaded {
                Ok(mut d) => {
                    d.set_threshold(KEEP);
                    let widest = |v: &[Variant]| v.iter().map(|v| v.width as usize).max().unwrap_or(0);
                    let width = widest(&m.detector.variants).max(if skin.is_some() { m.skin.as_deref().map_or(0, widest) } else { 0 });
                    detector = Some(d);
                    run.status = CensorStatus::Ready;
                    inner.width.store(width, Ordering::Relaxed);
                }
                Err(e) => run.status = CensorStatus::Error(e),
            }
            continue;
        }
        let (Some(d), Some((serial, w, h))) = (detector.as_mut(), frame) else { continue };
        if w == 0 || h == 0 {
            continue;
        }
        let by_mask = skin.is_some() && kinds.contains(&Kind::Skin);
        let box_kinds: Vec<Kind> = kinds.iter().copied().filter(|k| !(by_mask && *k == Kind::Skin)).collect();
        let t0 = Instant::now();
        let (dets, mask) = std::thread::scope(|scope| {
            let mask = by_mask.then(|| {
                let s = skin.as_mut().unwrap();
                let rgb = &rgb;
                scope.spawn(move || s.segment(rgb, w, h))
            });
            let dets = d.detect(&rgb, w, h);
            (dets, mask.map(|m| m.join().unwrap_or_else(|_| Err("skin pass panicked".into()))))
        });
        let dets = match dets {
            Ok(d) => d,
            Err(e) => {
                inner.run.lock().unwrap().status = CensorStatus::Error(e);
                continue;
            }
        };
        let boxes = follow(&dets, &box_kinds, &mut held, Instant::now());
        let mut run = inner.run.lock().unwrap();
        run.status = CensorStatus::Ready;
        run.serial = serial;
        run.runs += 1;
        run.run_ms = t0.elapsed().as_secs_f64() * 1000.0;
        run.boxes = boxes;
        match mask {
            Some(Ok(m)) => {
                run.mask = Some(Arc::new(m));
                run.mask_version += 1;
            }
            Some(Err(_)) => {}
            None if run.mask.is_some() => {
                run.mask = None;
                run.mask_version += 1;
            }
            None => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn det(class: &'static str, confidence: f32, x: f64) -> Detection {
        Detection { class, confidence, rect: Rect { x, y: 0.2, w: 0.2, h: 0.2 } }
    }

    #[test]
    fn a_box_starts_sure_holds_on_a_weak_answer_and_lingers_briefly() {
        let kinds = [Kind::Genitals];
        let mut held = Vec::new();
        let t = Instant::now();
        let ms = |n: u64| t + std::time::Duration::from_millis(n);
        assert!(follow(&[det("MALE_GENITALIA_EXPOSED", 0.2, 0.1)], &kinds, &mut held, t).is_empty(), "too weak to start");
        assert_eq!(follow(&[det("MALE_GENITALIA_EXPOSED", 0.5, 0.1)], &kinds, &mut held, ms(10)).len(), 1);
        assert_eq!(follow(&[det("MALE_GENITALIA_EXPOSED", 0.2, 0.12)], &kinds, &mut held, ms(20))[0].x, 0.12, "weak but where one was: kept, moved");
        assert_eq!(follow(&[], &kinds, &mut held, ms(200)).len(), 1, "lost: stays");
        assert!(follow(&[], &kinds, &mut held, ms(400)).is_empty(), "gone after the hold");
        assert!(follow(&[det("FACE", 0.9, 0.1)], &kinds, &mut held, ms(500)).is_empty(), "not a kind asked for");
    }

    #[test]
    fn shrink_keeps_the_aspect_and_swaps_bgra() {
        let mut out = Vec::new();
        let frame: Vec<u8> = (0..8 * 4).flat_map(|_| [1u8, 2, 3, 255]).collect();
        assert_eq!(shrink(&frame, 8, 4, 4, true, &mut out), (4, 2));
        assert_eq!(&out[..3], &[3, 2, 1]);
        assert_eq!(shrink(&frame, 8, 4, 16, false, &mut out), (8, 4), "never grows");
        assert_eq!(&out[..3], &[1, 2, 3]);
    }
}
