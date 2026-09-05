use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bp_model::BoxRun;
use bp_player::{Player, PlayerEvent, PlayerOptions};
use bp_tracking::{Motion, Phase, Tracker};

use crate::detect::Detect;
use crate::motion::{Cadence, MotionFeed, box_run};
use crate::{AutoRegion, RegionSource, Shared, next_auto_region};


pub(crate) const WIDTH: u32 = 384;


const WARMUP_MS: f64 = 3000.0;

const LEAD_PAUSE_MS: f64 = 60_000.0;
const LEAD_RESUME_MS: f64 = 30_000.0;

const BEHIND_MS: f64 = 1500.0;

const HOLDOFF_MS: f64 = 5000.0;

const SEEK_MS: f64 = 10_000.0;

const RUNS_KEPT: usize = 24;
const FRAME_WAIT: Duration = Duration::from_millis(100);


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
        let Some(run) = self.runs.last_mut() else {
            return;
        };
        if run.last().is_some_and(|(t, _)| time_ms <= *t) {
            return;
        }
        run.push((time_ms, motion));
    }


    fn run_at(&self, time_ms: f64) -> Option<&[(f64, Motion)]> {
        self.runs.iter().rev().map(Vec::as_slice).find(|r| {
            r.first().is_some_and(|f| f.0 <= time_ms) && r.last().is_some_and(|l| time_ms <= l.0)
        })
    }


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


    pub fn ahead_of(&self, time_ms: f64) -> Option<f64> {
        self.run_at(time_ms)
            .and_then(|r| r.last())
            .map(|l| l.0 - time_ms)
    }


    fn newest(&self) -> Option<(f64, f64)> {
        let run = self.runs.last()?;
        Some((run.first()?.0, run.last()?.0))
    }
}


pub struct Lookahead {
    pub path: String,
    store: Arc<Mutex<Store>>,

    model_store: Arc<Mutex<Store>>,
    stop: Arc<AtomicBool>,
}

impl Lookahead {
    pub fn start(shared: Arc<Shared>, path: String, hwdec: Option<String>) -> Lookahead {
        let store = Arc::new(Mutex::new(Store::default()));
        let model_store = Arc::new(Mutex::new(Store::default()));
        let stop = Arc::new(AtomicBool::new(false));
        {
            let (store, model_store, stop, path) = (
                store.clone(),
                model_store.clone(),
                stop.clone(),
                path.clone(),
            );
            let spawned = std::thread::Builder::new()
                .name("bp-lookahead".into())
                .spawn(move || {
                    if let Err(e) = run(&shared, &path, hwdec, &store, &model_store, &stop) {
                        eprintln!("bp-core: lookahead: {e}");
                    }
                });
            if let Err(e) = spawned {
                eprintln!("bp-core: lookahead thread: {e}");
            }
        }
        Lookahead {
            path,
            store,
            model_store,
            stop,
        }
    }

    pub fn value_at(&self, time_ms: f64) -> Option<Motion> {
        self.store.lock().unwrap().value_at(time_ms)
    }


