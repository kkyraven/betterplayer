#[cfg(not(windows))]
fn main() {
    eprintln!("vr_smoke needs Windows and SteamVR");
}

#[cfg(windows)]
fn main() {
    if let Err(e) = smoke::run() {
        eprintln!("vr_smoke: {e}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
mod smoke {
    use std::io::Write;
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    use bp_player::{Player, PlayerOptions, VrView};
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
        D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11ShaderResourceView, ID3D11Texture2D,
    };
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_FORMAT_B8G8R8A8_TYPELESS, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_B8G8R8A8_UNORM_SRGB, DXGI_FORMAT_R8G8B8A8_TYPELESS, DXGI_FORMAT_R8G8B8A8_UNORM,
        DXGI_FORMAT_R8G8B8A8_UNORM_SRGB,
    };
    use windows::core::Interface;

    pub fn run() -> Result<(), String> {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.first().map(String::as_str) == Some("portals") {
            return portals(&args[1..]);
        }
        if args.first().map(String::as_str) == Some("dive") {
            return dive(&args[1..]);
        }
        let [file, kind, layout, fov, seconds, out, flags @ ..] = args.as_slice() else {
            return Err("usage: vr_smoke <file> <kind> <layout> <fov> <seconds> <out> [swap] [window=WxH] [screen=DEG] [turn=DEG]".into());
        };
        let fov: f64 = fov.parse().map_err(|_| "fov is a number")?;
        let seconds: f64 = seconds.parse().map_err(|_| "seconds is a number")?;
        let swap = flags.iter().any(|a| a == "swap");
        let degrees = |key: &str| -> Result<Option<f32>, String> {
            flags.iter().find_map(|a| a.strip_prefix(key)).map(|d| d.parse::<f32>().map_err(|_| format!("{key}DEG"))).transpose()
        };
        let (screen, turn) = (degrees("screen=")?, degrees("turn=")?);
        let window = match flags.iter().find_map(|a| a.strip_prefix("window=")) {
            Some(size) => {
                let (w, h) = size.split_once('x').ok_or("window=WxH")?;
                Some((w.parse::<u32>().map_err(|_| "window=WxH")?, h.parse::<u32>().map_err(|_| "window=WxH")?))
            }
            None => None,
        };

        let options = PlayerOptions { mpv_options: vec![("keepaspect".into(), "no".into()), ("loop-file".into(), "inf".into())], ..PlayerOptions::default() };
        let player = Player::new(64, 64, options, None)?;
        match window {
            Some((w, h)) => player.resize(w, h, None)?,
            None => player.set_presenting(false)?,
        }
        player.load(file, None)?;
        let opened = Instant::now();
        while !player.has_video() {
            if opened.elapsed() > Duration::from_secs(15) {
                return Err(format!("{file} showed no picture: {:?}", player.take_log()));
            }
            sleep(Duration::from_millis(20));
        }
        player.play()?;
        player.vr_view(VrView::parse(kind, layout, fov, None, swap)?)?;
        if let Some(d) = screen {
            player.vr_screen(d)?;
        }
        player.vr_start().wait()?;
        player.vr_recentre(false)?;
        if let Some(d) = turn {
            player.vr_turn(d)?;
        }

        let started = Instant::now();
        let settle = Duration::from_secs(1).min(Duration::from_secs_f64(seconds / 2.0));
        let mut measured: Option<(Instant, u64, u64)> = None;
        let mut last = (0u64, Instant::now());
        let mut frame_ms = Vec::new();
        let mut window_frames = 0u64;
        let mut focus = (0u64, 0u64);
        let mut printed = Instant::now();
        while started.elapsed().as_secs_f64() < seconds {
            sleep(Duration::from_millis(1));
            let now = Instant::now();
            let taken = player.acquire().is_some();
            let Some(s) = player.vr_status() else { continue };
            if now.duration_since(printed) >= Duration::from_millis(500) {
                printed = now;
                println!("{s:?}");
            }
            if started.elapsed() < settle {
                last = (s.frames, now);
                continue;
            }
            focus = (focus.0 + s.focused as u64, focus.1 + 1);
            let (_, first, _) = *measured.get_or_insert_with(|| (now, s.frames, player.stats().frames));
            if s.frames > last.0 && s.frames > first {
                let step = now.duration_since(last.1).as_secs_f64() * 1000.0 / (s.frames - last.0) as f64;
                frame_ms.extend(std::iter::repeat_n(step, (s.frames - last.0) as usize));
            }
            if s.frames != last.0 {
                last = (s.frames, now);
            }
            window_frames += taken as u64;
        }
        let ended = (Instant::now(), last.0, player.stats());
        let window_shot = window.and_then(|(w, h)| {
            let a = player.acquire_wait(Duration::from_millis(500))?;
            let slot = player.slot(a.index);
            let mut rgba = unsafe { slot.as_slice() }[..(w * h * 4) as usize].to_vec();
            for px in rgba.chunks_exact_mut(4) {
                if player.bgra() {
                    px.swap(0, 2);
                }
                px[3] = 255;
            }
            Some((w, h, rgba))
        });
        let shots = mirrors();
        let status = player.vr_status();
        let _ = player.vr_stop().wait();
        println!("after stop: {:?}", player.vr_status());

        if let (Some((since, first, published)), Some(s)) = (measured, &status) {
            let (until, frames, stats) = ended;
            let secs = until.duration_since(since).as_secs_f64();
            frame_ms.sort_by(f64::total_cmp);
            let at = |p: f64| frame_ms.get(((frame_ms.len().max(1) - 1) as f64 * p).round() as usize).copied().unwrap_or(0.0);
            let budget = 1000.0 / s.refresh_hz.max(1.0) as f64;
            let late = frame_ms.iter().filter(|&&ms| ms > budget * 1.5).count();
            println!(
                "headset: {} frames in {secs:.2} s = {:.1} fps at {:.0} Hz; frame ms p50 {:.2} p95 {:.2} p99 {:.2} max {:.2}; {late} over {:.1} ms; focused {:.0} %",
                frames - first,
                (frames - first) as f64 / secs,
                s.refresh_hz,
                at(0.5),
                at(0.95),
                at(0.99),
                at(1.0),
                budget * 1.5,
                focus.0 as f64 * 100.0 / focus.1.max(1) as f64,
            );
            match window {
                Some((w, h)) => println!(
                    "window {w}x{h}: {window_frames} taken, {} published = {:.1} fps; copy ms p50 {:.2} p95 {:.2} max {:.2}; readback ms p50 {:.2} p95 {:.2} max {:.2}; render errors {} gl errors {}",
                    stats.frames - published,
                    (stats.frames - published) as f64 / secs,
                    stats.render.p50,
                    stats.render.p95,
                    stats.render.max,
                    stats.readback.p50,
                    stats.readback.p95,
                    stats.readback.max,
                    stats.render_errors,
                    stats.gl_errors,
                ),
                None => println!("window: not presenting, {} published", stats.frames - published),
            }
        }
        if let Some((w, h, rgba)) = window_shot {
            let path = format!("{out}-window.png");
            png(&path, w, h, &rgba)?;
            println!("wrote {path} ({w}x{h})");
        }
        for ((w, h, rgba), eye) in shots?.into_iter().zip(["left", "right"]) {
            let path = format!("{out}-{eye}.png");
            png(&path, w, h, &rgba)?;
            println!("wrote {path} ({w}x{h})");
        }
        match status {
            Some(s) if s.active && s.frames > 0 => Ok(()),
            s => Err(format!("the headset did not get frames: {s:?}")),
        }
    }

    fn mirrors() -> Result<Vec<(u32, u32, Vec<u8>)>, String> {
        let (device, context) = device()?;
        let views = unsafe { [bp_vr::mirror(0, device.as_raw())?, bp_vr::mirror(1, device.as_raw())?] };
        sleep(Duration::from_millis(300));
        let shots = views
            .iter()
            .map(|view| match unsafe { ID3D11ShaderResourceView::from_raw_borrowed(view) } {
                Some(srv) => unsafe { read(&device, &context, srv) },
                None => Err("no mirror view".into()),
            })
            .collect();
        views.into_iter().for_each(|view| unsafe { bp_vr::release_mirror(view) });
        shots
    }

    unsafe fn read(device: &ID3D11Device, context: &ID3D11DeviceContext, view: &ID3D11ShaderResourceView) -> Result<(u32, u32, Vec<u8>), String> {
        unsafe {
            let resource = view.GetResource().map_err(|e| e.to_string())?;
            let texture: ID3D11Texture2D = resource.cast().map_err(|e| e.to_string())?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            texture.GetDesc(&mut desc);
            let bgra = match desc.Format {
                DXGI_FORMAT_R8G8B8A8_TYPELESS | DXGI_FORMAT_R8G8B8A8_UNORM | DXGI_FORMAT_R8G8B8A8_UNORM_SRGB => false,
                DXGI_FORMAT_B8G8R8A8_TYPELESS | DXGI_FORMAT_B8G8R8A8_UNORM | DXGI_FORMAT_B8G8R8A8_UNORM_SRGB => true,
                f => return Err(format!("mirror format {} not handled", f.0)),
            };
            let staging_desc = D3D11_TEXTURE2D_DESC {
                MipLevels: 1,
                ArraySize: 1,
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
                ..desc
            };
            let mut staging = None;
            device.CreateTexture2D(&staging_desc, None, Some(&mut staging)).map_err(|e| e.to_string())?;
            let staging = staging.ok_or("no staging texture")?;
            context.CopySubresourceRegion(&staging, 0, 0, 0, 0, &texture, 0, None);
            let mut mapped = Default::default();
            context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(|e| e.to_string())?;
            let (w, h) = (desc.Width, desc.Height);
            let mut rgba = Vec::with_capacity((w * h * 4) as usize);
            for y in 0..h as usize {
                let row = std::slice::from_raw_parts((mapped.pData as *const u8).add(y * mapped.RowPitch as usize), w as usize * 4);
                for px in row.chunks_exact(4) {
                    let (r, b) = if bgra { (px[2], px[0]) } else { (px[0], px[2]) };
                    rgba.extend_from_slice(&[r, px[1], b, 255]);
                }
            }
            context.Unmap(&staging, 0);
            Ok((w, h, rgba))
        }
    }

    fn device() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
        let (mut device, mut context) = (None, None);
        unsafe {
            D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut context))
        }
        .map_err(|e| e.to_string())?;
        Ok((device.ok_or("no device")?, context.ok_or("no context")?))
    }

    pub fn portals(args: &[String]) -> Result<(), String> {
        use bp_player::portals::{self as p, Dive, DiveKind};
        let [file, out, flags @ ..] = args else {
            return Err("usage: vr_smoke portals <file> <out> [layout=sbs]".into());
        };
        let layout = flags.iter().find_map(|a| a.strip_prefix("layout=")).unwrap_or("sbs");
        let options = PlayerOptions { mpv_options: vec![("keepaspect".into(), "no".into()), ("loop-file".into(), "inf".into())], ..PlayerOptions::default() };
        let player = Player::new(64, 64, options, None)?;
        player.set_presenting(false)?;
        player.load(file, None)?;
        wait_for(|| player.has_video(), 15, &format!("{file} showed no picture"))?;
        player.play()?;
        player.vr_view(VrView::parse("equirect180", layout, 190.0, None, false)?)?;
        player.vr_start().wait()?;
        player.vr_recentre(false)?;
        shelf(&player)?;

        let frames = |seconds: f64, upload: bool| -> Result<Vec<f64>, String> {
            let mut ms = Vec::new();
            let mut last = player.vr_status().map(|s| (s.frames, Instant::now())).ok_or("not in VR")?;
            let start = Instant::now();
            let mut slot = 0;
            while start.elapsed().as_secs_f64() < seconds {
                if upload {
                    player.vr_still(slot % 8, &grid(1024, 1024, 180.0, 180.0, slot % 8), shelf_still())?;
                    slot += 1;
                }
                sleep(Duration::from_millis(1));
                let Some(s) = player.vr_status() else { continue };
                if s.frames > last.0 {
                    let step = last.1.elapsed().as_secs_f64() * 1000.0 / (s.frames - last.0) as f64;
                    ms.extend(std::iter::repeat_n(step, (s.frames - last.0) as usize));
                    last = (s.frames, Instant::now());
                }
            }
            ms.sort_by(f64::total_cmp);
            Ok(ms)
        };
        let at = |v: &[f64], q: f64| v.get(((v.len().max(1) - 1) as f64 * q).round() as usize).copied().unwrap_or(0.0);
        let quiet = frames(2.0, false)?;
        p::measure_uploads(true);
        let busy = frames(2.0, true)?;
        p::measure_uploads(false);
        let mut uploads = p::take_upload_ms();
        uploads.sort_by(f64::total_cmp);
        let mut mips = p::take_mip_ms();
        mips.sort_by(f64::total_cmp);
        println!("array GenerateMipmap alone ms: p50 {:.3} p95 {:.3} max {:.3} ({} uploads)", at(&mips, 0.5), at(&mips, 0.95), at(&mips, 1.0), mips.len());
        println!("frame ms without uploads: p50 {:.2} p95 {:.2} max {:.2} ({} frames)", at(&quiet, 0.5), at(&quiet, 0.95), at(&quiet, 1.0), quiet.len());
        println!("frame ms with a still upload a frame: p50 {:.2} p95 {:.2} max {:.2} ({} frames)", at(&busy, 0.5), at(&busy, 0.95), at(&busy, 1.0), busy.len());
        println!(
            "upload + array GenerateMipmap ms (GL finished either side): p50 {:.3} p95 {:.3} max {:.3} ({} uploads); the 1 ms mip rule {}",
            at(&uploads, 0.5),
            at(&uploads, 0.95),
            at(&uploads, 1.0),
            uploads.len(),
            if mips.is_empty() { "not measured" } else if at(&mips, 0.5) <= 1.0 { "holds" } else { "fails: send mip chains" },
        );

        let (device, context) = device()?;
        let views = unsafe { [bp_vr::mirror(0, device.as_raw())?, bp_vr::mirror(1, device.as_raw())?] };
        sleep(Duration::from_millis(300));
        let shoot = |name: &str| -> Result<(), String> {
            println!("shot {name} at {:.1}, headset frame {:?}", bp_player::portals::now_ms(), player.vr_status().map(|s| s.frames));
            for (view, eye) in views.iter().zip(["left", "right"]) {
                let srv = unsafe { ID3D11ShaderResourceView::from_raw_borrowed(view) }.ok_or("no mirror view")?;
                let (w, h, rgba) = unsafe { read(&device, &context, srv)? };
                let path = format!("{out}-{name}-{eye}.png");
                png(&path, w, h, &rgba)?;
                println!("wrote {path}");
            }
            std::fs::write(format!("{out}-{name}-dump.json"), player.vr_portal_dump()).map_err(|e| e.to_string())?;
            Ok(())
        };
        let shots = (|| -> Result<(), String> {
            shoot("shelf")?;
            let az = (1.0 - 1.5) * p::step_deg();
            let dist = az.hypot(2.5 - p::dive_el_deg());
            let slide = if dist < p::SLIDE_MIN_DEG { 0.0 } else { p::ms::SLIDE_BASE + p::ms::SLIDE_PER_DEG * dist };
            let start = p::now_ms();
            player.vr_dive(Dive { kind: DiveKind::Vr, key: "top-1".into(), start_ms: start, slide_ms: slide, same: false, full: 180, screen_deg: 50.0, aspect: 16.0 / 9.0 })?;
            player.vr_trace("press", "top-1", Some(start));
            println!("load from {:.1}, headset frame {:?}", p::now_ms(), player.vr_status().map(|s| s.frames));
            player.load(file, Some(1.0))?;
            println!("load returned {:.1}, headset frame {:?}", p::now_ms(), player.vr_status().map(|s| s.frames));
            player.vr_view(VrView::parse("equirect180", layout, 190.0, None, false)?)?;
            let until = |e: f64| {
                let wait = start + e - p::now_ms();
                if wait > 0.0 {
                    sleep(Duration::from_secs_f64(wait / 1000.0));
                }
            };
            until(slide / 2.0);
            shoot("slide")?;
            until(slide + 125.0);
            shoot("grow25")?;
            until(slide + 500.0);
            shoot("grown")?;
            until(slide + 500.0 + 1500.0);
            shoot("live")?;
            Ok(())
        })();
        views.into_iter().for_each(|view| unsafe { bp_vr::release_mirror(view) });
        let status = player.vr_portal_status();
        println!("status: {status:?}");
        let dump = player.vr_portal_dump();
        std::fs::write(format!("{out}-dump.json"), &dump).map_err(|e| e.to_string())?;
        println!("wrote {out}-dump.json");
        let vr = player.vr_status();
        let _ = player.vr_stop().wait();
        shots?;
        match vr {
            Some(s) if s.active && s.frames > 0 && status.live_at_ms.is_some() => Ok(()),
            Some(s) if s.active && s.frames > 0 => Err(format!("the dive never went live: {status:?}")),
            s => Err(format!("the headset did not get frames: {s:?}")),
        }
    }

    pub fn dive(args: &[String]) -> Result<(), String> {
        use bp_player::portals::{self as p, Dive, DiveKind};
        let rounds: usize = args.iter().find_map(|a| a.strip_prefix("rounds=")).map_or(Ok(3), str::parse).map_err(|_| "rounds=N")?;
        let verbose = args.iter().any(|a| a == "log");
        let other = args.iter().any(|a| a == "other");
        let extra: Vec<(String, String)> = args.iter().filter_map(|a| a.strip_prefix("mpv=")?.split_once('=')).map(|(k, v)| (k.into(), v.into())).collect();
        let args: Vec<&String> = args.iter().filter(|a| !a.starts_with("rounds=") && !a.starts_with("mpv=") && a.as_str() != "log" && a.as_str() != "other").collect();
        let [out, first, files @ ..] = args.as_slice() else {
            return Err("usage: vr_smoke dive <out.json> <first> <file>... [rounds=N]".into());
        };
        if files.is_empty() {
            return Err("no file to dive into".into());
        }
        let view = |file: &str| if file.contains("_360") { VrView::parse("equirect360", "mono", 190.0, None, false) } else { VrView::parse("equirect180", "sbs", 190.0, None, false) };
        let mut mpv_options = vec![("keepaspect".into(), "no".into())];
        mpv_options.extend(extra);

        let player = Player::new(64, 64, PlayerOptions { mpv_options, verbose, ..PlayerOptions::default() }, None)?;
        player.set_presenting(false)?;
        player.load(first, None)?;
        wait_for(|| player.has_video(), 15, &format!("{first} showed no picture"))?;
        player.play()?;
        player.vr_view(view(first)?)?;
        player.vr_start().wait()?;
        player.vr_recentre(false)?;
        bp_player::frame_log::json(p::now_ms());
        shelf(&player)?;
        let refresh = player.vr_status().map_or(90.0, |s| s.refresh_hz as f64);
        let period = 1000.0 / refresh;
        println!("headset at {refresh:.0} Hz: a frame is late past {:.1} ms", period * 1.5);
        sleep(Duration::from_secs(1));
        let second = if other {
            let second = Player::new(64, 64, PlayerOptions { mpv_options: vec![("keepaspect".into(), "no".into())], ..PlayerOptions::default() }, None)?;
            second.set_presenting(false)?;
            Some(second)
        } else {
            None
        };
        sleep(Duration::from_millis(500));
        let began = p::now_ms();
        let az = (1.0 - 1.5) * p::step_deg();
        let dist = az.hypot(2.5 - p::dive_el_deg());
        let slide = if dist < p::SLIDE_MIN_DEG { 0.0 } else { p::ms::SLIDE_BASE + p::ms::SLIDE_PER_DEG * dist };
        let mut summary: Vec<(String, Vec<(f64, usize, u64)>)> = files.iter().map(|f| (f.to_string(), Vec::new())).collect();
        for round in 0..rounds {
            for (i, file) in files.iter().enumerate() {
                let _ = player.take_log();
                let press = p::now_ms();
                if let Some(second) = &second {
                    second.load(file, Some(1.0))?;
                    second.play()?;
                } else {
                    player.vr_dive(Dive { kind: DiveKind::Vr, key: "top-1".into(), start_ms: press, slide_ms: slide, same: false, full: 180, screen_deg: 50.0, aspect: 16.0 / 9.0 })?;
                    player.vr_keyframe_start(true);
                    player.load(file, Some(1.0))?;
                    player.play()?;
                    player.vr_view(view(file)?)?;
                }
                if verbose {
                    while p::now_ms() < press + 3000.0 {
                        for line in player.take_log() {
                            println!("  {:7.1} {}", p::now_ms() - press, line.trim_end());
                        }
                        sleep(Duration::from_millis(1));
                    }
                } else {
                    sleep(Duration::from_millis(3000));
                }
                let status = player.vr_portal_status();
                let log: serde_json::Value = serde_json::from_str(&bp_player::frame_log::json(press)).map_err(|e| e.to_string())?;
                let rows = |key: &str| log[key].as_array().cloned().unwrap_or_default();
                let num = |row: &serde_json::Value, i: usize| row[i].as_f64().unwrap_or(0.0);
                let until = press + 3000.0;
                let drawn: Vec<_> = rows("drawn").into_iter().filter(|r| num(r, 0) <= until).collect();
                let gaps: Vec<f64> = drawn.iter().skip(1).map(|r| num(r, 5)).collect();
                let longest = gaps.iter().copied().fold(0.0, f64::max);
                let late = gaps.iter().filter(|&&g| g > period * 1.5).count();
                let cpu = drawn.iter().map(|r| num(r, 1)).fold(0.0, f64::max);
                let shown: Vec<_> = rows("shown").into_iter().filter(|r| num(r, 0) <= until).collect();
                let dropped: u64 = shown.iter().map(|r| num(r, 4) as u64).sum();
                let repeated = shown.iter().filter(|r| num(r, 2) > 1.0).count() as u64;
                let mut held: Vec<_> = rows("held").into_iter().filter(|r| num(r, 0) <= until).collect();
                held.sort_by(|a, b| num(b, 2).total_cmp(&num(a, 2)));
                let held: Vec<String> = held.iter().take(4).map(|r| format!("{:.1} ms at +{:.0} (waited {:.1}) {}", num(r, 2), num(r, 0) - press, num(r, 1), r[3].as_str().unwrap_or(""))).collect();
                let live = status.live_at_ms.map_or("never".into(), |at| format!("{:.0} ms", at - press));
                println!(
                    "round {round} {}: longest gap {longest:.1} ms, {late} late of {} frames, longest cpu {cpu:.1} ms; compositor {dropped} dropped, {repeated} shown again; live after {live}; held: {}",
                    file.rsplit(['/', '\\']).next().unwrap_or(file),
                    drawn.len(),
                    if held.is_empty() { "none".into() } else { held.join(", ") },
                );
                summary[i].1.push((longest, late, dropped + repeated));
            }
        }
        for (file, dives) in &summary {
            let mut longest: Vec<f64> = dives.iter().map(|d| d.0).collect();
            longest.sort_by(f64::total_cmp);
            let late: usize = dives.iter().map(|d| d.1).sum();
            let missed: u64 = dives.iter().map(|d| d.2).sum();
            println!(
                "{}: {} dives, longest gap median {:.1} max {:.1} ms; late frames {:.1} a dive; compositor misses {:.1} a dive",
                file.rsplit(['/', '\\']).next().unwrap_or(file),
                dives.len(),
                longest[longest.len() / 2],
                longest.last().copied().unwrap_or(0.0),
                late as f64 / dives.len() as f64,
                missed as f64 / dives.len() as f64,
            );
        }
        std::fs::write(out, bp_player::frame_log::json(began)).map_err(|e| e.to_string())?;
        println!("wrote {out}");
        let _ = player.vr_stop().wait();
        Ok(())
    }

    fn shelf_still() -> bp_player::portals::StillInfo {
        bp_player::portals::StillInfo { equirect: true, half_h_deg: 90.0, half_v_deg: 90.0, width: 1024, height: 1024, key: None }
    }

    fn shelf(player: &Player) -> Result<(), String> {
        use bp_player::portals::{self as p, ItemKind, Keyframe, PORTAL, PortalBand, PortalItem, PortalScene, ROWS_BAND, STRIP_BAND, StillInfo};
        wait_for(|| p::last_head().is_some(), 10, "the head was never tracked")?;
        sleep(Duration::from_millis(300));
        let head = p::last_head().ok_or("no head")?;
        let seat = bp_vr::Recentre::from_head(&head);

        let band = |spec: &p::BandSpec, which: p::Band| {
            let l = p::band_layout(spec);
            PortalBand { band: which, pose: bp_vr::panel(&seat, l.distance as f32, l.drop as f32, l.pitch as f32), metres: l.metres, curvature: l.curvature, width: l.width, height: l.height }
        };
        let mut items = Vec::new();
        for (row, (name, el)) in [("top", 2.5), ("bottom", -13.7)].into_iter().enumerate() {
            for i in 0..4 {
                let az = (i as f64 - 1.5) * p::step_deg();
                let (x, y) = p::band_texel(&ROWS_BAND, az, el);
                items.push(PortalItem {
                    key: format!("{name}-{i}"),
                    x,
                    y,
                    size: PORTAL,
                    row: row as i32,
                    kind: ItemKind::Still,
                    slot: Some((row * 4 + i) as u32),
                    lift: Keyframe::still(if name == "top" && i == 1 { 1.0 } else { 0.0 }),
                    shade: Keyframe::still(1.0),
                    enter: Keyframe::still(1.0),
                    dz: 0.0,
                    op: 1.0,
                });
            }
        }
        let scene = PortalScene {
            rev: 1,
            seat,
            bands: vec![band(&ROWS_BAND, p::Band::Rows), band(&STRIP_BAND, p::Band::Strip)],
            items,
            scroll: vec![Keyframe::still(0.0); 3],
            shown: Keyframe::still(1.0),
            fade: Keyframe::still(1.0),
            dim: 0.32,
        };
        player.vr_portals(scene)?;
        for slot in 0..8 {
            player.vr_still(slot, &grid(1024, 1024, 180.0, 180.0, slot), shelf_still())?;
        }
        player.vr_still(16, &grid(2048, 2048, 180.0, 180.0, 1), StillInfo { equirect: true, half_h_deg: 90.0, half_v_deg: 90.0, width: 2048, height: 2048, key: Some("top-1".into()) })?;
        sleep(Duration::from_millis(500));
        Ok(())
    }

    fn wait_for(ok: impl Fn() -> bool, seconds: u64, what: &str) -> Result<(), String> {
        let start = Instant::now();
        while !ok() {
            if start.elapsed() > Duration::from_secs(seconds) {
                return Err(what.into());
            }
            sleep(Duration::from_millis(20));
        }
        Ok(())
    }

    fn grid(w: u32, h: u32, across: f64, down: f64, seed: u32) -> Vec<u8> {
        let tint = [[200u8, 80, 80], [80, 200, 80], [80, 80, 200], [200, 200, 80], [80, 200, 200], [200, 80, 200], [160, 120, 60], [60, 120, 160]][seed as usize % 8];
        let mut px = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                let (az, el) = ((x as f64 + 0.5) / w as f64 * across - across / 2.0, down / 2.0 - (y as f64 + 0.5) / h as f64 * down);
                let line = (az.rem_euclid(10.0) < across / w as f64 * 3.0) || (el.rem_euclid(10.0) < down / h as f64 * 3.0);
                let centre = (az.abs() < 0.4 && el.abs() < 3.0) || (el.abs() < 0.4 && az.abs() < 3.0);
                let c = if centre || line { [240, 240, 240] } else { tint.map(|v| v / 2) };
                px.extend_from_slice(&[c[0], c[1], c[2], 255]);
            }
        }
        px
    }

    fn png(path: &str, w: u32, h: u32, rgba: &[u8]) -> Result<(), String> {
        let mut raw = Vec::with_capacity(rgba.len() + h as usize);
        for row in rgba.chunks_exact(w as usize * 4) {
            raw.push(0);
            raw.extend_from_slice(row);
        }
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
        z.write_all(&raw).map_err(|e| e.to_string())?;
        let data = z.finish().map_err(|e| e.to_string())?;
        let mut header = Vec::new();
        header.extend_from_slice(&w.to_be_bytes());
        header.extend_from_slice(&h.to_be_bytes());
        header.extend_from_slice(&[8, 6, 0, 0, 0]);
        let mut file = b"\x89PNG\r\n\x1a\n".to_vec();
        for (kind, body) in [(b"IHDR", &header[..]), (b"IDAT", &data[..]), (b"IEND", &[][..])] {
            file.extend_from_slice(&(body.len() as u32).to_be_bytes());
            let mut crc = flate2::Crc::new();
            crc.update(kind);
            crc.update(body);
            file.extend_from_slice(kind);
            file.extend_from_slice(body);
            file.extend_from_slice(&crc.sum().to_be_bytes());
        }
        std::fs::write(path, file).map_err(|e| e.to_string())
    }
}
