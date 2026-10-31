fn main() {
    let seconds: f64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(10.0);
    if let Err(e) = run(seconds) {
        eprintln!("overlay_smoke: {e}");
        std::process::exit(1);
    }
}

fn run(seconds: f64) -> Result<(), String> {
    let mut overlays = bp_vr::Overlays::new()?;
    let screen = overlays.create("betterplayer.smoke.screen", "Screen", 1920, 1080, 2.4, 0.12)?;
    let deck = overlays.create("betterplayer.smoke.deck", "Deck", 1280, 440, 0.62, 0.0)?;
    overlays.paint(screen, &pattern(1920, 1080, [40, 60, 90]), 0, 0, 1920, 1080)?;
    overlays.paint(deck, &pattern(1280, 440, [90, 50, 120]), 0, 0, 1280, 440)?;
    overlays.paint(deck, &vec![255; 1280 * 20 * 4], 0, 420, 1280, 20)?;
    overlays.place(screen, 2.2, 0.05, 0.0)?;
    overlays.place(deck, 0.55, 0.42, 38.0)?;
    overlays.recentre(false)?;
    overlays.follow(screen, true)?;
    overlays.follow(deck, true)?;
    overlays.show(screen, true)?;
    overlays.show(deck, true)?;
    let start = std::time::Instant::now();
    let mut resized = false;
    while start.elapsed().as_secs_f64() < seconds {
        if !resized && start.elapsed().as_secs_f64() >= seconds / 2.0 {
            overlays.resize(screen, 2560, 1080)?;
            overlays.resize(screen, 2560, 1080)?;
            overlays.paint(screen, &pattern(2560, 1080, [40, 90, 60]), 0, 0, 2560, 1080)?;
            resized = true;
            println!("resized the screen to 2560x1080");
        }
        for e in overlays.poll() {
            println!("{e:?}");
        }
        std::thread::sleep(std::time::Duration::from_millis(16));
    }
    overlays.close();
    println!("closed");
    Ok(())
}

fn pattern(w: usize, h: usize, [b, g, r]: [u8; 3]) -> Vec<u8> {
    let mut px = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let bgra = if x < 120 && y < 120 {
                [30, 30, 220, 255]
            } else if x % 80 < 3 || y % 80 < 3 {
                [200, 200, 200, 255]
            } else {
                [b, g, r, 255]
            };
            px.extend_from_slice(&bgra);
        }
    }
    px
}
