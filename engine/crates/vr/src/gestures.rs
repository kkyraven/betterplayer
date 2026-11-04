use std::ffi::CStr;
use std::time::{Duration, Instant};

pub const TAP: Duration = Duration::from_millis(450);
pub const SEEK_PRESS: f32 = 0.4;
pub const SEEK_SLOW: Duration = Duration::from_millis(1200);
pub const SEEK_FAST: Duration = Duration::from_millis(500);
const SEEK_RELEASE: f32 = 0.3;

pub const SEEK_AXIS: &CStr = c"/actions/watch/in/seek";
pub const WHEEL_AXIS: &CStr = c"/actions/watch/in/wheel";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shortcut {
    PlayPause,
    SeekBack,
    SeekForward,
    VolumeUp,
    VolumeDown,
    Controls,
    Back,
    Stop,
    PointLeft,
    PointRight,
    ReleaseLeft,
    ReleaseRight,
    GripLeft,
    GripRight,
    GripReleaseLeft,
    GripReleaseRight,
}

impl Shortcut {
    pub const ALL: [Shortcut; 16] = [
        Shortcut::PlayPause,
        Shortcut::SeekBack,
        Shortcut::SeekForward,
        Shortcut::VolumeUp,
        Shortcut::VolumeDown,
        Shortcut::Controls,
        Shortcut::Back,
        Shortcut::Stop,
        Shortcut::PointLeft,
        Shortcut::PointRight,
        Shortcut::ReleaseLeft,
        Shortcut::ReleaseRight,
        Shortcut::GripLeft,
        Shortcut::GripRight,
        Shortcut::GripReleaseLeft,
        Shortcut::GripReleaseRight,
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
            Shortcut::Stop => "stop",
            Shortcut::PointLeft => "pointLeft",
            Shortcut::PointRight => "pointRight",
            Shortcut::ReleaseLeft => "releaseLeft",
            Shortcut::ReleaseRight => "releaseRight",
            Shortcut::GripLeft => "gripLeft",
            Shortcut::GripRight => "gripRight",
            Shortcut::GripReleaseLeft => "gripReleaseLeft",
            Shortcut::GripReleaseRight => "gripReleaseRight",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    PlayPause,
    Back,
    Controls,
    PointLeft,
    PointRight,
    GripLeft,
    GripRight,
    SeekBack,
    SeekForward,
    VolumeUp,
    VolumeDown,
    Stop,
}

impl Action {
    pub const ALL: [Action; 12] = [
        Action::PlayPause,
        Action::Back,
        Action::Controls,
        Action::PointLeft,
        Action::PointRight,
        Action::GripLeft,
        Action::GripRight,
        Action::SeekBack,
        Action::SeekForward,
        Action::VolumeUp,
        Action::VolumeDown,
        Action::Stop,
    ];

    pub fn path(self) -> &'static CStr {
        match self {
            Action::PlayPause => c"/actions/watch/in/play_pause",
            Action::Back => c"/actions/watch/in/back",
            Action::Controls => c"/actions/watch/in/controls",
            Action::PointLeft => c"/actions/watch/in/point_left",
            Action::PointRight => c"/actions/watch/in/point_right",
            Action::GripLeft => c"/actions/watch/in/grip_left",
            Action::GripRight => c"/actions/watch/in/grip_right",
            Action::SeekBack => c"/actions/watch/in/seek_back",
            Action::SeekForward => c"/actions/watch/in/seek_forward",
            Action::VolumeUp => c"/actions/watch/in/volume_up",
            Action::VolumeDown => c"/actions/watch/in/volume_down",
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
            _ => None,
        }
    }

