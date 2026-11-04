use std::ffi::{CStr, CString};
use std::path::PathBuf;
use std::time::Instant;

use crate::Drag;
use crate::gestures::{Action, Buzz, Gestures, SEEK_AXIS, Shortcut, WHEEL_AXIS};
use crate::maths::Pose;
use crate::runtime::{Session, vr};
use crate::sys::*;

const APP_KEY: &str = "com.kinkyraven.betterplayer";
const ACTIONS: &str = include_str!("../input/actions.json");
const CONTROLLERS: [(&str, &str); 3] = [
    ("bindings_oculus_touch.json", include_str!("../input/bindings_oculus_touch.json")),
    ("bindings_knuckles.json", include_str!("../input/bindings_knuckles.json")),
    ("bindings_vive_controller.json", include_str!("../input/bindings_vive_controller.json")),
];
const HEADSET: &str = include_str!("../input/bindings_generic_hmd.json");
const HEADSETS: [&str; 7] = ["generic_hmd", "rift", "indexhmd", "vive", "vive_pro", "vive_cosmos", "holographic_hmd"];

const BUZZ_HZ: f32 = 160.0;
const TICK_HZ: f32 = 230.0;

#[derive(Debug, Default)]
pub(crate) struct Polled {
    pub shortcuts: Vec<Shortcut>,
    pub worn: Option<bool>,
    pub hands: [Option<Pose>; 2],
    pub drag: Option<Drag>,
    pub stick: Option<[f32; 2]>,
}

pub(crate) struct Input {
    table: &'static VR_IVRInput_FnTable,
    sets: [VRActiveActionSet_t; 2],
    actions: [VRActionHandle_t; Action::ALL.len()],
    seek: VRActionHandle_t,
    wheel: VRActionHandle_t,
    aims: [VRActionHandle_t; 2],
    on_head: VRActionHandle_t,
    haptic: VRActionHandle_t,
    hands: [VRInputValueHandle_t; 2],
    gestures: Gestures,
    worn: Option<bool>,
    said_update: bool,
    said_load: bool,
}

impl Input {
    pub(crate) fn new(session: &Session) -> Result<Input, String> {
        let table: &VR_IVRInput_FnTable = unsafe { session.table(IVRInput_FnTable)? };
        let (app, manifest) = write_files().map_err(|e| format!("writing the controller bindings: {e}"))?;
        if let Err(e) = identify(session, &app) {
            eprintln!("bp-vr: SteamVR could not give Better Player its own app key ({e}); controllers may do nothing");
        }
        let manifest = manifest.to_str().ok_or("the temp folder's path is not Unicode")?;
        let manifest = CString::new(manifest).map_err(|e| e.to_string())?;
        check("SetActionManifestPath", vr!(table, SetActionManifestPath(manifest.as_ptr())))?;
        let set = |name: &CStr| {
            let mut h = k_ulInvalidActionSetHandle;
            check("GetActionSetHandle", vr!(table, GetActionSetHandle(name.as_ptr(), &mut h))).map(|_| h)
        };
        let action = |name: &CStr| {
            let mut h = k_ulInvalidActionHandle;
            check("GetActionHandle", vr!(table, GetActionHandle(name.as_ptr(), &mut h))).map(|_| h)
        };
        let source = |path: &CStr| {
            let mut h = k_ulInvalidInputValueHandle;
            check("GetInputSourceHandle", vr!(table, GetInputSourceHandle(path.as_ptr(), &mut h))).map(|_| h)
        };
        let active = |handle| VRActiveActionSet_t { ulActionSet: handle, ..Default::default() };
        let sets = [active(set(c"/actions/watch")?), active(set(c"/actions/headset")?)];
        let mut actions = [k_ulInvalidActionHandle; Action::ALL.len()];
        for (h, a) in actions.iter_mut().zip(Action::ALL) {
            *h = action(a.path())?;
        }
        Ok(Input {
            table,
            sets,
            actions,
            seek: action(SEEK_AXIS)?,
            wheel: action(WHEEL_AXIS)?,
            aims: [action(c"/actions/watch/in/aim_left")?, action(c"/actions/watch/in/aim_right")?],
            on_head: action(c"/actions/headset/in/on_head")?,
            haptic: action(c"/actions/watch/out/haptic")?,
            hands: [source(c"/user/hand/left")?, source(c"/user/hand/right")?],
            gestures: Gestures::default(),
            worn: None,
            said_update: false,
            said_load: false,
        })
    }

