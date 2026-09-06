#![cfg(target_os = "linux")]

use bp_player::{EnhanceOptions, Player, PlayerOptions, Upscaler};
use std::io::Write;
use std::time::{Duration, Instant};

struct Picture(std::path::PathBuf);

impl Picture {
    fn new(width: u32, height: u32) -> Self {
        let path = std::env::temp_dir().join(format!("bp-linux-test-{}-{width}.ppm", std::process::id()));
        let mut file = std::fs::File::create(&path).unwrap();
        write!(file, "P6\n{width} {height}\n255\n").unwrap();
        let mut pixels = Vec::with_capacity(width as usize * height as usize * 3);
        for y in 0..height {
            for x in 0..width {
                let rgb = match (x < width / 2, y < height / 2) {
                    (true, true) => [220, 30, 30],
                    (false, true) => [30, 220, 30],
                    (true, false) => [30, 30, 220],
                    (false, false) => [220, 220, 220],
                };
                pixels.extend_from_slice(&rgb);
            }
        }
        file.write_all(&pixels).unwrap();
        Self(path)
    }
}

impl Drop for Picture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn wait_for_frame(player: &Player, upscaler: Upscaler, width: u32, height: u32) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Some(frame) = player.acquire_wait(Duration::from_millis(50)) {
            if player.enhance_state().upscaler == upscaler && player.size() == (width, height) {
                let slot = player.slot(frame.index);
                let mut pixels = unsafe { slot.as_slice() }.to_vec();


                while let Some(newer) = player.acquire_wait(Duration::from_millis(100)) {
                    let slot = player.slot(newer.index);
                    pixels = unsafe { slot.as_slice() }.to_vec();
                    assert!(Instant::now() < deadline, "Paused redraws did not settle");
                }
                if pixels.chunks_exact(4).any(|p| p[0] > 10 || p[1] > 10 || p[2] > 10) {
                    return pixels;
                }
            }
        }
    }
    eprintln!("stats: {:?}", player.stats());
    panic!("No {upscaler:?} frame: {:?}, log: {:?}", player.enhance_state(), player.take_log());
}

fn check_colors(pixels: &[u8], width: usize, height: usize, bgra: bool, tolerance: i16) {
    for (x, y, rgb) in [
        (width / 4, height / 4, [220i16, 30, 30]),
        (width * 3 / 4, height / 4, [30, 220, 30]),
        (width / 4, height * 3 / 4, [30, 30, 220]),
        (width * 3 / 4, height * 3 / 4, [220, 220, 220]),
        (4, 4, [220, 30, 30]),
        (width - 4, height - 4, [220, 220, 220]),
        (width / 4, height - 4, [30, 30, 220]),
    ] {
        let offset = (y * width + x) * 4;
        let actual = &pixels[offset..offset + 4];
        let expected = if bgra { [rgb[2], rgb[1], rgb[0]] } else { rgb };
        for channel in 0..3 {
            assert!((i16::from(actual[channel]) - expected[channel]).abs() < tolerance, "color/orientation at {x},{y}: {actual:?}, expected {expected:?}");
        }
        assert_eq!(actual[3], 255);
    }
}


#[test]
fn linux_playback_upscaling_and_multiple_players() {
    let picture = Picture::new(320, 180);
    let video_path = picture.0.with_extension("mp4");
    let status = std::process::Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-y",
            "-loop",
            "1",
            "-i",
            picture.0.to_str().unwrap(),
            "-t",
            "3",
            "-r",
            "24",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            video_path.to_str().unwrap(),
        ])
        .status()
        .expect("ffmpeg is required for the Linux playback test");
    assert!(status.success());
    let video = Picture(video_path);
    for bgra in [true, false] {
        let opts = PlayerOptions { bgra, async_readback: bgra, verbose: true, mpv_options: vec![("osd-level".into(), "0".into())], ..Default::default() };
        let player = Player::new(640, 360, opts, None).unwrap();
        assert!(player.enhance_capabilities().gpu.is_some());
        player.load(video.0.to_str().unwrap(), Some(0.5)).unwrap();
        let first = wait_for_frame(&player, Upscaler::Off, 640, 360);
        check_colors(&first, 640, 360, bgra, 12);
        assert!(player.time_pos() >= 0.45, "resume position: {}", player.time_pos());
        player.play().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while player.time_pos() < 0.75 && Instant::now() < deadline {
            player.acquire_wait(Duration::from_millis(50));
        }
        assert!(player.time_pos() >= 0.75, "Playback clock did not advance");
        player.pause().unwrap();
        for upscaler in [Upscaler::Sharp, Upscaler::Fsr, Upscaler::Off] {
            player.set_enhance(EnhanceOptions { upscaler, ..Default::default() }).unwrap();
            player.seek_exact(1.0).unwrap();
            let enhanced = wait_for_frame(&player, upscaler, 640, 360);
            check_colors(&enhanced, 640, 360, bgra, 12);
            if upscaler != Upscaler::Off {
                let difference: u64 = first.iter().zip(&enhanced).map(|(a, b)| u64::from(a.abs_diff(*b))).sum();
                assert!(difference > 1_000, "{upscaler:?} did not change the decoded picture");
            }
            assert!(player.enhance_state().reason.is_none());
        }
        player.set_enhance(EnhanceOptions { upscaler: Upscaler::Fsr, ..Default::default() }).unwrap();
        player.resize(480, 270, None).unwrap();
        let resized = wait_for_frame(&player, Upscaler::Fsr, 480, 270);
        check_colors(&resized, 480, 270, bgra, 12);

        let other = Player::new(320, 180, PlayerOptions::default(), None).unwrap();
        other.load(video.0.to_str().unwrap(), None).unwrap();
        wait_for_frame(&other, Upscaler::Off, 320, 180);
        drop(other);
        player.seek_exact(2.0).unwrap();
        wait_for_frame(&player, Upscaler::Fsr, 480, 270);
        assert_eq!(player.stats().gl_errors, 0);
        assert_eq!(player.stats().render_errors, 0);
        let log = player.take_log().join("\n");
        assert!(!log.contains("shader compilation failed"), "{log}");
    }
}