    pub fn model_value_at(&self, time_ms: f64) -> Option<Motion> {
        self.model_store.lock().unwrap().value_at(time_ms)
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


struct Restart {
    at: Instant,
    target_ms: f64,

    expect_from_ms: Option<f64>,
}

fn run(
    shared: &Arc<Shared>,
    path: &str,
    hwdec: Option<String>,
    store: &Mutex<Store>,
    model_store: &Mutex<Store>,
    stop: &AtomicBool,
) -> Result<(), String> {
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
    let player = silent_player(
        path,
        hwdec,
        shared.detector_model.lock().unwrap().is_some(),
        sink,
    )?;
    player.load(path, None)?;

    let mut tracker = Tracker::new(*shared.track_options.lock().unwrap());

    let mut feed: Option<MotionFeed> = None;

    let auto_box: Arc<Mutex<AutoRegion>> = Arc::new(Mutex::new(AutoRegion::default()));
    let latest: Arc<Mutex<Option<BoxRun>>> = Arc::new(Mutex::new(None));
    let detect = shared.detector_model.lock().unwrap().clone().map(|model| {
        let d = Detect::start({
            let (auto_box, latest, shared) = (auto_box.clone(), latest.clone(), shared.clone());
            move |v| {
                let padding = shared.detect_options.lock().unwrap().padding;
                let mut b = auto_box.lock().unwrap();
                *b = next_auto_region(*b, v.found, v.after_cut, v.time_ms, padding);
                *latest.lock().unwrap() = Some(box_run(&v));
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

        if !loaded.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(20));
            continue;
        }


        let s = *size.lock().unwrap();
        if s != fitted && s.0 > 0 && s.1 > 0 {
            fitted = s;
            let h = ((WIDTH as f64 * s.1 as f64 / s.0 as f64 / 2.0).round() as u32 * 2).max(2);
            player.resize(WIDTH, h, None)?;
            fps = player.video_fps();
        }


        let pos = shared.clock.lock().unwrap().peek();
        let (covers_ahead, newest) = {
            let st = store.lock().unwrap();
            (st.run_at(pos + 1000.0).is_some(), st.newest())
        };
        let (start, end) = newest
            .or(restart.as_ref().map(|r| (r.target_ms, r.target_ms)))
            .unwrap_or((f64::INFINITY, f64::NEG_INFINITY));
        let serves = covers_ahead || (start <= pos + 1000.0 && end >= pos - BEHIND_MS);
        let held = restart.as_ref().is_some_and(|r| {
            r.at.elapsed().as_secs_f64() * 1000.0 < HOLDOFF_MS
                && (pos - end).abs() < SEEK_MS
                && pos >= r.target_ms - 1000.0
        });
        if !serves && !held {
            let from = (pos - WARMUP_MS).max(0.0);
            player.seek(from / 1000.0)?;
            player.play()?;
            paused = false;
            store.lock().unwrap().begin();
            model_store.lock().unwrap().begin();
            tracker = Tracker::new(*shared.track_options.lock().unwrap());
            feed = None;
            last_time = None;
            cuts_seen = 0;
            last_detect_ms = f64::NEG_INFINITY;
            restart = Some(Restart {
                at: Instant::now(),
                target_ms: pos,
                expect_from_ms: Some(from),
            });
        } else if !paused && end - pos > LEAD_PAUSE_MS {
            player.pause()?;
            paused = true;
        } else if paused && restart.is_some() && end - pos < LEAD_RESUME_MS {
            player.play()?;
            paused = false;
        }

        let Some(frame) = player.acquire_wait(FRAME_WAIT) else {
            continue;
        };

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


        if let Some(l) = last_time {
            if time <= l {
                time = l + if fps > 0.0 {
                    1000.0 / fps
                } else {
                    1000.0 / 30.0
                };
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
                RegionSource::Auto if detect.is_some() => auto_box.lock().unwrap().region,
                RegionSource::Auto => r.auto.region,
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

        match shared.motion_loaded().filter(|_| shared.motion_wanted()) {
            Some(loaded) => {
                if feed.as_ref().is_none_or(|f| !f.same(&loaded)) {
                    feed = Some(MotionFeed::new(loaded, options, Cadence::LOOKAHEAD));
                }
                let f = feed.as_mut().unwrap();
                f.set_options(options);
                let pace = shared.pace();
                let energy = crate::energies(&shared.track_axes.lock().unwrap());
                let detection = *latest.lock().unwrap();
                match f.push(
                    &gray,
                    w,
                    h,
                    time,
                    &tracker,
                    sample,
                    detection.as_ref(),
                    time,
                    pace,
                ) {
                    Ok(heads) => {
                        let mut st = model_store.lock().unwrap();
                        for h in heads {
                            let motion = f.live(&h, pace, &energy);
                            st.push(h.time_ms, motion);
                        }
                        shared.note_model_run(f.run_ms);
                    }
                    Err(e) => eprintln!("bp-core: lookahead model: {e}"),
                }
            }
            None => feed = None,
        }


        if let Some(d) = detect.as_ref().filter(|d| d.ready()) {
            if shared.region.lock().unwrap().source == RegionSource::Auto {
                let interval = shared.detect_options.lock().unwrap().interval_ms;
                let cuts = tracker.cuts();
                let after_cut = cuts != cuts_seen;
                cuts_seen = cuts;
                if after_cut || time - last_detect_ms >= interval {
                    last_detect_ms = time;
                    bgra_to_rgb(bytes, w * h, &mut rgb);
                    let floor = if after_cut {
                        None
                    } else {
                        auto_box.lock().unwrap().floor(time)
                    };
                    d.put(
                        &rgb,
                        w,
                        h,
                        after_cut,
                        shared.region.lock().unwrap().target,
                        floor,
                        time,
                    );
                }
            }
        }
    }
    Ok(())
}


pub(crate) fn silent_player(
    path: &str,
    hwdec: Option<String>,
    color: bool,
    sink: bp_player::EventSink,
) -> Result<Player, String> {
    let info = bp_player::probe_video(path)?;
    let height =
        ((WIDTH as f64 * info.height as f64 / info.width as f64 / 2.0).round() as u32 * 2).max(2);

    let matrix = match info.color_matrix.as_str() {
        "auto" | "bt.601" => "bt601",
        "bt.709" => "bt709",
        "bt.2020-ncl" => "bt2020nc",
        "smpte-240m" => "smpte240m",
        "fcc" => "fcc",
        _ => "auto",
    };
    Player::new(
        WIDTH,
        height,
        silent_options(hwdec, color, matrix),
        Some(sink),
    )
}




fn silent_options(hwdec: Option<String>, color: bool, matrix: &str) -> PlayerOptions {
    let mut mpv_options: Vec<_> = [
        "aid=no",
        "sid=no",
        "untimed=yes",
        "framedrop=no",
        "hr-seek=yes",
        "osd-level=0",
        "audio-display=no",
        "dither=no",
    ]
    .iter()
    .map(|kv| {
        let (k, v) = kv.split_once('=').unwrap();
        (k.to_string(), v.to_string())
    })
    .collect();

    let hwdec = Some(match hwdec.as_deref().unwrap_or("auto-copy") {
        "videotoolbox" => "videotoolbox-copy".into(),
        "d3d11va" => "d3d11va-copy".into(),
        "vaapi" => "vaapi-copy".into(),
        "auto" | "auto-safe" => "auto-copy".into(),
        value => value.into(),
    });
    let format = if color { "rgb24" } else { "gray" };
    mpv_options.push(("vf".into(), format!("lavfi=[scale={WIDTH}:max(2\\,round(ih*{WIDTH}/iw/2)*2):flags=bicubic:in_color_matrix={matrix},format={format},setsar=1]")));
    PlayerOptions {
        hwdec,
        verbose: false,
        bgra: true,
        async_readback: false,
        stamp_frames: true,
        hold_frames: true,
        mpv_options,
    }
}


pub(crate) fn bgra_to_gray(bgra: &[u8], n: usize, out: &mut Vec<u8>) {
    out.clear();
    out.reserve(n);
    out.extend(
        bgra.chunks_exact(4)
            .take(n)
            .map(|p| ((p[2] as u32 * 77 + p[1] as u32 * 150 + p[0] as u32 * 29) >> 8) as u8),
    );
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


    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "requires ffmpeg, VideoToolbox and a GPU context"]
    fn silent_pixels_match_ffmpeg() {
        use std::process::Command;
        let custom = std::env::var_os("BP_PARITY_VIDEO");
        let file = custom
            .clone()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::env::temp_dir().join(format!("bp-decode-parity-{}.mp4", std::process::id()))
            });
        if custom.is_none() {
            let result = Command::new("ffmpeg")
                .args([
                    "-v",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=768x432:rate=30:duration=1",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                ])
                .arg(&file)
                .status()
                .unwrap();
            assert!(result.success());
        }
        for color in [false, true] {
            let format = if color { "rgb24" } else { "gray" };
            let reference = Command::new("ffmpeg")
                .args(["-v", "error", "-hwaccel", "videotoolbox", "-i"])
                .arg(&file)
                .args([
                    "-vf",
                    &format!("scale=384:216:flags=bicubic,format={format}"),
                    "-frames:v",
                    "30",
                    "-f",
                    "rawvideo",
                    "-",
                ])
                .output()
                .unwrap();
            assert!(reference.status.success());
            let loaded = Arc::new(AtomicBool::new(false));
            let flag = loaded.clone();
            let player = silent_player(
                file.to_str().unwrap(),
                None,
                color,
                Arc::new(move |event| {
                    if matches!(event, PlayerEvent::FileLoaded) {
                        flag.store(true, Ordering::Relaxed);
                    }
                }),
            )
            .unwrap();
            player.load(file.to_str().unwrap(), None).unwrap();
            let start = Instant::now();
            while !loaded.load(Ordering::Relaxed) {
                assert!(start.elapsed() < Duration::from_secs(10));
                std::thread::sleep(Duration::from_millis(10));
            }
            player.play().unwrap();
            let mut pixels = Vec::new();
            let mut frames = 0;
            let mut total_error = 0u64;
            let frame_bytes = 384 * 216 * if color { 3 } else { 1 };
            while frames < 30 {
                let frame = player
                    .acquire_wait(Duration::from_secs(2))
                    .expect("decoded frame");
                if frame.pts.is_none() {
                    continue;
                }
                let slot = player.slot(frame.index);
                let bytes = unsafe { slot.as_slice() };
                if color {
                    bgra_to_rgb(bytes, 384 * 216, &mut pixels);
                } else {
                    bgra_to_gray(bytes, 384 * 216, &mut pixels);
                }
                let want = &reference.stdout[frames * frame_bytes..(frames + 1) * frame_bytes];
                let error: u64 = pixels
                    .iter()
                    .zip(want)
                    .map(|(a, b)| a.abs_diff(*b) as u64)
                    .sum();

                total_error += error;
                frames += 1;
            }

            assert_eq!(
                total_error, 0,
                "color={color}: decoded pixels differ from FFmpeg"
            );
        }
        if custom.is_some() {
            return;
        }

        for matrix in ["unknown", "bt709"] {
            let result = Command::new("ffmpeg")
                .args([
                    "-v",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=432x768:rate=60:duration=1",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-colorspace",
                    matrix,
                ])
                .arg(&file)
                .status()
                .unwrap();
            assert!(result.success());
            let reference = Command::new("ffmpeg")
                .args(["-v", "error", "-hwaccel", "videotoolbox", "-i"])
                .arg(&file)
                .args([
                    "-vf",
                    "scale=384:682:flags=bicubic,format=gray",
                    "-f",
                    "rawvideo",
                    "-",
                ])
                .output()
                .unwrap();
            assert!(reference.status.success());
            let engine = crate::Engine::new(384, 216, Default::default()).unwrap();
            let pass = crate::pass::Pass {
                shared: &engine.shared,
                path: file.to_str().unwrap(),
                hwdec: None,
                color: false,
                track_options: Default::default(),
                cancelled: &|| false,
            };
            let mut frames = 0;
            pass.run(&mut |_| {}, &mut |_| {}, &mut |frame| {
                assert_eq!((frame.width, frame.height), (384, 682));
                assert!((frame.time_ms - frames as f64 * 1000.0 / 30.0).abs() < 1e-6);
                let bytes = 384 * 682;
                assert!(frames < 30, "extra decoded frame");
                assert!(
                    frame.gray == &reference.stdout[frames * 2 * bytes..(frames * 2 + 1) * bytes],
                    "pixels differ at frame {frames}"
                );
                frames += 1;
                Ok(())
            })
            .unwrap();
            assert_eq!(frames, 30);
        }
        std::fs::remove_file(file).unwrap();
    }

    fn m(v: f64) -> Motion {
        [v; 6]
    }

    #[test]
    fn runs_interpolate_and_the_newest_wins() {
        let mut s = Store::default();
        s.begin();
        s.push(1000.0, m(0.0));
        s.push(2000.0, m(1.0));
        s.push(1500.0, m(0.5));
        assert_eq!(s.value_at(1500.0), Some(m(0.5)));
        assert_eq!(s.value_at(2500.0), None);
        assert_eq!(s.ahead_of(1000.0), Some(1000.0));
        s.begin();
        s.push(1800.0, m(0.2));
        s.push(3000.0, m(0.2));
        assert_eq!(s.value_at(1900.0), Some(m(0.2)), "the newer run covers it");
        assert_eq!(
            s.value_at(1200.0),
            Some(m(0.2)),
            "the older run still serves earlier times"
        );
        assert_eq!(s.newest(), Some((1800.0, 3000.0)));
    }
}