    pub(crate) fn poll(&mut self, now: Instant) -> Polled {
        let t = self.table;
        let e = vr!(t, UpdateActionState(self.sets.as_mut_ptr(), size_of::<VRActiveActionSet_t>() as u32, self.sets.len() as u32));
        if e != EVRInputError::VRInputError_None {
            if !std::mem::replace(&mut self.said_update, true) {
                eprintln!("bp-vr: SteamVR Input UpdateActionState failed ({}); controller shortcuts wait for it", e.0);
            }
            self.gestures.step(now, [None; Action::ALL.len()], None);
            return Polled::default();
        }
        let mut data = [InputDigitalActionData_t::default(); Action::ALL.len()];
        let mut pressed = [None; Action::ALL.len()];
        for ((h, d), p) in self.actions.iter().zip(&mut data).zip(&mut pressed) {
            *p = self.digital(*h, d);
        }
        let seek = self.analog(self.seek);
        let step = self.gestures.step(now, pressed, seek);
        let origin = |action| data[Action::ALL.iter().position(|a| *a == action).unwrap_or(0)].activeOrigin;
        if let Some((action, buzz)) = step.buzz {
            self.play(self.device(origin(action)), buzz);
        }
        let drag = match step.drag {
            Some(true) => {
                let device = self.device(origin(Action::PlayPause));
                self.hands.iter().position(|h| *h == device).map(Drag::Start)
            }
            Some(false) => Some(Drag::End),
            None => None,
        };
        let mut d = InputDigitalActionData_t::default();
        let worn = self.digital(self.on_head, &mut d).filter(|w| self.worn != Some(*w));
        if worn.is_some() {
            self.worn = worn;
        }
        let stick = self.analog(self.wheel).filter(|[x, y]| *x != 0.0 || *y != 0.0).or(seek);
        Polled { shortcuts: step.shortcuts, worn, hands: self.aims.map(|a| self.aim(a)), drag, stick }
    }

    fn analog(&self, action: VRActionHandle_t) -> Option<[f32; 2]> {
        let mut d = InputAnalogActionData_t::default();
        let e = vr!(self.table, GetAnalogActionData(action, &mut d, size_of::<InputAnalogActionData_t>() as u32, k_ulInvalidInputValueHandle));
        (e == EVRInputError::VRInputError_None && d.bActive).then_some([d.x, d.y])
    }

    fn aim(&self, action: VRActionHandle_t) -> Option<Pose> {
        let mut d = InputPoseActionData_t::default();
        let e = vr!(
            self.table,
            GetPoseActionDataForNextFrame(action, ETrackingUniverseOrigin::TrackingUniverseStanding, &mut d, size_of::<InputPoseActionData_t>() as u32, k_ulInvalidInputValueHandle)
        );
        (e == EVRInputError::VRInputError_None && d.bActive && d.pose.bPoseIsValid).then_some(Pose(d.pose.mDeviceToAbsoluteTracking.m))
    }

    pub(crate) fn load_failed(&mut self, what: &str) {
        if !std::mem::replace(&mut self.said_load, true) {
            eprintln!("bp-vr: SteamVR Input could not load {what}; some controller shortcuts may not work");
        }
    }

    fn digital(&self, action: VRActionHandle_t, d: &mut InputDigitalActionData_t) -> Option<bool> {
        let e = vr!(self.table, GetDigitalActionData(action, d, size_of::<InputDigitalActionData_t>() as u32, k_ulInvalidInputValueHandle));
        (e == EVRInputError::VRInputError_None && d.bActive).then_some(d.bState)
    }

    fn device(&self, origin: VRInputValueHandle_t) -> VRInputValueHandle_t {
        let mut info: InputOriginInfo_t = unsafe { std::mem::zeroed() };
        let found = origin != k_ulInvalidInputValueHandle
            && vr!(self.table, GetOriginTrackedDeviceInfo(origin, &mut info, size_of::<InputOriginInfo_t>() as u32)) == EVRInputError::VRInputError_None;
        if found { info.devicePath } else { k_ulInvalidInputValueHandle }
    }

