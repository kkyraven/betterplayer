use std::ffi::c_void;
use std::time::Instant;

use crate::input::Input;
use crate::presence::signal_of;
use crate::render_models::{ControllerModels, RenderModels};
use crate::runtime::{Session, connected_table, device_string, head_pose, output_luid, vr};
use crate::sys::*;
use crate::{Drag, Pose, Presence, Ray, Shortcut, Signal};

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

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FrameTiming {
    pub index: u32,
    pub presents: u32,
    pub mispresented: u32,
    pub dropped: u32,
    pub reprojection: u32,
    pub system_s: f64,
    pub gpu_ms: f32,
    pub post_gpu_ms: f32,
    pub compositor_gpu_ms: f32,
    pub interval_ms: f32,
    pub ready_ms: f32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FrameTotals {
    pub presents: u32,
    pub dropped: u32,
    pub reprojected: u32,
    pub timed_out: u32,
    pub submits: u32,
}

#[derive(Default, Debug)]
pub struct Events {
    pub quit: bool,
    pub mounted: Option<bool>,
    pub lost_tracking: bool,
    pub shortcuts: Vec<Shortcut>,
    pub presses: u32,
    pub focused: bool,
    pub aim: [Option<Ray>; 2],
    pub hands: [Option<Pose>; 2],
    pub drag: Option<Drag>,
    pub stick: Option<[f32; 2]>,
    pub eyes_changed: bool,
    pub space_changed: bool,
}

pub struct Scene {
    system: &'static VR_IVRSystem_FnTable,
    compositor: &'static VR_IVRCompositor_FnTable,
    presence: Presence,
    input: Option<Input>,
    render_models: Option<RenderModels>,
    poses: Vec<TrackedDevicePose_t>,
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
        let render_models = RenderModels::new(&session).inspect_err(|e| eprintln!("bp-vr: the controllers are not drawn: {e}")).ok();
        *HEADSET.lock().unwrap() = Some(Self::read_headset(system));
        Ok(Scene {
            system,
            compositor,
            presence: Presence::default(),
            input,
            render_models,
            poses: vec![TrackedDevicePose_t::default(); k_unMaxTrackedDeviceCount as usize],
            focused: true,
            dashboard: false,
            _session: session,
        })
    }

    pub fn adapter(&self) -> u64 {
        output_luid(self.system)
    }

    pub fn render_size(&self) -> (u32, u32) {
        let (mut w, mut h) = (0, 0);
        vr!(self.system, GetRecommendedRenderTargetSize(&mut w, &mut h));
        (w.max(1), h.max(1))
    }

    fn read_headset(system: &VR_IVRSystem_FnTable) -> Headset {
        let read = |prop| device_string(system, k_unTrackedDeviceIndex_Hmd, prop);
        Headset {
            driver: read(ETrackedDeviceProperty::Prop_ActualTrackingSystemName_String),
            system: read(ETrackedDeviceProperty::Prop_TrackingSystemName_String),
            model: read(ETrackedDeviceProperty::Prop_ModelNumber_String),
        }
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
        let poses = &mut self.poses;
        let e = vr!(self.compositor, WaitGetPoses(poses.as_mut_ptr(), poses.len() as u32, std::ptr::null_mut(), 0));
        if e != EVRCompositorError::VRCompositorError_None {
            poses.fill(TrackedDevicePose_t::default());
        }
        match e {
            EVRCompositorError::VRCompositorError_None => {
                let head = poses[k_unTrackedDeviceIndex_Hmd as usize];
                self.presence.signal(Signal::Tracked(head.bPoseIsValid), Instant::now());
                self.focused = true;
                Ok(if head.bPoseIsValid { Frame::Head(Pose(head.mDeviceToAbsoluteTracking.m)) } else { Frame::Untracked })
            }
            EVRCompositorError::VRCompositorError_DoNotHaveFocus => {
                self.focused = false;
                Ok(Frame::Unfocused)
            }
            e => Err(compositor_error(e)),
        }
    }

    pub fn controllers(&mut self) -> ControllerModels {
        match &mut self.render_models {
            Some(r) => r.frame(self.system, &self.poses),
            None => ControllerModels::default(),
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

    pub fn frame_timings(&mut self, max: usize) -> Vec<FrameTiming> {
        let mut raw = vec![Compositor_FrameTiming::default(); max.max(1)];
        raw[0].m_nSize = size_of::<Compositor_FrameTiming>() as u32;
        let n = vr!(self.compositor, GetFrameTimings(raw.as_mut_ptr().cast(), raw.len() as u32)) as usize;
        raw[..n.min(raw.len())]
            .iter()
            .map(|t| FrameTiming {
                index: t.m_nFrameIndex,
                presents: t.m_nNumFramePresents,
                mispresented: t.m_nNumMisPresented,
                dropped: t.m_nNumDroppedFrames,
                reprojection: t.m_nReprojectionFlags,
                system_s: t.m_flSystemTimeInSeconds,
                gpu_ms: t.m_flPreSubmitGpuMs,
                post_gpu_ms: t.m_flPostSubmitGpuMs,
                compositor_gpu_ms: t.m_flCompositorRenderGpuMs,
                interval_ms: t.m_flClientFrameIntervalMs,
                ready_ms: t.m_flNewFrameReadyMs,
            })
            .collect()
    }

    pub fn frame_totals(&self) -> FrameTotals {
        let mut s = Compositor_CumulativeStats::default();
        vr!(self.compositor, GetCumulativeStats((&mut s as *mut Compositor_CumulativeStats).cast(), size_of::<Compositor_CumulativeStats>() as u32));
        FrameTotals { presents: s.m_nNumFramePresents, dropped: s.m_nNumDroppedFrames, reprojected: s.m_nNumReprojectedFrames, timed_out: s.m_nNumTimedOut, submits: s.m_nNumFrameSubmits }
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
                EVREventType::VREvent_TrackedDeviceActivated
                | EVREventType::VREvent_TrackedDeviceDeactivated
                | EVREventType::VREvent_TrackedDeviceUpdated
                | EVREventType::VREvent_TrackedDeviceRoleChanged => {
                    if let Some(r) = &mut self.render_models {
                        r.forget();
                    }
                }
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
            out.aim = polled.hands.map(|h| h.map(|p| Ray::from_pose(&p)));
            out.hands = polled.hands;
            out.drag = polled.drag;
            out.stick = polled.stick;
        }
        out.mounted = self.presence.changed(now);
        out.lost_tracking = self.presence.lost_tracking();
        out.focused = self.focused && !self.dashboard;
        out
    }

    pub fn buzz(&self, hand: usize, buzz: crate::Buzz) {
        if let Some(input) = &self.input {
            input.buzz_hand(hand, buzz);
        }
    }

    pub fn head(&self) -> Option<Pose> {
        head_pose(self.system)
    }
}

impl Drop for Scene {
    fn drop(&mut self) {
        *HEADSET.lock().unwrap() = None;
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Headset {
    pub driver: String,
    pub system: String,
    pub model: String,
}

static HEADSET: std::sync::Mutex<Option<Headset>> = std::sync::Mutex::new(None);

pub fn headset() -> Option<Headset> {
    HEADSET.lock().unwrap().clone()
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
