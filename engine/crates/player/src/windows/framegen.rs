use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};

use super::egl::{D3dImage, Gpu};
use super::fruc::{self, Fruc};
use crate::enhance::FrameGenShared;
use crate::mpv::Mpv;

const SNAP: f64 = 0.06;
const NEED: f64 = 1.4;
const KEEP: f64 = 1.26;
const STEP: f64 = 0.35;
const MAX_INTERVAL: f64 = 0.2;
const SETTLE: Duration = Duration::from_millis(800);
const EARLY: f64 = 0.2;
static SESSIONS: AtomicU32 = AtomicU32::new(0);
const MAX_SESSIONS: u32 = 48;
const WINDOW: u32 = 48;
const KEEPS_UP: f64 = 0.7;

#[derive(Default)]
struct Pace {
    newest: Option<f64>,
    interval: Option<f64>,
    pair: bool,
}

impl Pace {
    fn arrived(&mut self, now: f64) -> bool {
        let gap = self.newest.map(|at| now - at);
        (self.newest, self.interval, self.pair) = match (gap, self.interval) {
            (Some(gap), Some(interval)) if (gap - interval).abs() <= interval * STEP => {
                let off = gap - interval;
                (Some(now - off * 0.75), Some(interval + off * 0.1), true)
            }
            (Some(gap), _) if gap > 0.0 && gap <= MAX_INTERVAL => (Some(now), Some(gap), false),
            _ => (Some(now), None, false),
        };
        self.pair
    }

    fn phase(&self, now: f64) -> f64 {
        match (self.pair, self.newest, self.interval) {
            (true, Some(newest), Some(interval)) => ((now - newest) / interval).clamp(0.0, 1.0),
            _ => 1.0,
        }
    }

    fn forget(&mut self) {
        *self = Pace::default();
    }
}

#[derive(Default)]
struct Timeline {
    pace: Pace,
    newest: u64,
    shown: f64,
    due: f64,
    cut: bool,
    load: Load,
}

#[derive(Default)]
struct Load {
    pairs: u32,
    shown: u32,
    asked_now: u32,
    shown_now: u32,
}

impl Timeline {
    fn arrived(&mut self, now: f64, wanted: f64) -> bool {
        let (asked, shown) = (std::mem::take(&mut self.load.asked_now), std::mem::take(&mut self.load.shown_now));
        if self.pace.pair && asked as f64 >= wanted * 0.9 {
            self.load.pairs += 1;
            self.load.shown += shown;
        }
        self.newest += 1;
        self.cut = false;
        self.pace.arrived(now)
    }

    fn kept_up(&mut self, per_pair: f64) -> Option<f64> {
        if self.load.pairs < WINDOW {
            return None;
        }
        let Load { pairs, shown, .. } = std::mem::take(&mut self.load);
        Some(shown as f64 / (pairs as f64 * per_pair))
    }

    fn asked(&mut self, now: f64, interval: f64) -> Option<f64> {
        if !self.pace.pair {
            return None;
        }
        let phase = self.pace.phase(now);
        let phase = if phase > 1.0 - SNAP {
            1.0
        } else if phase < SNAP || self.cut {
            0.0
        } else {
            phase
        };
        let position = (self.newest - 1) as f64 + phase;
        if position <= self.shown {
            return None;
        }
        self.load.asked_now += 1;
        (now + interval * EARLY >= self.due).then_some(position)
    }

    fn showed(&mut self, position: f64, made: bool, now: f64, interval: f64) {
        self.cut |= !made;
        self.load.shown_now += 1;
        self.shown = if made { position } else { position.floor() };
        self.due = (self.due + interval).max(now + interval * 0.75);
    }

    fn caught_up(&mut self) {
        self.shown = self.newest as f64;
    }
}

struct Surface {
    image: D3dImage,
    tex: ID3D11Texture2D,
}

impl Surface {
    fn new(gpu: Gpu, device: &ID3D11Device, size: (u32, u32)) -> Result<Surface, String> {
        let tex = fruc::texture(device, size)?;
        Ok(Surface { image: gpu.wrap_d3d11(&tex)?, tex })
    }
}

