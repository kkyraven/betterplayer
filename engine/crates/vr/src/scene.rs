use std::ffi::c_void;
use std::time::Instant;

use crate::input::Input;
use crate::presence::signal_of;
use crate::runtime::{Session, connected_table, device_string, head_pose, output_luid, vr};
use crate::sys::*;
use crate::{Pose, Presence, Shortcut, Signal};

#[derive(Clone, Copy, Debug)]
pub struct Eye {
    pub tangents: [f32; 4],
    pub to_head: Pose,
}

pub enum Frame {
    Head(Pose),
    Untracked,
    Unfocused,
}

#[derive(Default, Debug)]
pub struct Events {
    pub quit: bool,
    pub mounted: Option<bool>,
    pub lost_tracking: bool,
    pub shortcuts: Vec<Shortcut>,
    pub presses: u32,
    pub focused: bool,
    pub eyes_changed: bool,
    pub space_changed: bool,
}

pub struct Scene {
    system: &'static VR_IVRSystem_FnTable,
    compositor: &'static VR_IVRCompositor_FnTable,
    presence: Presence,
    input: Option<Input>,
    focused: bool,
    dashboard: bool,
    _session: Session,
}

impl Scene {
    pub fn start() -> Result<Scene, String> {
        let session = Session::connect(EVRApplicationType::VRApplication_Scene)?;
        let system: &VR_IVRSystem_FnTable = unsafe { session.table(IVRSystem_FnTable)? };
        let compositor: &VR_IVRCompositor_FnTable = unsafe { session.table(IVRCompositor_FnTable)? };
        vr!(compositor, SetTrackingSpace(ETrackingUniverseOrigin::TrackingUniverseStanding));
        let input = Input::new(&session).inspect_err(|e| eprintln!("bp-vr: controller shortcuts are off: {e}")).ok();
        Ok(Scene { system, compositor, presence: Presence::default(), input, focused: true, dashboard: false, _session: session })
    }

    pub fn adapter(&self) -> u64 {
        output_luid(self.system)
    }

    pub fn render_size(&self) -> (u32, u32) {
        let (mut w, mut h) = (0, 0);
        vr!(self.system, GetRecommendedRenderTargetSize(&mut w, &mut h));
        (w.max(1), h.max(1))
    }

    pub fn hmd_name(&self) -> String {
        device_string(self.system, k_unTrackedDeviceIndex_Hmd, ETrackedDeviceProperty::Prop_ModelNumber_String)
    }

    pub fn refresh_hz(&self) -> f32 {
        let mut error = ETrackedPropertyError::default();
        vr!(self.system, GetFloatTrackedDeviceProperty(k_unTrackedDeviceIndex_Hmd, ETrackedDeviceProperty::Prop_DisplayFrequency_Float, &mut error))
    }

    pub fn eye(&self, index: usize) -> Eye {
        let e = EVREye(index as i32);
        let (mut l, mut r, mut t, mut b) = (0.0, 0.0, 0.0, 0.0);
        vr!(self.system, GetProjectionRaw(e, &mut l, &mut r, &mut t, &mut b));
        Eye { tangents: [l, r, t, b], to_head: Pose(vr!(self.system, GetEyeToHeadTransform(e)).m) }
    }

    pub fn wait(&mut self) -> Result<Frame, String> {
        let mut poses = [TrackedDevicePose_t::default(); 1];
        let e = vr!(self.compositor, WaitGetPoses(poses.as_mut_ptr(), 1, std::ptr::null_mut(), 0));
        match e {
            EVRCompositorError::VRCompositorError_None => {
                let tracked = poses[0].bPoseIsValid;
                self.presence.signal(Signal::Tracked(tracked), Instant::now());
                self.focused = true;
                Ok(if tracked { Frame::Head(Pose(poses[0].mDeviceToAbsoluteTracking.m)) } else { Frame::Untracked })
            }
            EVRCompositorError::VRCompositorError_DoNotHaveFocus => {
                self.focused = false;
                Ok(Frame::Unfocused)
            }
            e => Err(compositor_error(e)),
        }
    }

