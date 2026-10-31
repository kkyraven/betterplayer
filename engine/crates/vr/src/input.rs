use std::ffi::{CStr, CString};
use std::path::PathBuf;
use std::time::Instant;

use crate::gestures::{Action, Buzz, Gestures, SEEK_AXIS, Shortcut};
use crate::runtime::{Session, vr};
use crate::sys::*;

const ACTIONS: &str = include_str!("../input/actions.json");
const CONTROLLERS: [(&str, &str); 3] = [
    ("bindings_oculus_touch.json", include_str!("../input/bindings_oculus_touch.json")),
    ("bindings_knuckles.json", include_str!("../input/bindings_knuckles.json")),
    ("bindings_vive_controller.json", include_str!("../input/bindings_vive_controller.json")),
];
const HEADSET: &str = include_str!("../input/bindings_generic_hmd.json");
const HEADSETS: [&str; 7] = ["generic_hmd", "rift", "indexhmd", "vive", "vive_pro", "vive_cosmos", "holographic_hmd"];

const BUZZ_HZ: f32 = 160.0;

#[derive(Debug, Default)]
pub(crate) struct Polled {
    pub shortcuts: Vec<Shortcut>,
    pub worn: Option<bool>,
}

pub(crate) struct Input {
    table: &'static VR_IVRInput_FnTable,
    sets: [VRActiveActionSet_t; 2],
    actions: [VRActionHandle_t; Action::ALL.len()],
    seek: VRActionHandle_t,
    on_head: VRActionHandle_t,
    haptic: VRActionHandle_t,
    gestures: Gestures,
    worn: Option<bool>,
    said_update: bool,
    said_load: bool,
}

impl Input {
    pub(crate) fn new(session: &Session) -> Result<Input, String> {
        let table: &VR_IVRInput_FnTable = unsafe { session.table(IVRInput_FnTable)? };
        let manifest = write_files().map_err(|e| format!("writing the controller bindings: {e}"))?;
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
            on_head: action(c"/actions/headset/in/on_head")?,
            haptic: action(c"/actions/watch/out/haptic")?,
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
        let mut seek = InputAnalogActionData_t::default();
        let e = vr!(self.table, GetAnalogActionData(self.seek, &mut seek, size_of::<InputAnalogActionData_t>() as u32, k_ulInvalidInputValueHandle));
        let seek = (e == EVRInputError::VRInputError_None && seek.bActive).then_some([seek.x, seek.y]);
        let step = self.gestures.step(now, pressed, seek);
        if let Some((action, buzz)) = step.buzz {
            let i = Action::ALL.iter().position(|a| *a == action).unwrap_or(0);
            self.buzz(data[i].activeOrigin, buzz);
        }
        let mut d = InputDigitalActionData_t::default();
        let worn = self.digital(self.on_head, &mut d).filter(|w| self.worn != Some(*w));
        if worn.is_some() {
            self.worn = worn;
        }
        Polled { shortcuts: step.shortcuts, worn }
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

    fn buzz(&self, origin: VRInputValueHandle_t, buzz: Buzz) {
        let t = self.table;
        let mut info: InputOriginInfo_t = unsafe { std::mem::zeroed() };
        let found = origin != k_ulInvalidInputValueHandle
            && vr!(t, GetOriginTrackedDeviceInfo(origin, &mut info, size_of::<InputOriginInfo_t>() as u32)) == EVRInputError::VRInputError_None;
        let hand = if found { info.devicePath } else { k_ulInvalidInputValueHandle };
        let pulses: &[(f32, f32, f32)] = match buzz {
            Buzz::Tick => &[(0.0, 0.03, 0.5)],
            Buzz::Double => &[(0.0, 0.05, 0.8), (0.12, 0.05, 0.8)],
        };
        for &(start, length, strength) in pulses {
            vr!(t, TriggerHapticVibrationAction(self.haptic, start, length, BUZZ_HZ, strength, hand));
        }
    }
}

fn check(call: &str, e: EVRInputError) -> Result<(), String> {
    if e == EVRInputError::VRInputError_None { Ok(()) } else { Err(format!("SteamVR Input {call} failed ({})", e.0)) }
}

fn write_files() -> std::io::Result<PathBuf> {
    let dir = std::env::temp_dir().join("better-player-vr-input");
    std::fs::create_dir_all(&dir)?;
    let headsets = HEADSETS.map(|kind| (format!("bindings_{kind}.json"), HEADSET.replace("\"generic_hmd\"", &format!("\"{kind}\""))));
    let files = CONTROLLERS.iter().map(|&(name, text)| (name.to_owned(), text.to_owned())).chain(headsets).chain([("actions.json".to_owned(), ACTIONS.to_owned())]);
    for (name, text) in files {
        let path = dir.join(name);
        if std::fs::read(&path).ok().as_deref() != Some(text.as_bytes()) {
            std::fs::write(&path, text)?;
        }
    }
    Ok(dir.join("actions.json"))
}