struct Session {
    fruc: Fruc,
    frames: [Surface; 2],
    between: Surface,
    size: (u32, u32),
    fed: Option<u64>,
}

impl Session {
    fn new(gpu: Gpu, device: &ID3D11Device, size: (u32, u32)) -> Result<Session, String> {
        let (frames, between) = ([Surface::new(gpu, device, size)?, Surface::new(gpu, device, size)?], Surface::new(gpu, device, size)?);
        let fruc = Fruc::new(device, size.0, size.1, &[&frames[0].tex, &frames[1].tex, &between.tex])?;
        Ok(Session { fruc, frames, between, size, fed: None })
    }

    fn frame(&self, n: u64) -> &Surface {
        &self.frames[(n % 2) as usize]
    }

    fn interpolate(&mut self, n: u64, phase: f64) -> Result<bool, String> {
        unsafe { gl::Flush() };
        if self.fed != Some(n) && self.fed != Some(n - 1) {
            self.fruc.process(&self.frames[((n - 1) % 2) as usize].tex, (n - 1) as f64, None)?;
        }
        self.fed = Some(n);
        let repeated = self.fruc.process(&self.frames[(n % 2) as usize].tex, n as f64, Some((&self.between.tex, (n - 1) as f64 + phase)))?;
        Ok(!repeated)
    }
}

fn blit(from: u32, from_at: (u32, u32), to: u32, to_at: (u32, u32), size: (u32, u32)) {
    let [fx, fy, tx, ty, w, h] = [from_at.0, from_at.1, to_at.0, to_at.1, size.0, size.1].map(|v| v as i32);
    unsafe {
        gl::Disable(gl::SCISSOR_TEST);
        gl::BindFramebuffer(gl::READ_FRAMEBUFFER, from);
        gl::BindFramebuffer(gl::DRAW_FRAMEBUFFER, to);
        gl::BlitFramebuffer(fx, fy, fx + w, fy + h, tx, ty, tx + w, ty + h, gl::COLOR_BUFFER_BIT, gl::NEAREST);
        gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
    }
}

type Rect = (u32, u32, u32, u32);

pub(crate) struct FrameGen {
    shared: Arc<Mutex<FrameGenShared>>,
    mpv: Arc<Mpv>,
    gpu: Gpu,
    device: ID3D11Device,
    epoch: Instant,
    target_fps: f64,
    rate: f64,
    failure: Option<String>,
    size: (u32, u32),
    sized_at: Instant,
    session: Option<Session>,
    timeline: Timeline,
    making: bool,
}

impl FrameGen {
    pub fn new(shared: Arc<Mutex<FrameGenShared>>, mpv: Arc<Mpv>, gpu: Gpu, device: ID3D11Device) -> FrameGen {
        let now = Instant::now();
        FrameGen { shared, mpv, gpu, device, epoch: now, target_fps: 0.0, rate: 0.0, failure: None, size: (0, 0), sized_at: now, session: None, timeline: Timeline::default(), making: false }
    }

    fn secs(&self, at: Instant) -> f64 {
        at.duration_since(self.epoch).as_secs_f64()
    }

    fn report(&mut self, active: bool, reason: Option<String>) {
        self.making = active;
        let lag = if active { self.timeline.pace.interval.unwrap_or(0.0) } else { 0.0 };
        self.mpv.picture_lag.store(lag.to_bits(), Ordering::Relaxed);
        let mut shared = self.shared.lock().unwrap();
        if shared.target_fps == self.target_fps {
            shared.active = active;
            shared.reason = reason;
        }
    }

    fn fail(&mut self, reason: String) {
        self.session = None;
        self.timeline.pace.forget();
        self.report(false, Some(reason.clone()));
        self.failure = Some(reason);
    }

    pub fn suspend(&mut self) {
        self.session = None;
        self.timeline.pace.forget();
        self.report(false, None);
    }

    pub fn restart(&mut self) {
        (self.rate, self.failure) = (self.target_fps, None);
    }

    pub fn caught_up(&mut self) {
        self.timeline.caught_up();
    }

