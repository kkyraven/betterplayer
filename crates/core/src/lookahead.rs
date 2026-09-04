//! Tracking ahead of playback for a local file, so an axis can run ahead of the picture (a
//! negative offset). A second, silent mpv decodes at full speed from a little before the
//! playhead into a small frame, the tracker runs on those frames, and the motion is kept by
//! media time for the tick to read at media time minus the offset. The live path
//! (`track.rs`) covers whatever is not tracked yet. It pauses once far enough ahead, so on
//! average it costs one extra decode at playback speed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bp_player::{Player, PlayerEvent, PlayerOptions};
use bp_tracking::{Motion, Phase, Region, Tracker};

use crate::detect::Detect;
use crate::{RegionSource, Shared, next_auto_region};

/// Frame width the tracker runs on; the height follows the picture.
pub(crate) const WIDTH: u32 = 384;
/// Footage before the target the tracker runs through so its normalisation has settled by
/// the time its output is needed.
const WARMUP_MS: f64 = 3000.0;
/// The decode pauses this far ahead of the playhead and resumes at the low mark.
const LEAD_PAUSE_MS: f64 = 60_000.0;
const LEAD_RESUME_MS: f64 = 30_000.0;
/// This far behind the playhead the run is restarted rather than left to catch up.
const BEHIND_MS: f64 = 1500.0;
/// A run is given this long to reach the playhead before it is restarted for being behind.
const HOLDOFF_MS: f64 = 5000.0;
/// A playhead this far from the run's end is a seek, which restarts at once.
const SEEK_MS: f64 = 10_000.0;
/// Runs kept, so seeking back into tracked footage needs no decode.
const RUNS_KEPT: usize = 24;
const FRAME_WAIT: Duration = Duration::from_millis(100);

/// Tracked motion by media time, in runs: one per start or seek, each ascending in time.
#[derive(Default)]
pub struct Store {
    runs: Vec<Vec<(f64, Motion)>>,
}

impl Store {
    fn begin(&mut self) {
        self.runs.retain(|r| !r.is_empty());
        if self.runs.len() >= RUNS_KEPT {
            self.runs.remove(0);
        }
        self.runs.push(Vec::new());
    }

    fn push(&mut self, time_ms: f64, motion: Motion) {
        let Some(run) = self.runs.last_mut() else { return };
        if run.last().is_some_and(|(t, _)| time_ms <= *t) {
            return;
        }
        run.push((time_ms, motion));
    }

    /// The run covering `time_ms`, newest first.
    fn run_at(&self, time_ms: f64) -> Option<&[(f64, Motion)]> {
        self.runs.iter().rev().map(Vec::as_slice).find(|r| r.first().is_some_and(|f| f.0 <= time_ms) && r.last().is_some_and(|l| time_ms <= l.0))
    }

    /// Motion at `time_ms` by linear interpolation, `None` where nothing is tracked.
    pub fn value_at(&self, time_ms: f64) -> Option<Motion> {
        let run = self.run_at(time_ms)?;
        let i = run.partition_point(|(t, _)| *t <= time_ms);
        if i == 0 {
            return Some(run[0].1);
        }
        if i >= run.len() {
            return Some(run[run.len() - 1].1);
        }
        let (a, va) = run[i - 1];
        let (b, vb) = run[i];
        let u = if b > a { (time_ms - a) / (b - a) } else { 0.0 };
        Some(std::array::from_fn(|k| va[k] + (vb[k] - va[k]) * u))
    }

    /// How far past `time_ms` the run covering it reaches.
    pub fn ahead_of(&self, time_ms: f64) -> Option<f64> {
        self.run_at(time_ms).and_then(|r| r.last()).map(|l| l.0 - time_ms)
    }

    /// The newest run's first and last sample times.
    fn newest(&self) -> Option<(f64, f64)> {
        let run = self.runs.last()?;
        Some((run.first()?.0, run.last()?.0))
    }
}

/// A running lookahead. Dropping it stops the decode; the thread lets go on its own.
pub struct Lookahead {
    pub path: String,
    store: Arc<Mutex<Store>>,
    stop: Arc<AtomicBool>,
}

impl Lookahead {
    pub fn start(shared: Arc<Shared>, path: String, hwdec: Option<String>) -> Lookahead {
        let store = Arc::new(Mutex::new(Store::default()));
        let stop = Arc::new(AtomicBool::new(false));
        {
            let (store, stop, path) = (store.clone(), stop.clone(), path.clone());
            let spawned = std::thread::Builder::new().name("bp-lookahead".into()).spawn(move || {
                if let Err(e) = run(&shared, &path, hwdec, &store, &stop) {
                    eprintln!("bp-core: lookahead: {e}");
                }
            });
            if let Err(e) = spawned {
                eprintln!("bp-core: lookahead thread: {e}");
            }
        }
        Lookahead { path, store, stop }
    }