    pub(crate) fn buzz_hand(&self, hand: usize, buzz: Buzz) {
        if let Some(&device) = self.hands.get(hand) {
            self.play(device, buzz);
        }
    }

    fn play(&self, device: VRInputValueHandle_t, buzz: Buzz) {
        let pulses: &[(f32, f32, f32, f32)] = match buzz {
            Buzz::Double => &[(0.0, 0.05, BUZZ_HZ, 0.8), (0.12, 0.05, BUZZ_HZ, 0.8)],
            Buzz::Open => &[(0.0, 0.04, BUZZ_HZ, 0.35)],
            Buzz::Hover => &[(0.0, 0.012, TICK_HZ, 0.25)],
            Buzz::Pick => &[(0.0, 0.025, BUZZ_HZ, 0.7)],
            Buzz::Detent => &[(0.0, 0.018, TICK_HZ, 0.5)],
            Buzz::Notch => &[(0.0, 0.01, TICK_HZ, 0.15)],
        };
        for &(start, length, pitch, strength) in pulses {
            vr!(self.table, TriggerHapticVibrationAction(self.haptic, start, length, pitch, strength, device));
        }
    }
}

fn identify(session: &Session, app: &std::path::Path) -> Result<(), String> {
    let table: &VR_IVRApplications_FnTable = unsafe { session.table(IVRApplications_FnTable)? };
    let app = CString::new(app.to_str().ok_or("the temp folder's path is not Unicode")?).map_err(|e| e.to_string())?;
    let key = CString::new(APP_KEY).map_err(|e| e.to_string())?;
    let e = vr!(table, AddApplicationManifest(app.as_ptr(), true));
    if e != EVRApplicationError::VRApplicationError_None {
        return Err(format!("AddApplicationManifest failed ({})", e.0));
    }
    let e = vr!(table, IdentifyApplication(std::process::id(), key.as_ptr()));
    if e != EVRApplicationError::VRApplicationError_None {
        return Err(format!("IdentifyApplication failed ({})", e.0));
    }
    Ok(())
}

fn check(call: &str, e: EVRInputError) -> Result<(), String> {
    if e == EVRInputError::VRInputError_None { Ok(()) } else { Err(format!("SteamVR Input {call} failed ({})", e.0)) }
}

fn write_files() -> std::io::Result<(PathBuf, PathBuf)> {
    let dir = std::env::temp_dir().join("better-player-vr-input");
    std::fs::create_dir_all(&dir)?;
    let headsets = HEADSETS.map(|kind| (format!("bindings_{kind}.json"), HEADSET.replace("\"generic_hmd\"", &format!("\"{kind}\""))));
    let actions = dir.join("actions.json");
    let app = app_manifest(&actions, &std::env::current_exe()?);
    let files = CONTROLLERS
        .iter()
        .map(|&(name, text)| (name.to_owned(), text.to_owned()))
        .chain(headsets)
        .chain([("actions.json".to_owned(), ACTIONS.to_owned()), ("betterplayer.vrmanifest".to_owned(), app)]);
    for (name, text) in files {
        let path = dir.join(name);
        if std::fs::read(&path).ok().as_deref() != Some(text.as_bytes()) {
            std::fs::write(&path, text)?;
        }
    }
    Ok((dir.join("betterplayer.vrmanifest"), actions))
}

fn app_manifest(actions: &std::path::Path, exe: &std::path::Path) -> String {
    let json = |p: &std::path::Path| p.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        r#"{{"source":"builtin","applications":[{{"app_key":"{APP_KEY}","launch_type":"binary","binary_path_windows":"{}","action_manifest_path":"{}","strings":{{"en_us":{{"name":"Better Player"}}}}}}]}}"#,
        json(exe),
        json(actions)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn the_app_manifest_points_at_the_action_manifest() {
        let text = app_manifest(Path::new(r"C:\Temp\bp\actions.json"), Path::new(r#"C:\a "b"\electron.exe"#));
        assert!(text.contains(r#""app_key":"com.kinkyraven.betterplayer""#));
        assert!(text.contains(r#""action_manifest_path":"C:\\Temp\\bp\\actions.json""#));
        assert!(text.contains(r#""binary_path_windows":"C:\\a \"b\"\\electron.exe""#));
    }
}
