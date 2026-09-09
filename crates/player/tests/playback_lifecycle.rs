//! Run with `cargo test -p bp-player --test playback_lifecycle -- --ignored --nocapture`.
//! Needs ffmpeg on PATH and the platform's GL driver. On Windows, also put the engine
//! directory (ANGLE DLLs) and the mpv-dev directory on PATH.

use bp_player::{External, Player, PlayerOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

struct Fixtures(PathBuf);

impl Fixtures {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("bp-playback-lifecycle-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let fixtures = Self(dir);
        let picture = fixtures.0.join("colors.ppm");
        let mut file = std::fs::File::create(&picture).unwrap();
        write!(file, "P6\n1280 720\n255\n").unwrap();
        let mut pixels = Vec::with_capacity(1280 * 720 * 3);
        for y in 0..720 {
            for x in 0..1280 {
                pixels.extend_from_slice(&color(x < 640, y < 360));
            }
        }
        file.write_all(&pixels).unwrap();
        drop(file);
        let encoders = std::process::Command::new("ffmpeg").args(["-hide_banner", "-encoders"])
            .output().expect("ffmpeg is required");
        let av1 = if String::from_utf8_lossy(&encoders.stdout).contains("libsvtav1") {
            ("libsvtav1", "av1.mp4", vec!["-preset", "10", "-svtav1-params", "lp=2"])
        } else {
            ("libaom-av1", "av1.mp4", vec!["-cpu-used", "8", "-row-mt", "1"])
        };
        for (codec, name, extra) in [
            ("libx264", "h264.mov", vec!["-preset", "ultrafast"]),
            av1,
        ] {
            let status = std::process::Command::new("ffmpeg")
                .args(["-v", "error", "-loop", "1", "-i"])
                .arg(&picture)
                .args(["-t", "1", "-r", "30", "-c:v", codec, "-threads", "2", "-pix_fmt", "yuv420p"])
                .args(["-vf", "scale=out_color_matrix=bt709", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"])
                .args(extra)
                .arg(fixtures.0.join(name))
                .output().expect("ffmpeg with H.264 and AV1 encoders is required");
            assert!(status.status.success(), "Could not encode {name}: {}", String::from_utf8_lossy(&status.stderr));
        }
        fixtures
    }
}

impl Drop for Fixtures {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

fn color(left: bool, top: bool) -> [u8; 3] {
    match (left, top) {
        (true, true) => [220, 30, 30],
        (false, true) => [30, 220, 30],
        (true, false) => [30, 30, 220],
        (false, false) => [220, 220, 220],
    }
}

struct Buffers {
    slots: [Vec<u8>; 3],
    len: usize,
}

impl Buffers {
    fn new(w: u32, h: u32) -> Self {
        let len = w as usize * h as usize * 4;
        Self { slots: std::array::from_fn(|_| vec![0xa5; len + 64]), len }
    }

    fn external(&mut self) -> External {
        std::array::from_fn(|i| (self.slots[i].as_mut_ptr() as usize, self.len))
    }

    fn check_guards(&self) {
        assert!(self.slots.iter().all(|s| s[self.len..].iter().all(|b| *b == 0xa5)), "readback overwrote a buffer guard");
    }
}

#[track_caller]
fn check_picture(player: &Player) {
    let (w, h) = player.size();
    let deadline = Instant::now() + Duration::from_secs(15);
    let frame = loop {
        if let Some(frame) = player.acquire_wait(Duration::from_millis(50)) { break frame; }
        assert!(Instant::now() < deadline, "No frame: {:?}, {:?}", player.stats(), player.take_log());
    };
    let slot = player.slot(frame.index);
    let pixels = unsafe { slot.as_slice() };
    for (x, y) in [(w / 4, h / 4), (w * 3 / 4, h / 4), (w / 4, h * 3 / 4), (w * 3 / 4, h * 3 / 4)] {
        let offset = ((y * w + x) * 4) as usize;
        let actual = &pixels[offset..offset + 4];
        let mut expected = color(x < w / 2, y < h / 2);
        if player.bgra() { expected.swap(0, 2); }
        assert!(actual[..3].iter().zip(expected).all(|(a, b)| a.abs_diff(b) < 15), "Corrupt frame at {x},{y}: {actual:?}, expected {expected:?}");
        assert_eq!(actual[3], 255);
    }
}

fn options(hwdec: Option<&str>, async_readback: bool) -> PlayerOptions {
    PlayerOptions {
        hwdec: hwdec.map(str::to_owned), async_readback,
        mpv_options: vec![("audio".into(), "no".into()), ("osd-level".into(), "0".into())],
        ..Default::default()
    }
}

#[track_caller]
fn open(player: &Player, path: &Path) {
    player.load(path.to_str().unwrap(), None).unwrap();
    player.play().unwrap();
    check_picture(player);
}

#[test]
#[ignore = "requires ffmpeg, libmpv and a working GL driver"]
fn stop_start_resize_and_overlapping_players_preserve_pixels() {
    let fixtures = Fixtures::new();
    for hwdec in [None, Some("no")] {
        for async_readback in [true, false] {
            let mut buffers = Buffers::new(320, 180);
            // Declared after the buffers so teardown also precedes their release on panic.
            let mut player = Player::new(320, 180, options(hwdec, async_readback), None).unwrap();
            player.resize(320, 180, Some(buffers.external())).unwrap();
            let other_path = fixtures.0.join("h264.mov");
            open(&player, &other_path);
            eprintln!("decoder: {}, async readback: {async_readback}", player.hwdec_current());
            // Keep consuming the first player's frames while other render contexts start
            // and stop. This exercises the process-wide GL loader during active calls.
            let other = std::thread::spawn(move || {
                for _ in 0..32 {
                    let player = Player::new(320, 180, options(hwdec, async_readback), None).unwrap();
                    open(&player, &other_path);
                    check_picture(&player);
                }
            });
            for cycle in 0..32 {
                let name = if cycle % 2 == 0 { "h264.mov" } else { "av1.mp4" };
                open(&player, &fixtures.0.join(name));
                for _ in 0..3 { check_picture(&player); }
                player.pause().unwrap();
                player.seek_exact(0.25).unwrap();
                check_picture(&player);
                let (w, h) = if cycle % 2 == 0 { (640, 360) } else { (320, 180) };
                let mut next = Buffers::new(w, h);
                player.resize(w, h, Some(next.external())).unwrap();
                let old = std::mem::replace(&mut buffers, next);
                old.check_guards();
                drop(old);
                check_picture(&player);
                // Allocation failure must preserve the old output and borrowed memory.
                let mut rejected = Buffers::new(65536, 2);
                assert!(player.resize(65536, 2, Some(rejected.external())).is_err());
                drop(rejected);
                assert_eq!(player.size(), (w, h));
                player.play().unwrap();
                check_picture(&player);
                player.set_presenting(false).unwrap();
                player.set_presenting(true).unwrap();
                check_picture(&player);
                player.stop().unwrap();
            }
            other.join().unwrap();
            player.close();
            buffers.check_guards();
            assert_eq!(player.stats().gl_errors, 0, "{:?}", player.stats());
            assert_eq!(player.stats().render_errors, 0);
        }
    }
}
