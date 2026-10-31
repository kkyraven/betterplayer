use std::ffi::CStr;
use std::time::{Duration, Instant};

pub const TAP: Duration = Duration::from_millis(450);
pub const HOLD: Duration = Duration::from_millis(600);
pub const SEEK_PRESS: f32 = 0.4;
pub const SEEK_SLOW: Duration = Duration::from_millis(1200);
pub const SEEK_FAST: Duration = Duration::from_millis(500);
const SEEK_RELEASE: f32 = 0.3;

pub const SEEK_AXIS: &CStr = c"/actions/watch/in/seek";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shortcut {
    PlayPause,
    SeekBack,
    SeekForward,
    VolumeUp,
    VolumeDown,
    Controls,
    Back,
    TurnLeft,
    TurnRight,
    Recentre,
    Stop,
}

impl Shortcut {
    pub const ALL: [Shortcut; 11] = [
        Shortcut::PlayPause,
        Shortcut::SeekBack,
        Shortcut::SeekForward,
        Shortcut::VolumeUp,
        Shortcut::VolumeDown,
        Shortcut::Controls,
        Shortcut::Back,
        Shortcut::TurnLeft,
        Shortcut::TurnRight,
        Shortcut::Recentre,
        Shortcut::Stop,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Shortcut::PlayPause => "playPause",
            Shortcut::SeekBack => "seekBack",
            Shortcut::SeekForward => "seekForward",
            Shortcut::VolumeUp => "volumeUp",
            Shortcut::VolumeDown => "volumeDown",
            Shortcut::Controls => "controls",
            Shortcut::Back => "back",
            Shortcut::TurnLeft => "turnLeft",
            Shortcut::TurnRight => "turnRight",
            Shortcut::Recentre => "recentre",
            Shortcut::Stop => "stop",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    PlayPause,
    Back,
    Controls,
    Point,
    Recentre,
    SeekBack,
    SeekForward,
    VolumeUp,
    VolumeDown,
    TurnLeft,
    TurnRight,
    Stop,
}

impl Action {
    pub const ALL: [Action; 12] = [
        Action::PlayPause,
        Action::Back,
        Action::Controls,
        Action::Point,
        Action::Recentre,
        Action::SeekBack,
        Action::SeekForward,
        Action::VolumeUp,
        Action::VolumeDown,
        Action::TurnLeft,
        Action::TurnRight,
        Action::Stop,
    ];

    pub fn path(self) -> &'static CStr {
        match self {
            Action::PlayPause => c"/actions/watch/in/play_pause",
            Action::Back => c"/actions/watch/in/back",
            Action::Controls => c"/actions/watch/in/controls",
            Action::Point => c"/actions/watch/in/point",
            Action::Recentre => c"/actions/watch/in/recentre",
            Action::SeekBack => c"/actions/watch/in/seek_back",
            Action::SeekForward => c"/actions/watch/in/seek_forward",
            Action::VolumeUp => c"/actions/watch/in/volume_up",
            Action::VolumeDown => c"/actions/watch/in/volume_down",
            Action::TurnLeft => c"/actions/watch/in/turn_left",
            Action::TurnRight => c"/actions/watch/in/turn_right",
            Action::Stop => c"/actions/watch/in/stop",
        }
    }

