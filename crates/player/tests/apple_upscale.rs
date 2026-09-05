#![cfg(target_os = "macos")]

use bp_player::{EnhanceOptions, Player, PlayerOptions, Upscaler};
use std::io::Write;
use std::time::{Duration, Instant};

struct Picture(std::path::PathBuf);

impl Picture {
    fn new(width: u32, height: u32) -> Self {
        let path = std::env::temp_dir().join(format!("bp-apple-test-{}-{width}.ppm", std::process::id()));
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
                return unsafe { slot.as_slice() }.to_vec();
            }
        }
    }
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
#[ignore = "requires macOS 26, supported Apple silicon, and GPU access"]
fn apple_upscales_paused_frames_resizes_and_falls_back() {
    let source = Picture::new(640, 360);
    let unsupported = Picture::new(3840, 2160);

    for bgra in [true, false] {
        let opts = PlayerOptions { bgra, async_readback: bgra, mpv_options: vec![("keepaspect".into(), "no".into())], ..Default::default() };
        let player = Player::new(1280, 720, opts, None).unwrap();
        assert!(player.enhance_capabilities().apple_vsr, "Apple AI unavailable on this machine");
        player.load(source.0.to_str().unwrap(), None).unwrap();
        let original = wait_for_frame(&player, Upscaler::Off, 1280, 720);
        check_colors(&original, 1280, 720, bgra, 5);
        player.set_enhance(EnhanceOptions { upscaler: Upscaler::Apple, ..Default::default() }).unwrap();
        let enhanced = wait_for_frame(&player, Upscaler::Apple, 1280, 720);

        check_colors(&enhanced, 1280, 720, bgra, 50);
        assert_eq!(player.enhance_state().factor, 2.0);
        assert!(player.enhance_state().reason.is_none());
        let difference: u64 = original.iter().zip(&enhanced).map(|(a, b)| u64::from(a.abs_diff(*b))).sum();
        assert!(difference > 0, "The native processor must change the picture");

        player.resize(960, 540, None).unwrap();
        check_colors(&wait_for_frame(&player, Upscaler::Apple, 960, 540), 960, 540, bgra, 50);
        player.set_enhance(EnhanceOptions::default()).unwrap();
        check_colors(&wait_for_frame(&player, Upscaler::Off, 960, 540), 960, 540, bgra, 50);

        player.load(unsupported.0.to_str().unwrap(), None).unwrap();
        wait_for_frame(&player, Upscaler::Off, 960, 540);
        player.resize(4096, 2304, None).unwrap();
        player.set_enhance(EnhanceOptions { upscaler: Upscaler::Apple, ..Default::default() }).unwrap();
        check_colors(&wait_for_frame(&player, Upscaler::Sharp, 4096, 2304), 4096, 2304, bgra, 5);
        assert_eq!(player.enhance_state().reason.as_deref(), Some("Unsupported video size"));

        player.resize(1280, 720, None).unwrap();
        player.load(source.0.to_str().unwrap(), None).unwrap();
        check_colors(&wait_for_frame(&player, Upscaler::Apple, 1280, 720), 1280, 720, bgra, 50);
        assert_eq!(player.stats().gl_errors, 0);
        assert_eq!(player.stats().render_errors, 0);
    }
}