    pub fn value_at(&self, time_ms: f64) -> Option<Motion> {
        self.store.lock().unwrap().value_at(time_ms)
    }

    pub fn ahead_of(&self, time_ms: f64) -> Option<f64> {
        self.store.lock().unwrap().ahead_of(time_ms)
    }
}

impl Drop for Lookahead {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// The last restart: when, and the playhead it aimed to have covered.
struct Restart {
    at: Instant,
    target_ms: f64,
    /// Frames from before the seek are still in flight; wait for one near the seek point.
    expect_from_ms: Option<f64>,
}

fn run(shared: &Arc<Shared>, path: &str, hwdec: Option<String>, store: &Mutex<Store>, stop: &AtomicBool) -> Result<(), String> {
    let size = Arc::new(Mutex::new((0u32, 0u32)));
    let loaded = Arc::new(AtomicBool::new(false));
    let sink: bp_player::EventSink = {
        let (size, loaded) = (size.clone(), loaded.clone());
        Arc::new(move |e| match e {
            PlayerEvent::VideoSize(w, h) => *size.lock().unwrap() = (w, h),
            PlayerEvent::FileLoaded => loaded.store(true, Ordering::Relaxed),
            _ => {}
        })
    };
    let player = Player::new(WIDTH, WIDTH * 9 / 16, silent_options(hwdec), Some(sink))?;
    player.load(path, None)?;

    let mut tracker = Tracker::new(*shared.track_options.lock().unwrap());
    // The detector's box for these frames: the live one sees a different scene this far ahead.
    let auto_box: Arc<Mutex<(Option<Region>, Option<bp_detect::Target>)>> = Arc::new(Mutex::new((None, None)));
    let detect = shared.detector_model.lock().unwrap().clone().map(|model| {
        let d = Detect::start({
            let (auto_box, shared) = (auto_box.clone(), shared.clone());
            move |found, after_cut| {
                let padding = shared.detect_options.lock().unwrap().padding;
                let mut b = auto_box.lock().unwrap();
                *b = next_auto_region(b.0, b.1, found, after_cut, padding);
            }
        });
        d.load(Some(model));
        d
    });

    let mut fitted = (0u32, 0u32);
    let mut fps = 0.0;
    let mut last_time: Option<f64> = None;
    let mut paused = true;
    let mut restart: Option<Restart> = None;
    let mut cuts_seen = 0;
    let mut last_detect_ms = f64::NEG_INFINITY;
    let mut gray = Vec::new();
    let mut rgb = Vec::new();

    while !stop.load(Ordering::Relaxed) {
        // Nothing can be asked of mpv before the file is in.
        if !loaded.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(20));
            continue;
        }
        // The output takes the picture's shape once known, so regions mean the same here as
        // on screen.
        let s = *size.lock().unwrap();
        if s != fitted && s.0 > 0 && s.1 > 0 {
            fitted = s;
            let h = ((WIDTH as f64 * s.1 as f64 / s.0 as f64 / 2.0).round() as u32 * 2).max(2);
            player.resize(WIDTH, h, None)?;
            fps = player.video_fps();
        }

        // Follow the playhead: restart when the run will not serve it, pause once far ahead.
        let pos = shared.clock.lock().unwrap().peek();
        let (covers_ahead, newest) = {
            let st = store.lock().unwrap();
            (st.run_at(pos + 1000.0).is_some(), st.newest())
        };
        let (start, end) = newest.or(restart.as_ref().map(|r| (r.target_ms, r.target_ms))).unwrap_or((f64::INFINITY, f64::NEG_INFINITY));
        let serves = covers_ahead || (start <= pos + 1000.0 && end >= pos - BEHIND_MS);
        let held = restart.as_ref().is_some_and(|r| r.at.elapsed().as_secs_f64() * 1000.0 < HOLDOFF_MS && (pos - end).abs() < SEEK_MS && pos >= r.target_ms - 1000.0);
        if !serves && !held {
            let from = (pos - WARMUP_MS).max(0.0);
            player.seek(from / 1000.0)?;
            player.play()?;
            paused = false;
            store.lock().unwrap().begin();
            tracker = Tracker::new(*shared.track_options.lock().unwrap());
            last_time = None;
            cuts_seen = 0;
            last_detect_ms = f64::NEG_INFINITY;
            restart = Some(Restart { at: Instant::now(), target_ms: pos, expect_from_ms: Some(from) });
        } else if !paused && end - pos > LEAD_PAUSE_MS {
            player.pause()?;
            paused = true;
        } else if paused && restart.is_some() && end - pos < LEAD_RESUME_MS {
            player.play()?;
            paused = false;
        }