    fn repeats(self) -> Option<(Shortcut, Duration, Duration)> {
        let ms = Duration::from_millis;
        match self {
            Action::SeekBack => Some((Shortcut::SeekBack, SEEK_FAST, SEEK_FAST)),
            Action::SeekForward => Some((Shortcut::SeekForward, SEEK_FAST, SEEK_FAST)),
            Action::VolumeUp => Some((Shortcut::VolumeUp, ms(400), ms(250))),
            Action::VolumeDown => Some((Shortcut::VolumeDown, ms(400), ms(250))),
            Action::TurnLeft => Some((Shortcut::TurnLeft, ms(300), ms(300))),
            Action::TurnRight => Some((Shortcut::TurnRight, ms(300), ms(300))),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Buzz {
    Tick,
    Double,
}

#[derive(Debug, Default, PartialEq)]
pub struct Step {
    pub shortcuts: Vec<Shortcut>,
    pub buzz: Option<(Action, Buzz)>,
}

#[derive(Clone, Copy, Debug, Default)]
struct Track {
    armed: bool,
    since: Option<Instant>,
    due: Option<Instant>,
}

#[derive(Clone, Copy, Debug, Default)]
struct Stick {
    armed: bool,
    held: Option<(Shortcut, Instant)>,
}

#[derive(Debug, Default)]
pub struct Gestures {
    tracks: [Track; Action::ALL.len()],
    stick: Stick,
}

impl Gestures {
    pub fn step(&mut self, now: Instant, pressed: [Option<bool>; Action::ALL.len()], seek: Option<[f32; 2]>) -> Step {
        let mut out = Step::default();
        let mut stopped = false;
        for (t, (action, state)) in self.tracks.iter_mut().zip(Action::ALL.into_iter().zip(pressed)) {
            match state {
                None => *t = Track::default(),
                Some(true) if t.armed => {
                    t.armed = false;
                    t.since = Some(now);
                    t.due = None;
                    if let Some((s, after, _)) = action.repeats() {
                        out.shortcuts.push(s);
                        t.due = Some(now + after);
                    } else if action == Action::Recentre {
                        t.due = Some(now + HOLD);
                    } else if action == Action::Stop {
                        out.shortcuts.push(Shortcut::Stop);
                        out.buzz = Some((action, Buzz::Double));
                        t.since = None;
                        stopped = true;
                    }
                }
                Some(true) => {
                    let Some(due) = t.due.filter(|&d| now >= d) else { continue };
                    if let Some((s, _, every)) = action.repeats() {
                        out.shortcuts.push(s);
                        t.due = Some(next_after(due, every, now));
                    } else {
                        out.shortcuts.push(Shortcut::Recentre);
                        out.buzz = out.buzz.or(Some((action, Buzz::Tick)));
                        t.since = None;
                        t.due = None;
                    }
                }
                Some(false) => {
                    if let Some(since) = t.since.take() {
                        let tap = now.duration_since(since) < TAP;
                        let fires = match action {
                            Action::PlayPause if tap => Some(Shortcut::PlayPause),
                            Action::Back if tap => Some(Shortcut::Back),
                            Action::Controls if tap => Some(Shortcut::Controls),
                            Action::Point => Some(Shortcut::Controls),
                            _ => None,
                        };
                        out.shortcuts.extend(fires);
                    }
                    t.due = None;
                    t.armed = true;
                }
            }
        }
        if stopped {
            for t in &mut self.tracks {
                t.since = None;
                t.due = None;
            }
            self.stick = Stick::default();
        } else {
            self.seek(now, seek, &mut out.shortcuts);
        }
        out
    }

    fn seek(&mut self, now: Instant, at: Option<[f32; 2]>, out: &mut Vec<Shortcut>) {
        let Some([x, y]) = at else {
            self.stick = Stick::default();
            return;
        };
        let push = if x.abs() >= y.abs() { x } else { 0.0 };
        if let Some((s, last)) = self.stick.held {
            let along = if s == Shortcut::SeekForward { push } else { -push };
            if along >= SEEK_RELEASE {
                let every = seek_every(along);
                let due = last + every;
                if now >= due {
                    out.push(s);
                    self.stick.held = Some((s, if now - due < every { due } else { now }));
                }
                return;
            }
            self.stick.held = None;
        }
        if push.abs() < SEEK_RELEASE {
            self.stick.armed = true;
        } else if push.abs() >= SEEK_PRESS && self.stick.armed {
            let s = if push > 0.0 { Shortcut::SeekForward } else { Shortcut::SeekBack };
            out.push(s);
            self.stick = Stick { armed: false, held: Some((s, now)) };
        }
    }
}

fn seek_every(along: f32) -> Duration {
    let f = ((along - SEEK_PRESS) / (1.0 - SEEK_PRESS)).clamp(0.0, 1.0);
    let (slow, fast) = (SEEK_SLOW.as_millis() as f32, SEEK_FAST.as_millis() as f32);
    Duration::from_millis((slow - (slow - fast) * f).round() as u64)
}

fn next_after(due: Instant, every: Duration, now: Instant) -> Instant {
    let next = due + every;
    if next > now { next } else { now + every }
}

#[cfg(test)]
mod tests {
    use super::*;

    const N: usize = Action::ALL.len();
    const NONE: [Shortcut; 0] = [];

    fn at(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    fn down(actions: &[Action]) -> [Option<bool>; N] {
        Action::ALL.map(|a| Some(actions.contains(&a)))
    }

    fn ready(t: Instant) -> Gestures {
        let mut g = Gestures::default();
        assert_eq!(g.step(t, down(&[]), Some([0.0, 0.0])), Step::default());
        g
    }

    fn fired(g: &mut Gestures, t: Instant, ms: u64, actions: &[Action]) -> Vec<Shortcut> {
        g.step(at(t, ms), down(actions), Some([0.0, 0.0])).shortcuts
    }

    fn pushed(g: &mut Gestures, t: Instant, ms: u64, stick: [f32; 2]) -> Vec<Shortcut> {
        g.step(at(t, ms), down(&[]), Some(stick)).shortcuts
    }

    fn times(mut fire: impl FnMut(u64) -> Vec<Shortcut>, until: u64) -> Vec<u64> {
        (0..=until).step_by(10).filter(|&ms| !fire(ms).is_empty()).collect()
    }

    #[test]
    fn names_match_the_apps_list() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../app/shared/vr.ts");
        let ts = std::fs::read_to_string(path).expect("app/shared/vr.ts");
        let list = ts.split_once("VR_SHORTCUTS = [").and_then(|(_, rest)| rest.split_once(']')).expect("VR_SHORTCUTS in vr.ts").0;
        let names: Vec<&str> = list.split(',').map(|s| s.trim().trim_matches('\'')).filter(|s| !s.is_empty()).collect();
        assert_eq!(names, Shortcut::ALL.map(Shortcut::name));
    }

    #[test]
    fn taps_fire_on_release_and_long_presses_never() {
        let t = Instant::now();
        let mut g = ready(t);
        assert_eq!(fired(&mut g, t, 10, &[Action::PlayPause]), NONE);
        assert_eq!(fired(&mut g, t, 900, &[Action::PlayPause]), NONE, "held: nothing yet");
        assert_eq!(fired(&mut g, t, 910, &[]), NONE, "held past a tap");
        assert_eq!(fired(&mut g, t, 1000, &[Action::PlayPause]), NONE);
        assert_eq!(fired(&mut g, t, 1200, &[]), [Shortcut::PlayPause]);
        assert_eq!(fired(&mut g, t, 1300, &[Action::Back]), NONE);
        assert_eq!(fired(&mut g, t, 1400, &[]), [Shortcut::Back]);
        assert_eq!(fired(&mut g, t, 1500, &[Action::Controls]), NONE);
        assert_eq!(fired(&mut g, t, 1600, &[]), [Shortcut::Controls], "stick click");
        assert_eq!(fired(&mut g, t, 1700, &[Action::Controls]), NONE);
        assert_eq!(fired(&mut g, t, 3000, &[Action::Controls]), NONE, "a held stick click no longer recentres");
        assert_eq!(fired(&mut g, t, 3100, &[]), NONE);
    }

    #[test]
    fn holding_the_left_stick_up_or_down_recentres_and_a_flick_does_nothing() {
        let t = Instant::now();
        let mut g = ready(t);
        assert_eq!(fired(&mut g, t, 0, &[Action::Recentre]), NONE);
        assert_eq!(fired(&mut g, t, 200, &[]), NONE, "a flick");
        assert_eq!(fired(&mut g, t, 1000, &[Action::Recentre]), NONE);
        assert_eq!(fired(&mut g, t, 1599, &[Action::Recentre]), NONE);
        let s = g.step(at(t, 1600), down(&[Action::Recentre]), Some([0.0, 1.0]));
        assert_eq!(s, Step { shortcuts: vec![Shortcut::Recentre], buzz: Some((Action::Recentre, Buzz::Tick)) }, "fires while still held");
        assert_eq!(fired(&mut g, t, 3000, &[Action::Recentre]), NONE, "once");
        assert_eq!(fired(&mut g, t, 3100, &[]), NONE, "and nothing on release");
    }

    #[test]
    fn the_trigger_shows_the_controls_on_release() {
        let t = Instant::now();
        let mut g = ready(t);
        assert_eq!(fired(&mut g, t, 0, &[Action::Point]), NONE);
        assert_eq!(fired(&mut g, t, 2000, &[]), [Shortcut::Controls]);
    }

    #[test]
    fn volume_turn_and_trackpad_seek_repeat_while_held() {
        let t = Instant::now();
        let mut g = ready(t);
        assert_eq!(times(|ms| fired(&mut g, t, ms, &[Action::VolumeUp]), 1200), [0, 400, 650, 900, 1150]);
        let t = at(t, 2000);
        assert_eq!(fired(&mut g, t, 0, &[]), NONE);
        assert_eq!(times(|ms| fired(&mut g, t, 10 + ms, &[Action::TurnLeft]), 1000), [0, 300, 600, 900]);
        let t = at(t, 2000);
        assert_eq!(fired(&mut g, t, 0, &[]), NONE);
        assert_eq!(times(|ms| fired(&mut g, t, 10 + ms, &[Action::SeekForward]), 1600), [0, 500, 1000, 1500]);
        let t = at(t, 2000);
        assert_eq!(fired(&mut g, t, 0, &[]), NONE);
        assert_eq!(fired(&mut g, t, 10, &[Action::VolumeDown]), [Shortcut::VolumeDown]);
        assert_eq!(fired(&mut g, t, 1500, &[Action::VolumeDown]), [Shortcut::VolumeDown]);
        assert_eq!(fired(&mut g, t, 1600, &[Action::VolumeDown]), NONE);
        assert_eq!(fired(&mut g, t, 1750, &[Action::VolumeDown]), [Shortcut::VolumeDown]);
    }

    #[test]
    fn the_stick_seeks_once_on_a_flick_and_faster_the_further_it_is_held() {
        let t = Instant::now();
        let mut g = ready(t);
        assert_eq!(pushed(&mut g, t, 0, [-1.0, 0.1]), [Shortcut::SeekBack]);
        assert_eq!(pushed(&mut g, t, 100, [-0.2, 0.0]), NONE);
        assert_eq!(pushed(&mut g, t, 200, [0.0, 0.0]), NONE);
        let t = at(t, 1000);
        assert_eq!(times(|ms| pushed(&mut g, t, ms, [1.0, 0.0]), 1600), [0, 500, 1000, 1500]);
        assert_eq!(pushed(&mut g, t, 1700, [0.0, 0.0]), NONE);
        let t = at(t, 2000);
        assert_eq!(times(|ms| pushed(&mut g, t, ms, [0.4, 0.0]), 2500), [0, 1200, 2400]);
        assert_eq!(pushed(&mut g, t, 2600, [0.0, 0.0]), NONE);
        let t = at(t, 3000);
        assert_eq!(times(|ms| pushed(&mut g, t, ms, [0.7, 0.0]), 1800), [0, 850, 1700]);
        assert_eq!(pushed(&mut g, t, 1900, [0.0, 0.0]), NONE);
        let t = at(t, 2000);
        assert_eq!(pushed(&mut g, t, 0, [1.0, 0.0]), [Shortcut::SeekForward]);
        assert_eq!(pushed(&mut g, t, 600, [0.4, 0.0]), NONE, "not yet 1200 ms");
        assert_eq!(pushed(&mut g, t, 1200, [0.4, 0.0]), [Shortcut::SeekForward]);
        assert_eq!(pushed(&mut g, t, 1300, [0.0, 0.0]), NONE);
        assert_eq!(pushed(&mut g, t, 1400, [0.35, 0.0]), NONE);
    }

    #[test]
    fn up_and_down_on_the_stick_never_seek() {
        let t = Instant::now();
        let mut g = ready(t);
        assert_eq!(pushed(&mut g, t, 0, [0.6, 0.9]), NONE);
        assert_eq!(pushed(&mut g, t, 2000, [-0.5, -1.0]), NONE);
        assert_eq!(pushed(&mut g, t, 2100, [0.0, 0.0]), NONE);
    }

    #[test]
    fn stop_fires_at_once_and_its_buttons_never_tap() {
        let t = Instant::now();
        let mut g = ready(t);
        assert_eq!(fired(&mut g, t, 0, &[Action::PlayPause]), NONE);
        let s = g.step(at(t, 80), down(&[Action::PlayPause, Action::Back, Action::Stop]), Some([0.0, 0.0]));
        assert_eq!(s, Step { shortcuts: vec![Shortcut::Stop], buzz: Some((Action::Stop, Buzz::Double)) });
        assert_eq!(fired(&mut g, t, 150, &[Action::Back]), NONE, "A came up: no play");
        assert_eq!(fired(&mut g, t, 200, &[]), NONE, "B came up: no back");
        assert_eq!(fired(&mut g, t, 300, &[Action::PlayPause]), NONE);
        assert_eq!(fired(&mut g, t, 400, &[]), [Shortcut::PlayPause]);
    }

    #[test]
    fn input_going_away_drops_the_press_and_a_button_held_back_never_fires() {
        let t = Instant::now();
        let mut g = ready(t);
        assert_eq!(fired(&mut g, t, 0, &[Action::Recentre, Action::VolumeUp]), [Shortcut::VolumeUp]);
        assert_eq!(g.step(at(t, 100), [None; N], None), Step::default());
        assert_eq!(g.step(at(t, 2000), down(&[Action::Recentre, Action::VolumeUp, Action::PlayPause]), Some([1.0, 0.0])).shortcuts, NONE, "held when it came back");
        assert_eq!(fired(&mut g, t, 2100, &[]), NONE, "and let go");
        let mut g = Gestures::default();
        assert_eq!(g.step(t, down(&[Action::PlayPause]), Some([-1.0, 0.0])).shortcuts, NONE);
        assert_eq!(fired(&mut g, t, 100, &[]), NONE);
        assert_eq!(fired(&mut g, t, 200, &[Action::PlayPause]), NONE);
        assert_eq!(fired(&mut g, t, 300, &[]), [Shortcut::PlayPause]);
        assert_eq!(pushed(&mut g, t, 400, [-1.0, 0.0]), [Shortcut::SeekBack]);
    }

    #[test]
    fn the_manifest_and_bindings_agree() {
        let manifest = include_str!("../input/actions.json");
        let declared: Vec<&str> = quoted_after(manifest, "\"name\":");
        for path in Action::ALL.map(Action::path).into_iter().chain([SEEK_AXIS]) {
            assert!(declared.contains(&path.to_str().unwrap()), "{path:?} is not in actions.json");
        }
        for (file, bindings) in [
            ("oculus_touch", include_str!("../input/bindings_oculus_touch.json")),
            ("knuckles", include_str!("../input/bindings_knuckles.json")),
            ("vive_controller", include_str!("../input/bindings_vive_controller.json")),
            ("generic_hmd", include_str!("../input/bindings_generic_hmd.json")),
        ] {
            let outputs = quoted_after(bindings, "\"output\":");
            assert!(!outputs.is_empty(), "{file}");
            for o in outputs {
                assert!(declared.contains(&o), "{file} binds {o}, which actions.json does not declare");
            }
            assert!(manifest.contains(&format!("\"binding_url\": \"bindings_{file}.json\"")), "{file} is not a default binding");
        }
    }

    fn quoted_after<'a>(json: &'a str, key: &str) -> Vec<&'a str> {
        json.split(key).skip(1).filter_map(|rest| rest.split('"').nth(1)).collect()
    }
}
