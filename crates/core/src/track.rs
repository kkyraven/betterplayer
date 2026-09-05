use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use bp_tracking::{Motion, Sample, TrackOptions, Tracker};


const STALE_MS: u64 = 500;



pub struct Mailbox {
    slot: Mutex<Slot>,
    ready: Condvar,
}

#[derive(Default)]
struct Slot {
    bytes: Vec<u8>,

    channels: usize,
    width: usize,
    height: usize,
    time_ms: f64,
    filled: bool,
    stop: bool,
}

impl Mailbox {
    pub fn new() -> Mailbox {
        Mailbox {
            slot: Mutex::new(Slot::default()),
            ready: Condvar::new(),
        }
    }

    pub fn put(&self, bytes: &[u8], channels: usize, width: usize, height: usize, time_ms: f64) {
        let mut slot = self.slot.lock().unwrap();
        if slot.stop {
            return;
        }
        slot.bytes.clear();
        slot.bytes.extend_from_slice(bytes);
        slot.channels = channels;
        slot.width = width;
        slot.height = height;
        slot.time_ms = time_ms;
        slot.filled = true;
        drop(slot);
        self.ready.notify_one();
    }

    pub fn stop(&self) {
        self.slot.lock().unwrap().stop = true;
        self.ready.notify_all();
    }


    fn take(&self, buffer: &mut Vec<u8>) -> Option<(usize, usize, usize, f64)> {
        let mut slot = self.slot.lock().unwrap();
        while !slot.filled && !slot.stop {
            slot = self.ready.wait(slot).unwrap();
        }
        if slot.stop {
            return None;
        }
        std::mem::swap(&mut slot.bytes, buffer);
        slot.filled = false;
        Some((slot.channels, slot.width, slot.height, slot.time_ms))
    }
}





pub struct Timeline {
    pub active: bool,
    points: VecDeque<(Instant, Motion)>,
}


const KEEP: Duration = Duration::from_secs(5);

impl Timeline {
    pub fn new() -> Timeline {
        Timeline {
            active: false,
            points: VecDeque::new(),
        }
    }

    pub fn clear(&mut self) {
        self.points.clear();
    }

    pub fn push_sample(&mut self, at: Instant, motion: Motion) {
        self.points.push_back((at, motion));
        while self.points.len() > 2 && at.duration_since(self.points[1].0) > KEEP {
            self.points.pop_front();
        }
    }



    pub fn value_at(&self, now: Instant, lag_ms: f64) -> Option<Motion> {
        let last = *self.points.back()?;
        if now.duration_since(last.0) > Duration::from_millis(STALE_MS) {
            return None;
        }
        let target = now.checked_sub(Duration::from_secs_f64(lag_ms.max(0.0) / 1000.0))?;
        if target >= last.0 {
            return Some(last.1);
        }
        let first = *self.points.front()?;
        if target <= first.0 {
            return Some(first.1);
        }
        for i in (1..self.points.len()).rev() {
            let (a, va) = self.points[i - 1];
            let (b, vb) = self.points[i];
            if a <= target && target < b {
                let span = b.duration_since(a).as_secs_f64();
                let u = if span > 0.0 {
                    target.duration_since(a).as_secs_f64() / span
                } else {
                    0.0
                };
                return Some(std::array::from_fn(|i| va[i] + (vb[i] - va[i]) * u));
            }
        }
        Some(last.1)
    }


    pub fn fps(&self) -> f64 {
        if self.points.len() < 2 {
            return 0.0;
        }
        let span = self
            .points
            .back()
            .unwrap()
            .0
            .duration_since(self.points.front().unwrap().0)
            .as_secs_f64();
        if span > 0.0 {
            (self.points.len() - 1) as f64 / span
        } else {
            0.0
        }
    }
}



pub struct Track {
    pub tracker: Arc<Mutex<Tracker>>,
    pub mailbox: Arc<Mailbox>,
    thread: Option<JoinHandle<()>>,
    pub active: bool,
}

impl Track {





    pub fn start(
        options: TrackOptions,
        on_sample: impl Fn(Sample) + Send + 'static,
        on_frame: impl Fn(&[u8], usize, usize, f64, u64) + Send + 'static,
        mut on_tracked: impl FnMut(&Tracker, Option<Sample>, &[u8], usize, usize, f64) + Send + 'static,
    ) -> Track {
        let tracker = Arc::new(Mutex::new(Tracker::new(options)));
        let mailbox = Arc::new(Mailbox::new());
        let thread = {
            let (tracker, mailbox) = (tracker.clone(), mailbox.clone());
            std::thread::Builder::new()
                .name("bp-track".into())
                .spawn(move || {
                    let mut buffer = Vec::new();
                    let mut gray = Vec::new();
                    while let Some((channels, w, h, time_ms)) = mailbox.take(&mut buffer) {
                        let plane: &[u8] = if channels == 3 {
                            to_gray(&buffer, w, h, &mut gray);
                            &gray
                        } else {
                            &buffer
                        };
                        let (sample, cuts) = {
                            let mut t = tracker.lock().unwrap();
                            let sample = t.push(plane, w, h, time_ms);
                            on_tracked(&t, sample, plane, w, h, time_ms);
                            (sample, t.cuts())
                        };
                        if let Some(s) = sample {
                            on_sample(s);
                        }
                        if channels == 3 {
                            on_frame(&buffer, w, h, time_ms, cuts);
                        }
                    }
                })
                .ok()
        };
        Track {
            tracker,
            mailbox,
            thread,
            active: true,
        }
    }

    pub fn stop(&mut self) {
        self.mailbox.stop();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        self.active = false;
    }
}


pub(crate) fn to_gray(rgb: &[u8], width: usize, height: usize, out: &mut Vec<u8>) {
    let n = width * height;
    out.clear();
    out.reserve(n);
    out.extend(
        rgb.chunks_exact(3)
            .take(n)
            .map(|p| ((p[0] as u32 * 77 + p[1] as u32 * 150 + p[2] as u32 * 29) >> 8) as u8),
    );
}