    pub fn frame(&mut self, fbo: u32, rect: Rect, at: Instant) -> bool {
        let target_fps = self.shared.lock().unwrap().target_fps;
        let size = (rect.2, rect.3);
        if target_fps != self.target_fps || size != self.size {
            if size != self.size {
                (self.size, self.sized_at) = (size, at);
            }
            (self.target_fps, self.rate, self.failure) = (target_fps, target_fps, None);
        }
        if self.target_fps <= 0.0 || self.failure.is_some() {
            if self.session.is_some() {
                self.suspend();
            }
            return true;
        }
        if self.session.as_ref().is_none_or(|s| s.size != size) {
            if self.session.is_some() || self.making {
                self.suspend();
            }
            if at.duration_since(self.sized_at) < SETTLE {
                return true;
            }
            if SESSIONS.fetch_add(1, Ordering::Relaxed) >= MAX_SESSIONS {
                self.fail("frame generation is off until the app is restarted".into());
                return true;
            }
            match Session::new(self.gpu, &self.device, size) {
                Ok(session) => self.session = Some(session),
                Err(e) => {
                    self.fail(e);
                    return true;
                }
            }
        }
        let per_pair = |stage: &FrameGen| stage.timeline.pace.interval.unwrap_or(0.0) * stage.rate;
        let pair = self.timeline.arrived(self.secs(at), per_pair(self));
        if pair && self.making && self.timeline.kept_up(per_pair(self)).is_some_and(|share| share < KEEPS_UP) {
            self.rate /= 2.0;
            if per_pair(self) < NEED {
                self.fail("frame generation cannot keep up at this size".into());
                return true;
            }
        }
        let Some(session) = &self.session else { return true };
        blit(fbo, (rect.0, rect.1), session.frame(self.timeline.newest).image.fbo, (0, 0), size);
        let wanted = pair && per_pair(self) >= if self.making { KEEP } else { NEED };
        if pair {
            self.report(wanted, None);
        }
        !wanted
    }

    pub fn asked(&mut self, at: Instant) -> Option<f64> {
        self.session.as_ref()?;
        self.timeline.asked(self.secs(at), 1.0 / self.rate)
    }