        let Some(frame) = player.acquire_wait(FRAME_WAIT) else { continue };
        // Redraws (a resize) carry no position; only decoded frames do.
        let Some(pts) = frame.pts else { continue };
        let mut time = pts * 1000.0;
        if let Some(r) = restart.as_mut() {
            if let Some(from) = r.expect_from_ms {
                if time < from - 100.0 || time > from + 5000.0 {
                    continue;
                }
                r.expect_from_ms = None;
            }
        }
        // The position is read before each frame is drawn and can repeat when it has not
        // advanced yet; a repeat is the next frame.
        if let Some(l) = last_time {
            if time <= l {
                time = l + if fps > 0.0 { 1000.0 / fps } else { 1000.0 / 30.0 };
            }
        }
        last_time = Some(time);

        let slot = player.slot(frame.index);
        let bytes = unsafe { slot.as_slice() };
        let (w, h) = player.size();
        let (w, h) = (w as usize, h as usize);
        if bytes.len() < w * h * 4 {
            continue;
        }
        bgra_to_gray(bytes, w * h, &mut gray);

        let options = *shared.track_options.lock().unwrap();
        if options != tracker.options() {
            tracker.set_options(options);
        }
        let region = {
            let r = shared.region.lock().unwrap();
            match r.source {
                RegionSource::Auto if detect.is_some() => auto_box.lock().unwrap().0,
                RegionSource::Auto => r.auto,
                RegionSource::Centre => None,
                RegionSource::Pick(p) => Some(p),
            }
        };
        if region != tracker.region() {
            tracker.set_region(region);
        }
        let sample = tracker.push(&gray, w, h, time);
        if tracker.phase() == Phase::Tracking {
            if let Some(s) = sample {
                store.lock().unwrap().push(s.time_ms, s.motion);
            }
        }

        // The detector looks after every cut and at the live interval, in media time.
        if let Some(d) = detect.as_ref().filter(|d| d.ready()) {
            if shared.region.lock().unwrap().source == RegionSource::Auto {
                let interval = shared.detect_options.lock().unwrap().interval_ms;
                let cuts = tracker.cuts();
                let after_cut = cuts != cuts_seen;
                cuts_seen = cuts;
                if after_cut || time - last_detect_ms >= interval {
                    last_detect_ms = time;
                    bgra_to_rgb(bytes, w * h, &mut rgb);
                    d.put(&rgb, w, h, after_cut, shared.region.lock().unwrap().target);
                }
            }
        }
    }
    Ok(())
}

/// A silent, untimed decode into small BGRA frames the tracker reads: no audio, no
/// subtitles, every frame held until taken.
pub(crate) fn silent_options(hwdec: Option<String>) -> PlayerOptions {
    let mpv_options = ["aid=no", "sid=no", "untimed=yes", "framedrop=no", "hr-seek=yes", "osd-level=0", "audio-display=no"]
        .iter()
        .map(|kv| {
            let (k, v) = kv.split_once('=').unwrap();
            (k.to_string(), v.to_string())
        })
        .collect();
    PlayerOptions { hwdec, verbose: false, bgra: true, async_readback: false, stamp_frames: true, hold_frames: true, mpv_options }
}

/// Rec. 601 luma from packed BGRA, into a reused buffer.
pub(crate) fn bgra_to_gray(bgra: &[u8], n: usize, out: &mut Vec<u8>) {
    out.clear();
    out.reserve(n);
    out.extend(bgra.chunks_exact(4).take(n).map(|p| ((p[2] as u32 * 77 + p[1] as u32 * 150 + p[0] as u32 * 29) >> 8) as u8));
}

pub(crate) fn bgra_to_rgb(bgra: &[u8], n: usize, out: &mut Vec<u8>) {
    out.clear();
    out.reserve(n * 3);
    for p in bgra.chunks_exact(4).take(n) {
        out.extend_from_slice(&[p[2], p[1], p[0]]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(v: f64) -> Motion {
        [v; 6]
    }

    #[test]
    fn runs_interpolate_and_the_newest_wins() {
        let mut s = Store::default();
        s.begin();
        s.push(1000.0, m(0.0));
        s.push(2000.0, m(1.0));
        s.push(1500.0, m(0.5)); // out of order: dropped
        assert_eq!(s.value_at(1500.0), Some(m(0.5)));
        assert_eq!(s.value_at(2500.0), None);
        assert_eq!(s.ahead_of(1000.0), Some(1000.0));
        s.begin();
        s.push(1800.0, m(0.2));
        s.push(3000.0, m(0.2));
        assert_eq!(s.value_at(1900.0), Some(m(0.2)), "the newer run covers it");
        assert_eq!(s.value_at(1200.0), Some(m(0.2)), "the older run still serves earlier times");
        assert_eq!(s.newest(), Some((1800.0, 3000.0)));
    }
}