    fn trigger(self) -> Option<(Shortcut, Shortcut)> {
        match self {
            Action::PointLeft => Some((Shortcut::PointLeft, Shortcut::ReleaseLeft)),
            Action::PointRight => Some((Shortcut::PointRight, Shortcut::ReleaseRight)),
            Action::GripLeft => Some((Shortcut::GripLeft, Shortcut::GripReleaseLeft)),
            Action::GripRight => Some((Shortcut::GripRight, Shortcut::GripReleaseRight)),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Buzz {
    Double,
    Open,
    Hover,
    Pick,
    Detent,
    Notch,
}

impl Buzz {
    pub fn from_name(name: &str) -> Option<Buzz> {
        Some(match name {
            "open" => Buzz::Open,
            "hover" => Buzz::Hover,
            "pick" => Buzz::Pick,
            "detent" => Buzz::Detent,
            "notch" => Buzz::Notch,
            _ => return None,
        })
    }
}

#[derive(Debug, Default, PartialEq)]
pub struct Step {
    pub shortcuts: Vec<Shortcut>,
    pub buzz: Option<(Action, Buzz)>,
    pub drag: Option<bool>,
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
    dragging: bool,
}

impl Gestures {
    pub fn step(&mut self, now: Instant, pressed: [Option<bool>; Action::ALL.len()], seek: Option<[f32; 2]>) -> Step {
        let mut out = Step::default();
        let mut stopped = false;
        for (t, (action, state)) in self.tracks.iter_mut().zip(Action::ALL.into_iter().zip(pressed)) {
            match state {
                None => {
                    if t.since.is_some()
                        && let Some((_, up)) = action.trigger()
                    {
                        out.shortcuts.push(up);
                    }
                    *t = Track::default()
                }
                Some(true) if t.armed => {
                    t.armed = false;
                    t.since = Some(now);
                    t.due = None;
                    if let Some((s, after, _)) = action.repeats() {
                        out.shortcuts.push(s);
                        t.due = Some(now + after);
                    } else if let Some((down, _)) = action.trigger() {
                        out.shortcuts.push(down);
                    } else if action == Action::Stop {
                        out.shortcuts.push(Shortcut::Stop);
                        out.buzz = Some((action, Buzz::Double));
                        t.since = None;
                        stopped = true;
                    }
                }
                Some(true) => {
                    let (Some(due), Some((s, _, every))) = (t.due.filter(|&d| now >= d), action.repeats()) else { continue };
                    out.shortcuts.push(s);
                    t.due = Some(next_after(due, every, now));
                }
                Some(false) => {
                    if let Some(since) = t.since.take() {
                        let tap = now.duration_since(since) < TAP;
                        let fires = match action {
                            Action::PlayPause if tap => Some(Shortcut::PlayPause),
                            Action::Back if tap => Some(Shortcut::Back),
                            Action::Controls if tap => Some(Shortcut::Controls),
                            _ => action.trigger().map(|(_, up)| up),
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
        let play = &self.tracks[Action::ALL.iter().position(|a| *a == Action::PlayPause).unwrap_or(0)];
        let held = play.since.is_some_and(|since| now.duration_since(since) >= TAP);
        if held != self.dragging {
            self.dragging = held;
            out.drag = Some(held);
            if held {
                out.buzz.get_or_insert((Action::PlayPause, Buzz::Open));
            }
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
        let buzzes = ts.split_once("VR_BUZZES = [").and_then(|(_, rest)| rest.split_once(']')).expect("VR_BUZZES in vr.ts").0;
        for name in buzzes.split(',').map(|s| s.trim().trim_matches('\'')) {
            assert!(Buzz::from_name(name).is_some(), "VR_BUZZES has {name}, which the engine does not play");
        }
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
    fn holding_play_drags_until_it_comes_up_or_stop() {
        let t = Instant::now();
        let mut g = ready(t);
        let drag = |g: &mut Gestures, ms, actions: &[Action]| g.step(at(t, ms), down(actions), Some([0.0, 0.0]));
        assert_eq!(drag(&mut g, 0, &[Action::PlayPause]).drag, None);
        assert_eq!(drag(&mut g, 440, &[Action::PlayPause]).drag, None, "still a tap");
        assert_eq!(drag(&mut g, 460, &[Action::PlayPause]), Step { drag: Some(true), buzz: Some((Action::PlayPause, Buzz::Open)), ..Step::default() });
        assert_eq!(drag(&mut g, 900, &[Action::PlayPause]).drag, None);
        assert_eq!(drag(&mut g, 950, &[]), Step { drag: Some(false), ..Step::default() }, "no play on release");
        assert_eq!(drag(&mut g, 1000, &[Action::PlayPause]).drag, None);
        assert_eq!(drag(&mut g, 1500, &[Action::PlayPause]).drag, Some(true));
        assert_eq!(drag(&mut g, 1600, &[Action::PlayPause, Action::Back, Action::Stop]).drag, Some(false));
        assert_eq!(drag(&mut g, 2500, &[Action::PlayPause]).drag, None, "not again until it comes up");
    }

    #[test]
    fn each_trigger_and_grip_fires_on_press_and_on_release() {
        let t = Instant::now();
        let mut g = ready(t);
        assert_eq!(fired(&mut g, t, 0, &[Action::PointRight]), [Shortcut::PointRight]);
        assert_eq!(fired(&mut g, t, 2000, &[Action::PointRight]), NONE, "held: nothing more");
        assert_eq!(fired(&mut g, t, 2100, &[]), [Shortcut::ReleaseRight], "a long hold still releases");
        assert_eq!(fired(&mut g, t, 2200, &[Action::PointLeft]), [Shortcut::PointLeft]);
        assert_eq!(fired(&mut g, t, 2250, &[]), [Shortcut::ReleaseLeft]);
        assert_eq!(fired(&mut g, t, 2260, &[Action::GripRight]), [Shortcut::GripRight], "a grip as a trigger");
        assert_eq!(fired(&mut g, t, 2270, &[]), [Shortcut::GripReleaseRight]);
        assert_eq!(fired(&mut g, t, 2300, &[Action::PointLeft]), [Shortcut::PointLeft]);
        assert_eq!(g.step(at(t, 2400), [None; N], None).shortcuts, [Shortcut::ReleaseLeft]);
        assert_eq!(g.step(at(t, 2500), [None; N], None).shortcuts, NONE);
    }

    #[test]
    fn volume_and_trackpad_seek_repeat_while_held() {
        let t = Instant::now();
        let mut g = ready(t);
        assert_eq!(times(|ms| fired(&mut g, t, ms, &[Action::VolumeUp]), 1200), [0, 400, 650, 900, 1150]);
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
        assert_eq!(s, Step { shortcuts: vec![Shortcut::Stop], buzz: Some((Action::Stop, Buzz::Double)), drag: None });
        assert_eq!(fired(&mut g, t, 150, &[Action::Back]), NONE, "A came up: no play");
        assert_eq!(fired(&mut g, t, 200, &[]), NONE, "B came up: no back");
        assert_eq!(fired(&mut g, t, 300, &[Action::PlayPause]), NONE);
        assert_eq!(fired(&mut g, t, 400, &[]), [Shortcut::PlayPause]);
    }

    #[test]
    fn input_going_away_drops_the_press_and_a_button_held_back_never_fires() {
        let t = Instant::now();
        let mut g = ready(t);
        assert_eq!(fired(&mut g, t, 0, &[Action::Back, Action::VolumeUp]), [Shortcut::VolumeUp]);
        assert_eq!(g.step(at(t, 100), [None; N], None), Step::default());
        assert_eq!(g.step(at(t, 2000), down(&[Action::Back, Action::VolumeUp, Action::PlayPause]), Some([1.0, 0.0])).shortcuts, NONE, "held when it came back");
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
        for path in Action::ALL.map(Action::path).into_iter().chain([SEEK_AXIS, WHEEL_AXIS]) {
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