    pub fn submit(&self, eye: usize, texture: *mut c_void) -> Result<(), String> {
        let t = Texture_t { handle: texture, eType: ETextureType::TextureType_DirectX, eColorSpace: EColorSpace::ColorSpace_Gamma };
        match vr!(self.compositor, Submit(EVREye(eye as i32), &t, std::ptr::null(), EVRSubmitFlags::Submit_Default)) {
            EVRCompositorError::VRCompositorError_None | EVRCompositorError::VRCompositorError_DoNotHaveFocus => Ok(()),
            e => Err(compositor_error(e)),
        }
    }

    pub fn handoff(&self) {
        vr!(self.compositor, PostPresentHandoff());
    }

    pub fn events(&mut self) -> Events {
        let mut out = Events::default();
        let now = Instant::now();
        let mut event = VREvent_t { eventType: 0, trackedDeviceIndex: 0, eventAgeSeconds: 0.0, data: VREvent_Data_t { reserved: Default::default() } };
        while vr!(self.system, PollNextEvent(&mut event, size_of::<VREvent_t>() as u32)) {
            if let Some(signal) = signal_of(&event) {
                self.presence.signal(signal, now);
                continue;
            }
            match event.event_type() {
                EVREventType::VREvent_Quit => {
                    vr!(self.system, AcknowledgeQuit_Exiting());
                    out.quit = true;
                }
                EVREventType::VREvent_ButtonPress if self.input.is_none() => out.presses += 1,
                EVREventType::VREvent_IpdChanged => out.eyes_changed = true,
                EVREventType::VREvent_DashboardActivated => self.dashboard = true,
                EVREventType::VREvent_DashboardDeactivated => self.dashboard = false,
                EVREventType::VREvent_SeatedZeroPoseReset | EVREventType::VREvent_StandingZeroPoseReset | EVREventType::VREvent_ChaperoneUniverseHasChanged => {
                    out.space_changed = true
                }
                kind @ (EVREventType::VREvent_Input_ActionManifestLoadFailed | EVREventType::VREvent_Input_BindingLoadFailed) => {
                    if let Some(input) = &mut self.input {
                        input.load_failed(if kind == EVREventType::VREvent_Input_BindingLoadFailed { "a controller binding" } else { "the action manifest" });
                    }
                }
                _ => {}
            }
        }
        if let Some(input) = &mut self.input {
            let polled = input.poll(now);
            if let Some(worn) = polled.worn {
                self.presence.signal(Signal::Worn(worn), now);
            }
            out.shortcuts = polled.shortcuts;
        }
        out.mounted = self.presence.changed(now);
        out.lost_tracking = self.presence.lost_tracking();
        out.focused = self.focused && !self.dashboard;
        out
    }

    pub fn head(&self) -> Option<Pose> {
        head_pose(self.system)
    }
}

pub unsafe fn mirror(eye: usize, device: *mut c_void) -> Result<*mut c_void, String> {
    let compositor: &VR_IVRCompositor_FnTable = unsafe { connected_table(IVRCompositor_FnTable)? };
    let mut view = std::ptr::null_mut();
    match vr!(compositor, GetMirrorTextureD3D11(EVREye(eye as i32), device, &mut view)) {
        EVRCompositorError::VRCompositorError_None if !view.is_null() => Ok(view),
        e => Err(compositor_error(e)),
    }
}

pub unsafe fn release_mirror(view: *mut c_void) {
    if let Ok(compositor) = unsafe { connected_table::<VR_IVRCompositor_FnTable>(IVRCompositor_FnTable) } {
        vr!(compositor, ReleaseMirrorTextureD3D11(view));
    }
}

fn compositor_error(e: EVRCompositorError) -> String {
    match e {
        EVRCompositorError::VRCompositorError_TextureIsOnWrongDevice => "other-gpu: The headset is on another graphics card than Better Player".into(),
        EVRCompositorError::VRCompositorError_IsNotSceneApplication => "busy: Another app is using the headset".into(),
        e => format!("compositor: SteamVR compositor error {}", e.0),
    }
}