    pub fn picture(&mut self, position: f64, fbo: u32, rect: Rect, at: Instant) -> bool {
        let Some(session) = self.session.as_mut().filter(|s| s.size == (rect.2, rect.3)) else { return false };
        let n = self.timeline.newest;
        let phase = position - (n - 1) as f64;
        let made = if phase > 0.0 && phase < 1.0 {
            match session.interpolate(n, phase) {
                Ok(made) => made,
                Err(e) => {
                    blit(session.frame(n).image.fbo, (0, 0), fbo, (rect.0, rect.1), (rect.2, rect.3));
                    self.timeline.caught_up();
                    self.fail(e);
                    return true;
                }
            }
        } else {
            true
        };
        let from = if phase <= 0.0 {
            session.frame(n - 1)
        } else if phase >= 1.0 {
            session.frame(n)
        } else {
            &session.between
        };
        blit(from.image.fbo, (0, 0), fbo, (rect.0, rect.1), (rect.2, rect.3));
        self.timeline.showed(position, made, self.secs(at), 1.0 / self.rate);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_in_step_are_pairs_and_one_out_of_step_starts_again() {
        let mut pace = Pace::default();
        assert!(!pace.arrived(10.0), "one frame is no pair");
        assert_eq!(pace.phase(10.01), 1.0, "so it is shown itself");
        assert!(!pace.arrived(10.04), "nor are two: the gap between them may be anything");
        assert!(pace.arrived(10.08));
        assert!((pace.phase(10.09) - 0.25).abs() < 1e-9);
        assert_eq!(pace.phase(10.2), 1.0, "the next frame is late: the newest holds");
        assert!(pace.arrived(10.122));
        let phase = pace.phase(10.122 + 0.02);
        assert!(phase > 0.52 && phase < 0.55, "{phase}");
        assert!(!pace.arrived(10.9));
        assert!(!pace.arrived(10.94));
        assert!(pace.arrived(10.98));
        assert!(!pace.arrived(11.0));
        assert!(pace.arrived(11.02));
        assert!((pace.interval.unwrap() - 0.02).abs() < 1e-9);
        let mut at = 12.0;
        for gap in [0.066, 0.005, 0.085, 0.013, 0.067, 0.004] {
            at += gap;
            assert!(!pace.arrived(at), "{gap}");
        }
    }

    fn shown(target_fps: f64, hz: f64, cut_at: Option<f64>) -> Vec<f64> {
        let mut timeline = Timeline { newest: 2, ..Default::default() };
        for frame in -1..=1 {
            timeline.arrived(1.0 + frame as f64 / 24.0, 0.0);
        }
        timeline.shown = 4.0;
        let mut positions = Vec::new();
        let mut now = 1.0 + 1.0 / 24.0;
        while now < 1.0 + 3.0 / 24.0 {
            if let Some(position) = timeline.asked(now, 1.0 / target_fps) {
                timeline.showed(position, cut_at.is_none_or(|cut| (cut - position).abs() > 0.01), now, 1.0 / target_fps);
                positions.push((timeline.shown * 100.0).round() / 100.0);
            }
            now += 1.0 / hz;
        }
        positions
    }

    #[test]
    fn pictures_come_on_the_targets_grid_and_never_go_back() {
        assert_eq!(shown(60.0, 120.0, None), [4.2, 4.6, 5.0]);
        assert_eq!(shown(120.0, 120.0, None), [4.2, 4.4, 4.6, 4.8, 5.0]);
        assert_eq!(shown(120.0, 60.0, None), [4.4, 4.8, 5.0]);
    }

    fn share(rate: f64, hz: f64, watching: f64, nth: u32) -> Option<f64> {
        let (mut timeline, mut due) = (Timeline::default(), 0);
        let per_pair = rate / 24.0;
        for frame in 0..3 * WINDOW {
            let at = frame as f64 / 24.0;
            timeline.arrived(at, per_pair);
            if let Some(share) = timeline.kept_up(per_pair) {
                return Some(share);
            }
            let mut now = at;
            while now < at + 1.0 / 24.0 {
                if now.fract() < watching {
                    if let Some(position) = timeline.asked(now, 1.0 / rate) {
                        due += 1;
                        if due % nth == 0 {
                            timeline.showed(position, true, now, 1.0 / rate);
                        }
                    }
                }
                now += 1.0 / hz;
            }
        }
        None
    }

    #[test]
    fn a_gpu_that_does_not_keep_up_is_found_out_and_a_host_that_asks_little_is_not() {
        assert!(share(120.0, 120.0, 1.0, 1).unwrap() > 0.9, "24 into 120, all made");
        assert!(share(120.0, 120.0, 1.0, 2).unwrap() < KEEPS_UP, "every other picture: 60 would be even");
        assert!(share(60.0, 144.0, 1.0, 1).unwrap() > 0.9, "a faster display than the target");
        assert_eq!(share(120.0, 60.0, 1.0, 1), None, "a 60 Hz display asks for no more than it gets");
        assert!(share(60.0, 144.0, 0.5, 1).unwrap() > KEEPS_UP);
    }

    #[test]
    fn a_frame_shown_as_it_is_has_nothing_from_before_it_shown_after() {
        let ask = |timeline: &mut Timeline, from: f64| (0..100).filter_map(|i| timeline.asked(from + i as f64 / 120.0, 1.0 / 120.0)).collect::<Vec<_>>();
        let mut timeline = Timeline::default();
        for at in [0.96, 1.0, 1.04] {
            timeline.arrived(at, 0.0);
        }
        timeline.caught_up();
        assert!(ask(&mut timeline, 1.05).is_empty());
        assert_eq!(timeline.load.asked_now, 0, "which is not the GPU failing to keep up");
        for at in [3.0, 3.04] {
            timeline.arrived(at, 0.0);
            timeline.caught_up();
            assert!(ask(&mut timeline, at).is_empty());
        }
        timeline.arrived(3.08, 0.0);
        let after = ask(&mut timeline, 3.08);
        assert!(after.first().is_some_and(|first| *first > timeline.newest as f64 - 1.0) && after.is_sorted(), "{after:?}");
    }

    #[test]
    fn a_cut_holds_the_earlier_frame_until_the_newest() {
        assert_eq!(shown(120.0, 120.0, Some(4.2)), [4.0, 5.0]);
    }
}
