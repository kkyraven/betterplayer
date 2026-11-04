use std::ffi::c_void;
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HMODULE, LUID};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_SHADER_RESOURCE, D3D11_BOX, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory4};
use windows::core::Interface;

use crate::maths::{dot, normalised, sub};
use crate::presence::signal_of;
use crate::render_models::in_frame;
use crate::runtime::{Session, c_string, device_string, head_pose, output_luid, vr};
use crate::sys::*;
use crate::{
    BAR_TEXELS, CLOSE_TEXELS, Controller, Follow, Moved, OverlayEvent, PanelGrab, Pose, Presence, Push, Ray, Reach, Recentre, Signal, bar_metres, bar_pose, bar_texels,
    close_metres, close_pose, close_texels, facing, gaze, moved_panel, plane_hit, pushed,
};

#[path = "overlays_portals.rs"]
mod portals;

struct Panel {
    handle: VROverlayHandle_t,
    texture: ID3D11Texture2D,
    width: u32,
    height: u32,
    metres: f32,
    place: Option<(f32, f32, f32)>,
    fixed: Option<Pose>,
    attached: Option<(usize, Pose)>,
    shown: bool,
    follow: Option<Follow>,
    pointed: bool,
    moved: Moved,
    bar: Option<Bar>,
    alpha: f32,
    pressed_by: Option<TrackedDeviceIndex_t>,
}

struct Bar {
    handle: VROverlayHandle_t,
    texture: ID3D11Texture2D,
    above: bool,
    shown: bool,
    pointed: bool,
    lit: bool,
    reach: Reach,
    close: Option<Close>,
}

struct Close {
    handle: VROverlayHandle_t,
    texture: ID3D11Texture2D,
    on: bool,
    shown: bool,
    pointed: bool,
    pressed: bool,
    lit: bool,
}

#[derive(Clone, Copy)]
struct Grabbing {
    panel: usize,
    device: TrackedDeviceIndex_t,
    drag: PanelGrab,
    seen_down: bool,
    stick: Option<usize>,
}

struct Named {
    device: TrackedDeviceIndex_t,
    kind: Arc<str>,
    model: Arc<str>,
}

#[repr(C)]
#[derive(Default)]
struct ControllerState {
    packet: u32,
    pressed: u64,
    touched: u64,
    axes: [[f32; 2]; 5],
}

const _: () = assert!(size_of::<ControllerState>() == 64);

const TRIGGER: u64 = 1 << EVRButtonId::k_EButton_SteamVR_Trigger.0;
const AXIS0_TYPE: i32 = 3002;
const AXIS_TRACKPAD: i32 = 1;
const AXIS_JOYSTICK: i32 = 2;
const DETENT_US: u16 = 3000;
const TIP_RETRY: Duration = Duration::from_secs(2);

#[repr(C)]
struct IntersectionParams {
    source: HmdVector3_t,
    direction: HmdVector3_t,
    origin: ETrackingUniverseOrigin,
}

#[repr(C)]
#[derive(Default)]
struct IntersectionResults {
    point: HmdVector3_t,
    normal: HmdVector3_t,
    uvs: HmdVector2_t,
    distance: f32,
}

struct Live {
    panels: Vec<Panel>,
    recentre: Option<Recentre>,
    recentre_next: bool,
    keep_recline: bool,
    presence: Presence,
    polled: Option<Instant>,
    grab: Option<Grabbing>,
    said: Vec<OverlayEvent>,
    models: Option<&'static VR_IVRRenderModels_FnTable>,
    tips: Vec<(String, Result<Pose, Instant>)>,
    named: [Option<Named>; 2],
    laser: Option<TrackedDeviceIndex_t>,
    context: ID3D11DeviceContext,
    device: ID3D11Device,
    overlay: &'static VR_IVROverlay_FnTable,
    system: &'static VR_IVRSystem_FnTable,
    back: portals::BackButton,
    _session: Session,
}

pub struct Overlays(Option<Live>);

impl Overlays {
    pub fn new() -> Result<Overlays, String> {
        let session = Session::connect(EVRApplicationType::VRApplication_Overlay)?;
        let overlay: &VR_IVROverlay_FnTable = unsafe { session.table(IVROverlay_FnTable)? };
        let system: &VR_IVRSystem_FnTable = unsafe { session.table(IVRSystem_FnTable)? };
        let models: Option<&VR_IVRRenderModels_FnTable> = unsafe { session.table(IVRRenderModels_FnTable) }.ok();
        let (device, context) = device(output_luid(system))?;
        let recentre = head_pose(system).map(|h| Recentre::from_head(&h));
        let recentre_next = recentre.is_none();
        let presence = Presence::default();
        Ok(Overlays(Some(Live {
            panels: Vec::new(),
            recentre,
            recentre_next,
            keep_recline: false,
            presence,
            polled: None,
            grab: None,
            said: Vec::new(),
            models,
            tips: Vec::new(),
            named: [None, None],
            laser: None,
            context,
            device,
            overlay,
            system,
            back: portals::BackButton::default(),
            _session: session,
        })))
    }

    fn live(&mut self) -> Result<&mut Live, String> {
        self.0.as_mut().ok_or_else(|| "the headset panels are closed".into())
    }

    fn get(&mut self, id: u32) -> Result<(&Live, &Panel), String> {
        let live = self.live()?;
        let p = live.panels.get(id as usize).ok_or_else(|| format!("no headset panel {id}"))?;
        Ok((live, p))
    }

    pub fn create(&mut self, key: &str, name: &str, width: u32, height: u32, metres: f32, curvature: f32) -> Result<u32, String> {
        check_size(width, height)?;
        let live = self.live()?;
        let o = live.overlay;
        let mut handle = k_ulOverlayHandleInvalid;
        let (k, n) = (c_string(key), c_string(name));
        check(o, vr!(o, CreateOverlay(k.as_ptr().cast(), n.as_ptr().cast(), &mut handle)))?;
        let texture = match texture(&live.device, width, height) {
            Ok(t) => t,
            Err(e) => {
                vr!(o, DestroyOverlay(handle));
                return Err(e);
            }
        };
        let id = live.panels.len() as u32;
        let scale = HmdVector2_t { v: [width as f32, height as f32] };
        let setup = [
            vr!(o, SetOverlayWidthInMeters(handle, metres)),
            vr!(o, SetOverlayCurvature(handle, curvature.clamp(0.0, 1.0))),
            vr!(o, SetOverlaySortOrder(handle, id)),
            vr!(o, SetOverlayInputMethod(handle, VROverlayInputMethod::Mouse)),
            vr!(o, SetOverlayMouseScale(handle, &scale)),
            vr!(o, SetOverlayFlag(handle, VROverlayFlags::SendVRSmoothScrollEvents, true)),
            vr!(o, SetOverlayFlag(handle, VROverlayFlags::IsPremultiplied, true)),
        ];
        if let Some(&e) = setup.iter().find(|e| **e != EVROverlayError::VROverlayError_None) {
            vr!(o, DestroyOverlay(handle));
            return Err(overlay_error(o, e));
        }
        live.panels.push(Panel {
            handle,
            texture,
            width,
            height,
            metres,
            place: None,
            fixed: None,
            attached: None,
            shown: false,
            follow: None,
            pointed: false,
            moved: Moved::default(),
            bar: None,
            alpha: 1.0,
            pressed_by: None,
        });
        let clear = vec![0u8; (width * height * 4) as usize];
        self.paint(id, &clear, 0, 0, width, height)?;
        Ok(id)
    }

    pub fn resize(&mut self, id: u32, width: u32, height: u32) -> Result<(), String> {
        check_size(width, height)?;
        let live = self.live()?;
        let (o, recentre) = (live.overlay, live.recentre);
        let p = live.panels.get_mut(id as usize).ok_or_else(|| format!("no headset panel {id}"))?;
        if (p.width, p.height) == (width, height) {
            return Ok(());
        }
        let texture = texture(&live.device, width, height)?;
        let scale = HmdVector2_t { v: [width as f32, height as f32] };
        check(o, vr!(o, SetOverlayMouseScale(p.handle, &scale)))?;
        p.texture = texture;
        (p.width, p.height) = (width, height);
        if p.bar.is_some() { put(o, recentre.as_ref(), p) } else { Ok(()) }
    }

    pub fn paint(&mut self, id: u32, pixels: &[u8], x: u32, y: u32, w: u32, h: u32) -> Result<(), String> {
        let (live, p) = self.get(id)?;
        if w == 0 || h == 0 {
            return Ok(());
        }
        if x.checked_add(w).is_none_or(|r| r > p.width) || y.checked_add(h).is_none_or(|b| b > p.height) {
            return Err(format!("paint {w}x{h} at {x},{y} is outside the {}x{} panel", p.width, p.height));
        }
        if pixels.len() < (w as usize) * (h as usize) * 4 {
            return Err(format!("paint of {w}x{h} got {} bytes, expected {}", pixels.len(), w * h * 4));
        }
        let area = D3D11_BOX { left: x, top: y, front: 0, right: x + w, bottom: y + h, back: 1 };
        upload(&live.context, live.overlay, p.handle, &p.texture, pixels, area)
    }

    pub fn place(&mut self, id: u32, distance: f32, drop: f32, pitch_deg: f32) -> Result<(), String> {
        let live = self.live()?;
        let p = live.panels.get_mut(id as usize).ok_or_else(|| format!("no headset panel {id}"))?;
        p.place = Some((distance, drop, pitch_deg));
        p.fixed = None;
        p.attached = None;
        size_bar(live.overlay, p)?;
        put(live.overlay, live.recentre.as_ref(), p)
    }

    pub fn recentre(&mut self, keep_recline: bool) -> Result<(), String> {
        let live = self.live()?;
        live.keep_recline = keep_recline && (!live.recentre_next || live.keep_recline);
        live.recentre_next = true;
        match head_pose(live.system) {
            Some(head) => live.recentre_to(&head),
            None => Ok(()),
        }
    }

    pub fn show(&mut self, id: u32, interactive: bool) -> Result<(), String> {
        let live = self.live()?;
        if !interactive && live.grab.is_some_and(|g| g.panel == id as usize) {
            live.end_grab();
        }
        let o = live.overlay;
        let p = live.panels.get(id as usize).ok_or_else(|| format!("no headset panel {id}"))?;
        let head = if p.shown || p.follow.is_none() || live.recentre.is_none() { None } else { head_pose(live.system) };
        let p = &mut live.panels[id as usize];
        let method = if interactive { VROverlayInputMethod::Mouse } else { VROverlayInputMethod::None };
        check(o, vr!(o, SetOverlayInputMethod(p.handle, method)))?;
        check(o, vr!(o, SetOverlayFlag(p.handle, VROverlayFlags::MakeOverlaysInteractiveIfVisible, interactive)))?;
        p.pointed &= interactive;
        if let Some(bar) = &mut p.bar {
            bar.shown = interactive;
            bar.pointed &= interactive;
            if let Some(c) = &mut bar.close {
                c.shown = interactive && c.on;
                (c.pointed, c.pressed) = (c.pointed && c.shown, c.pressed && c.shown);
                if !c.shown {
                    check(o, vr!(o, HideOverlay(c.handle)))?;
                }
            }
            if !interactive {
                check(o, vr!(o, HideOverlay(bar.handle)))?;
            }
        }
        if let (Some(f), Some(head)) = (&mut p.follow, head)
            && f.left_behind(&head)
        {
            f.snap(&head);
        }
        p.shown = true;
        if p.attached.is_some() {
            return put_attached(o, live.system, p);
        }
        put(o, live.recentre.as_ref(), p)
    }

    pub fn hide(&mut self, id: u32) -> Result<(), String> {
        let live = self.live()?;
        if live.grab.is_some_and(|g| g.panel == id as usize) {
            live.end_grab();
        }
        let p = live.panels.get_mut(id as usize).ok_or_else(|| format!("no headset panel {id}"))?;
        p.shown = false;
        p.pointed = false;
        if let Some(bar) = &mut p.bar {
            (bar.shown, bar.pointed) = (false, false);
            if let Some(c) = &mut bar.close {
                (c.shown, c.pointed, c.pressed) = (false, false, false);
                check(live.overlay, vr!(live.overlay, HideOverlay(c.handle)))?;
            }
            check(live.overlay, vr!(live.overlay, HideOverlay(bar.handle)))?;
        }
        check(live.overlay, vr!(live.overlay, HideOverlay(p.handle)))
    }

    pub fn follow(&mut self, id: u32, on: bool) -> Result<(), String> {
        let live = self.live()?;
        let anchor = live.recentre.unwrap_or_default();
        let p = live.panels.get_mut(id as usize).ok_or_else(|| format!("no headset panel {id}"))?;
        if on == p.follow.is_some() {
            return Ok(());
        }
        p.follow = on.then(|| follow_from(anchor, &p.moved));
        put(live.overlay, live.recentre.as_ref(), p)
    }

    pub fn grab_bar(&mut self, id: u32, above: bool, moved: Moved, reach: Reach) -> Result<(), String> {
        let live = self.live()?;
        let o = live.overlay;
        let p = live.panels.get(id as usize).ok_or_else(|| format!("no headset panel {id}"))?;
        if p.bar.is_none() {
            let mut handle = k_ulOverlayHandleInvalid;
            let (k, n) = (c_string(&format!("com.kinkyraven.betterplayer.bar.{}.{id}", std::process::id())), c_string("Better Player grab bar"));
            check(o, vr!(o, CreateOverlay(k.as_ptr().cast(), n.as_ptr().cast(), &mut handle)))?;
            let [w, h] = BAR_TEXELS;
            let scale = HmdVector2_t { v: [w as f32, h as f32] };
            let made = texture(&live.device, w, h).and_then(|texture| {
                let setup = [
                    vr!(o, SetOverlaySortOrder(handle, id)),
                    vr!(o, SetOverlayInputMethod(handle, VROverlayInputMethod::Mouse)),
                    vr!(o, SetOverlayMouseScale(handle, &scale)),
                    vr!(o, SetOverlayFlag(handle, VROverlayFlags::IsPremultiplied, true)),
                    vr!(o, SetOverlayAlpha(handle, p.alpha)),
                ];
                if let Some(&e) = setup.iter().find(|e| **e != EVROverlayError::VROverlayError_None) {
                    return Err(overlay_error(o, e));
                }
                upload(&live.context, o, handle, &texture, &bar_texels(false), D3D11_BOX { left: 0, top: 0, front: 0, right: w, bottom: h, back: 1 })?;
                Ok(texture)
            });
            let texture = match made {
                Ok(t) => t,
                Err(e) => {
                    vr!(o, DestroyOverlay(handle));
                    return Err(e);
                }
            };
            live.panels[id as usize].bar = Some(Bar { handle, texture, above, shown: false, pointed: false, lit: false, reach, close: None });
        }
        let p = &mut live.panels[id as usize];
        if let Some(bar) = &mut p.bar {
            bar.above = above;
            bar.reach = reach;
        }
        p.moved = p.place.map_or(moved, |place| moved.within(place, reach));
        if let Some(f) = &mut p.follow {
            f.set_aside(p.moved.yaw.to_radians());
        }
        size_bar(o, p)?;
        put(o, live.recentre.as_ref(), p)
    }

    pub fn offset(&mut self, id: u32) -> Result<Moved, String> {
        Ok(self.get(id)?.1.moved)
    }

    pub fn close_button(&mut self, id: u32, on: bool) -> Result<(), String> {
        let live = self.live()?;
        let o = live.overlay;
        let p = live.panels.get(id as usize).ok_or_else(|| format!("no headset panel {id}"))?;
        let Some(bar) = &p.bar else { return Ok(()) };
        if bar.close.is_none() {
            let mut handle = k_ulOverlayHandleInvalid;
            let (k, n) = (c_string(&format!("com.kinkyraven.betterplayer.close.{}.{id}", std::process::id())), c_string("Better Player close"));
            check(o, vr!(o, CreateOverlay(k.as_ptr().cast(), n.as_ptr().cast(), &mut handle)))?;
            let side = CLOSE_TEXELS;
            let scale = HmdVector2_t { v: [side as f32, side as f32] };
            let made = texture(&live.device, side, side).and_then(|texture| {
                let setup = [
                    vr!(o, SetOverlaySortOrder(handle, id)),
                    vr!(o, SetOverlayInputMethod(handle, VROverlayInputMethod::Mouse)),
                    vr!(o, SetOverlayMouseScale(handle, &scale)),
                    vr!(o, SetOverlayFlag(handle, VROverlayFlags::IsPremultiplied, true)),
                    vr!(o, SetOverlayAlpha(handle, p.alpha)),
                ];
                if let Some(&e) = setup.iter().find(|e| **e != EVROverlayError::VROverlayError_None) {
                    return Err(overlay_error(o, e));
                }
                upload(&live.context, o, handle, &texture, &close_texels(false), D3D11_BOX { left: 0, top: 0, front: 0, right: side, bottom: side, back: 1 })?;
                Ok(texture)
            });
            let texture = match made {
                Ok(t) => t,
                Err(e) => {
                    vr!(o, DestroyOverlay(handle));
                    return Err(e);
                }
            };
            let close = Close { handle, texture, on: false, shown: false, pointed: false, pressed: false, lit: false };
            if let Some(bar) = &mut live.panels[id as usize].bar {
                bar.close = Some(close);
            }
        }
        let p = &mut live.panels[id as usize];
        let Some((bar_shown, c)) = p.bar.as_mut().and_then(|b| Some((b.shown, b.close.as_mut()?))) else { return Ok(()) };
        c.on = on;
        c.shown = on && bar_shown;
        if !c.shown {
            (c.pointed, c.pressed) = (false, false);
            check(o, vr!(o, HideOverlay(c.handle)))?;
        }
        size_bar(o, p)?;
        put(o, live.recentre.as_ref(), p)
    }

    pub fn grab(&mut self, id: u32) -> Result<bool, String> {
        let live = self.live()?;
        let p = live.panels.get(id as usize).ok_or_else(|| format!("no headset panel {id}"))?;
        let (Some(place), Some(anchor), Some(_)) = (p.place, anchor_of(live.recentre.as_ref(), p), &p.bar) else { return Ok(false) };
        let centre = moved_panel(anchor, place, &p.moved).position();
        let Some(device) = presser(live.system, p.pressed_by.unwrap_or(k_unTrackedDeviceIndexInvalid), Some(centre)) else { return Ok(false) };
        live.start_grab(id as usize, device);
        Ok(live.grab.is_some_and(|g| g.panel == id as usize))
    }

    pub fn pointed(&mut self, id: u32, ray: &Ray) -> Result<bool, String> {
        let (live, p) = self.get(id)?;
        if !p.shown {
            return Ok(false);
        }
        let o = live.overlay;
        let bar = p.bar.as_ref().filter(|b| b.shown);
        let close = bar.and_then(|b| b.close.as_ref()).filter(|c| c.shown);
        let handles = [Some(p.handle), bar.map(|b| b.handle), close.map(|c| c.handle)];
        Ok(handles.into_iter().flatten().any(|h| intersects(o, h, ray)))
    }

    pub fn alpha(&mut self, id: u32, alpha: f32) -> Result<(), String> {
        let live = self.live()?;
        let o = live.overlay;
        let p = live.panels.get_mut(id as usize).ok_or_else(|| format!("no headset panel {id}"))?;
        let alpha = alpha.clamp(0.0, 1.0);
        if p.alpha == alpha {
            return Ok(());
        }
        p.alpha = alpha;
        check(o, vr!(o, SetOverlayAlpha(p.handle, alpha)))?;
        let Some(bar) = &p.bar else { return Ok(()) };
        check(o, vr!(o, SetOverlayAlpha(bar.handle, alpha)))?;
        match &bar.close {
            Some(c) => check(o, vr!(o, SetOverlayAlpha(c.handle, alpha))),
            None => Ok(()),
        }
    }

    pub fn poll(&mut self) -> Vec<OverlayEvent> {
        let Some(live) = self.0.as_mut() else { return Vec::new() };
        let now = Instant::now();
        let mut out = Vec::new();
        let mut event = VREvent_t { eventType: 0, trackedDeviceIndex: 0, eventAgeSeconds: 0.0, data: VREvent_Data_t { reserved: Default::default() } };
        let size = size_of::<VREvent_t>() as u32;
        let (mut pressed, mut let_go) = (None, false);
        for (id, p) in live.panels.iter_mut().enumerate() {
            while vr!(live.overlay, PollNextOverlayEvent(p.handle, &mut event, size)) {
                let height = p.height as f32;
                let at = |kind| {
                    let m = unsafe { event.data.mouse };
                    OverlayEvent { overlay: id as i32, kind, x: m.x, y: height - m.y, button: m.button, ..OverlayEvent::system(kind) }
                };
                let e = match event.event_type() {
                    EVREventType::VREvent_MouseMove => at("move"),
                    EVREventType::VREvent_MouseButtonDown => at("down"),
                    EVREventType::VREvent_MouseButtonUp => at("up"),
                    EVREventType::VREvent_FocusLeave => OverlayEvent { overlay: id as i32, ..OverlayEvent::system("leave") },
                    EVREventType::VREvent_ScrollSmooth | EVREventType::VREvent_ScrollDiscrete if live.grab.is_some() => continue,
                    EVREventType::VREvent_ScrollSmooth | EVREventType::VREvent_ScrollDiscrete => {
                        let s = unsafe { event.data.scroll };
                        OverlayEvent { overlay: id as i32, dx: s.xdelta, dy: s.ydelta, ..OverlayEvent::system("scroll") }
                    }
                    _ => continue,
                };
                p.pointed = e.kind != "leave";
                if e.kind == "down" {
                    p.pressed_by = Some(event.trackedDeviceIndex);
                }
                if matches!(e.kind, "move" | "down" | "up") {
                    live.laser = Some(event.trackedDeviceIndex);
                }
                let_go |= e.kind == "down" || e.kind == "up";
                out.push(e);
            }
            let Some(bar) = &mut p.bar else { continue };
            while vr!(live.overlay, PollNextOverlayEvent(bar.handle, &mut event, size)) {
                match event.event_type() {
                    EVREventType::VREvent_MouseMove => (bar.pointed, live.laser) = (true, Some(event.trackedDeviceIndex)),
                    EVREventType::VREvent_FocusLeave => bar.pointed = false,
                    EVREventType::VREvent_MouseButtonDown if unsafe { event.data.mouse }.button == 1 => {
                        bar.pointed = true;
                        live.laser = Some(event.trackedDeviceIndex);
                        pressed = Some((id, event.trackedDeviceIndex));
                    }
                    EVREventType::VREvent_MouseButtonUp => let_go |= live.grab.is_some_and(|g| g.panel == id),
                    _ => {}
                }
            }
            let Some(c) = &mut bar.close else { continue };
            while vr!(live.overlay, PollNextOverlayEvent(c.handle, &mut event, size)) {
                match event.event_type() {
                    EVREventType::VREvent_MouseMove => (c.pointed, live.laser) = (true, Some(event.trackedDeviceIndex)),
                    EVREventType::VREvent_FocusLeave => (c.pointed, c.pressed) = (false, false),
                    EVREventType::VREvent_MouseButtonDown if unsafe { event.data.mouse }.button == 1 => (c.pointed, c.pressed) = (true, true),
                    EVREventType::VREvent_MouseButtonUp if std::mem::take(&mut c.pressed) => out.push(OverlayEvent { overlay: id as i32, ..OverlayEvent::system("close") }),
                    _ => {}
                }
            }
        }
        if let_go {
            live.end_grab();
        }
        if let Some((id, device)) = pressed {
            live.bar_grab(id, device);
        }
        let dt = live.polled.map_or(0.0, |at| now.duration_since(at).min(Duration::from_millis(100)).as_secs_f32());
        live.polled = Some(now);
        live.step_grab(dt);
        let mut recentred = false;
        while vr!(live.system, PollNextEvent(&mut event, size)) {
            if let Some(signal) = signal_of(&event) {
                live.presence.signal(signal, now);
                continue;
            }
            match event.event_type() {
                EVREventType::VREvent_ButtonPress => out.push(OverlayEvent::system("press")),
                EVREventType::VREvent_Quit => out.push(OverlayEvent::system("quit")),
                EVREventType::VREvent_TrackedDeviceActivated
                | EVREventType::VREvent_TrackedDeviceDeactivated
                | EVREventType::VREvent_TrackedDeviceUpdated
                | EVREventType::VREvent_TrackedDeviceRoleChanged => live.named = [None, None],
                EVREventType::VREvent_SeatedZeroPoseReset | EVREventType::VREvent_StandingZeroPoseReset | EVREventType::VREvent_ChaperoneUniverseHasChanged => {
                    recentred = true
                }
                _ => {}
            }
        }
        let head = head_pose(live.system);
        live.presence.signal(Signal::Tracked(head.is_some()), now);
        if let Some(mounted) = live.presence.changed(now) {
            out.push(OverlayEvent::system(if mounted { "mounted" } else { "unmounted" }));
        }
        if recentred {
            out.push(OverlayEvent::system("recentre"));
        }
        if let Some(head) = head.filter(|_| live.recentre_next)
            && let Err(e) = live.recentre_to(&head)
        {
            eprintln!("bp-vr: placing the headset panels: {e}");
        }
        let grabbed = live.grab.map(|g| g.panel);
        if let (Some(head), Some(_)) = (head, live.recentre) {
            for (id, p) in live.panels.iter_mut().enumerate().filter(|(_, p)| p.shown) {
                let hold = p.pointed || grabbed == Some(id) || p.bar.as_ref().is_some_and(|b| b.pointed);
                let Some(f) = &mut p.follow else { continue };
                if f.step(&head, now, dt, hold) {
                    let anchor = *f.anchor();
                    if let Err(e) = transform(live.overlay, &anchor, p) {
                        eprintln!("bp-vr: moving a headset panel: {e}");
                    }
                }
            }
        }
        for (id, p) in live.panels.iter_mut().enumerate() {
            let Some(bar) = &mut p.bar else { continue };
            if let Some(c) = &mut bar.close
                && c.pointed != c.lit
            {
                c.lit = c.pointed;
                let n = CLOSE_TEXELS;
                if let Err(e) = upload(&live.context, live.overlay, c.handle, &c.texture, &close_texels(c.lit), D3D11_BOX { left: 0, top: 0, front: 0, right: n, bottom: n, back: 1 }) {
                    eprintln!("bp-vr: painting a close button: {e}");
                }
            }
            let lit = bar.pointed || grabbed == Some(id);
            if lit == bar.lit {
                continue;
            }
            bar.lit = lit;
            let [w, h] = BAR_TEXELS;
            if let Err(e) = upload(&live.context, live.overlay, bar.handle, &bar.texture, &bar_texels(lit), D3D11_BOX { left: 0, top: 0, front: 0, right: w, bottom: h, back: 1 }) {
                eprintln!("bp-vr: painting a grab bar: {e}");
            }
        }
        if live.back_pressed() {
            out.push(OverlayEvent::system("back"));
        }
        out.append(&mut live.said);
        out
    }

    pub fn place_facing(&mut self, id: u32, centre: [f32; 3]) -> Result<(), String> {
        let live = self.live()?;
        let eye = head_pose(live.system).map_or([centre[0], centre[1], centre[2] + 1.0], |h| h.position());
        let o = live.overlay;
        let p = live.panels.get_mut(id as usize).ok_or_else(|| format!("no headset panel {id}"))?;
        p.fixed = Some(facing(centre, eye));
        p.attached = None;
        p.follow = None;
        put(o, live.recentre.as_ref(), p)
    }

    pub fn hit(&mut self, id: u32, ray: &Ray) -> Result<Option<(f32, f32)>, String> {
        let (_, p) = self.get(id)?;
        let Some(pose) = p.fixed else { return Ok(None) };
        let height = p.metres * p.height as f32 / p.width as f32;
        Ok(plane_hit(&pose, ray, p.metres, height).map(|(u, v)| (u * p.width as f32, v * p.height as f32)))
    }

    pub fn attach(&mut self, id: u32, hand: usize, offset: Pose) -> Result<(), String> {
        let live = self.live()?;
        let (o, system) = (live.overlay, live.system);
        let p = live.panels.get_mut(id as usize).ok_or_else(|| format!("no headset panel {id}"))?;
        p.attached = Some((hand, offset));
        p.fixed = None;
        p.place = None;
        p.follow = None;
        put_attached(o, system, p)
    }

    pub fn controllers(&mut self) -> [Option<Controller>; 2] {
        let Some(live) = self.0.as_mut() else { return [None, None] };
        let system = live.system;
        let mut poses = [TrackedDevicePose_t::default(); k_unMaxTrackedDeviceCount as usize];
        vr!(system, GetDeviceToAbsoluteTrackingPose(ETrackingUniverseOrigin::TrackingUniverseStanding, 0.0, poses.as_mut_ptr(), poses.len() as u32));
        let head = &poses[0];
        if !head.bPoseIsValid {
            return [None, None];
        }
        let head = Pose(head.mDeviceToAbsoluteTracking.m);
        [0, 1].map(|hand| {
            let device = hand_device(system, hand)?;
            let pose = poses.get(device as usize).filter(|p| p.bPoseIsValid)?;
            let pose = Pose(pose.mDeviceToAbsoluteTracking.m);
            let (distance, angle) = gaze(&head, pose.position());
            if live.named[hand].as_ref().is_none_or(|n| n.device != device) {
                let read = |prop| -> Arc<str> { device_string(system, device, prop).into() };
                live.named[hand] = Some(Named { device, kind: read(ETrackedDeviceProperty::Prop_ControllerType_String), model: read(ETrackedDeviceProperty::Prop_RenderModelName_String) });
            }
            let (kind, model) = live.named[hand].as_ref().map(|n| (n.kind.clone(), n.model.clone()))?;
            let tip = live.tip(&model);
            Some(Controller {
                kind,
                distance,
                angle,
                eye: in_frame(&pose, head.position()),
                ray: Ray::from_pose(&pose.then(&tip)),
                head: Ray::from_pose(&head),
                model,
                laser: live.laser == Some(device),
            })
        })
    }

    pub fn connected(&mut self) -> bool {
        let Some(live) = self.0.as_ref() else { return false };
        [0, 1].into_iter().filter_map(|hand| hand_device(live.system, hand)).any(|d| vr!(live.system, IsTrackedDeviceConnected(d)))
    }

    pub fn close(&mut self) {
        if let Some(live) = self.0.take() {
            for p in &live.panels {
                vr!(live.overlay, DestroyOverlay(p.handle));
                if let Some(bar) = &p.bar {
                    vr!(live.overlay, DestroyOverlay(bar.handle));
                    if let Some(c) = &bar.close {
                        vr!(live.overlay, DestroyOverlay(c.handle));
                    }
                }
            }
        }
    }
}

impl Drop for Overlays {
    fn drop(&mut self) {
        self.close();
    }
}

impl Live {
    fn recentre_to(&mut self, head: &Pose) -> Result<(), String> {
        let recentre = match self.recentre {
            Some(r) if self.keep_recline => r.keeping_recline(head),
            _ => Recentre::from_head(head),
        };
        self.recentre = Some(recentre);
        self.recentre_next = false;
        self.end_grab();
        for p in &mut self.panels {
            if let Some(f) = &mut p.follow {
                *f = follow_from(recentre, &p.moved);
            }
            put(self.overlay, self.recentre.as_ref(), p)?;
        }
        Ok(())
    }

    fn bar_grab(&mut self, id: usize, device: TrackedDeviceIndex_t) {
        let p = &self.panels[id];
        let (Some(place), Some(anchor), None) = (p.place, anchor_of(self.recentre.as_ref(), p), p.fixed) else { return };
        let bar = p.bar.as_ref().map(|b| bar_pose(&moved_panel(anchor, place, &p.moved), pushed(place, &p.moved), panel_height(p), b.above).position());
        if let Some(device) = presser(self.system, device, bar) {
            self.start_grab(id, device);
        }
    }

    fn start_grab(&mut self, id: usize, device: TrackedDeviceIndex_t) {
        self.end_grab();
        let p = &self.panels[id];
        let (Some(place), Some(anchor), None) = (p.place, anchor_of(self.recentre.as_ref(), p), p.fixed) else { return };
        let Some(drag) = device_pose(self.system, device).and_then(|hand| PanelGrab::start(anchor, place, &p.moved, &Ray::from_pose(&hand))) else { return };
        self.grab = Some(Grabbing { panel: id, device, drag, seen_down: false, stick: stick_axis(self.system, device) });
        self.said.push(OverlayEvent { overlay: id as i32, ..OverlayEvent::system("grab") });
    }

    fn step_grab(&mut self, dt: f32) {
        let Some(g) = &mut self.grab else { return };
        let mut state = ControllerState::default();
        let read = vr!(self.system, GetControllerState(g.device, (&mut state as *mut ControllerState).cast(), size_of::<ControllerState>() as u32));
        if read && state.pressed & TRIGGER != 0 {
            g.seen_down = true;
        } else if read && g.seen_down {
            return self.end_grab();
        }
        let Some(hand) = device_pose(self.system, g.device) else { return };
        let p = &mut self.panels[g.panel];
        let Some(&anchor) = anchor_of(self.recentre.as_ref(), p) else { return };
        let ray = Ray::from_pose(&hand);
        let dragged = g.drag.drag(&anchor, &ray, &mut p.moved);
        let along = g.stick.filter(|_| read).map_or(0.0, |axis| state.axes[axis][1]);
        let push = p.bar.as_ref().map_or(Push::Still, |bar| g.drag.push(&anchor, &ray, along, dt, bar.reach, &mut p.moved));
        if push == Push::End {
            vr!(self.system, TriggerHapticPulse(g.device, 0, DETENT_US));
        }
        if !dragged && push == Push::Still {
            return;
        }
        if let Some(f) = &mut p.follow {
            f.set_aside(p.moved.yaw.to_radians());
        }
        if push != Push::Still
            && let Err(e) = size_bar(self.overlay, p)
        {
            eprintln!("bp-vr: sizing a grab bar: {e}");
        }
        if let Err(e) = transform(self.overlay, &anchor, p) {
            eprintln!("bp-vr: moving a headset panel: {e}");
        }
    }

    fn end_grab(&mut self) {
        if let Some(g) = self.grab.take() {
            self.said.push(OverlayEvent { overlay: g.panel as i32, ..OverlayEvent::system("grabbed") });
        }
    }

    fn tip(&mut self, model: &str) -> Pose {
        let Some(table) = self.models.filter(|_| !model.is_empty()) else { return Pose::IDENTITY };
        let known = self.tips.iter().position(|(m, _)| m == model);
        if let Some(i) = known {
            match self.tips[i].1 {
                Ok(pose) => return pose,
                Err(at) if at.elapsed() < TIP_RETRY => return Pose::IDENTITY,
                Err(_) => {}
            }
        }
        let (name, tip) = (c_string(model), c_string("tip"));
        let (controller, mode) = (ControllerState::default(), RenderModel_ControllerMode_State_t::default());
        let mut state = RenderModel_ComponentState_t::default();
        let found = vr!(table, GetComponentState(name.as_ptr().cast(), tip.as_ptr().cast(), (&controller as *const ControllerState).cast(), &mode, &mut state));
        let read = if found { Ok(Pose(state.mTrackingToComponentLocal.m)) } else { Err(Instant::now()) };
        match known {
            Some(i) => self.tips[i].1 = read,
            None => self.tips.push((model.to_string(), read)),
        }
        read.unwrap_or(Pose::IDENTITY)
    }
}

fn follow_from(anchor: Recentre, moved: &Moved) -> Follow {
    let mut f = Follow::new(anchor);
    f.set_aside(moved.yaw.to_radians());
    f
}

fn anchor_of<'a>(recentre: Option<&'a Recentre>, p: &'a Panel) -> Option<&'a Recentre> {
    recentre.map(|r| p.follow.as_ref().map_or(r, Follow::anchor))
}

fn panel_height(p: &Panel) -> f32 {
    p.metres * p.height as f32 / p.width as f32
}

fn size_bar(o: &VR_IVROverlay_FnTable, p: &Panel) -> Result<(), String> {
    let (Some(bar), Some(place)) = (&p.bar, p.place) else { return Ok(()) };
    let place = pushed(place, &p.moved);
    check(o, vr!(o, SetOverlayWidthInMeters(bar.handle, bar_metres(place))))?;
    match &bar.close {
        Some(c) => check(o, vr!(o, SetOverlayWidthInMeters(c.handle, close_metres(place)))),
        None => Ok(()),
    }
}

fn intersects(o: &VR_IVROverlay_FnTable, handle: VROverlayHandle_t, ray: &Ray) -> bool {
    let params = IntersectionParams {
        source: HmdVector3_t { v: ray.origin },
        direction: HmdVector3_t { v: ray.direction },
        origin: ETrackingUniverseOrigin::TrackingUniverseStanding,
    };
    let mut results = IntersectionResults::default();
    vr!(o, ComputeOverlayIntersection(handle, (&params as *const IntersectionParams).cast(), (&mut results as *mut IntersectionResults).cast()))
}

fn put(o: &VR_IVROverlay_FnTable, recentre: Option<&Recentre>, p: &Panel) -> Result<(), String> {
    if let Some(pose) = p.fixed {
        check(o, vr!(o, SetOverlayTransformAbsolute(p.handle, ETrackingUniverseOrigin::TrackingUniverseStanding, &HmdMatrix34_t { m: pose.0 })))?;
        return if p.shown { check(o, vr!(o, ShowOverlay(p.handle))) } else { Ok(()) };
    }
    let Some(anchor) = anchor_of(recentre, p).filter(|_| p.place.is_some()) else { return Ok(()) };
    transform(o, anchor, p)?;
    if !p.shown {
        return Ok(());
    }
    check(o, vr!(o, ShowOverlay(p.handle)))?;
    let Some(bar) = p.bar.as_ref().filter(|b| b.shown) else { return Ok(()) };
    check(o, vr!(o, ShowOverlay(bar.handle)))?;
    match &bar.close {
        Some(c) if c.shown => check(o, vr!(o, ShowOverlay(c.handle))),
        _ => Ok(()),
    }
}

fn put_attached(o: &VR_IVROverlay_FnTable, system: &VR_IVRSystem_FnTable, p: &Panel) -> Result<(), String> {
    let Some((hand, offset)) = p.attached else { return Ok(()) };
    let Some(device) = hand_device(system, hand) else { return check(o, vr!(o, HideOverlay(p.handle))) };
    check(o, vr!(o, SetOverlayTransformTrackedDeviceRelative(p.handle, device, &HmdMatrix34_t { m: offset.0 })))?;
    if p.shown { check(o, vr!(o, ShowOverlay(p.handle))) } else { Ok(()) }
}

fn device_pose(system: &VR_IVRSystem_FnTable, device: TrackedDeviceIndex_t) -> Option<Pose> {
    let mut poses = [TrackedDevicePose_t::default(); k_unMaxTrackedDeviceCount as usize];
    vr!(system, GetDeviceToAbsoluteTrackingPose(ETrackingUniverseOrigin::TrackingUniverseStanding, 0.0, poses.as_mut_ptr(), poses.len() as u32));
    poses.get(device as usize).filter(|p| p.bPoseIsValid).map(|p| Pose(p.mDeviceToAbsoluteTracking.m))
}

fn presser(system: &VR_IVRSystem_FnTable, device: TrackedDeviceIndex_t, bar: Option<[f32; 3]>) -> Option<TrackedDeviceIndex_t> {
    if device < k_unMaxTrackedDeviceCount && vr!(system, GetTrackedDeviceClass(device)) == ETrackedDeviceClass::TrackedDeviceClass_Controller {
        return Some(device);
    }
    let bar = bar?;
    let toward = |d: TrackedDeviceIndex_t| {
        let ray = Ray::from_pose(&device_pose(system, d)?);
        Some((d, dot(normalised(sub(bar, ray.origin)), ray.direction)))
    };
    [0, 1].into_iter().filter_map(|hand| toward(hand_device(system, hand)?)).max_by(|a, b| a.1.total_cmp(&b.1)).map(|(d, _)| d)
}

fn stick_axis(system: &VR_IVRSystem_FnTable, device: TrackedDeviceIndex_t) -> Option<usize> {
    let kinds: Vec<i32> = (0..5)
        .map(|axis| {
            let mut error = ETrackedPropertyError::default();
            vr!(system, GetInt32TrackedDeviceProperty(device, ETrackedDeviceProperty(AXIS0_TYPE + axis), &mut error))
        })
        .collect();
    [AXIS_JOYSTICK, AXIS_TRACKPAD].into_iter().find_map(|kind| kinds.iter().position(|&k| k == kind))
}

fn hand_device(system: &VR_IVRSystem_FnTable, hand: usize) -> Option<TrackedDeviceIndex_t> {
    let role = if hand == 0 { ETrackedControllerRole::TrackedControllerRole_LeftHand } else { ETrackedControllerRole::TrackedControllerRole_RightHand };
    let device = vr!(system, GetTrackedDeviceIndexForControllerRole(role));
    (device != k_unTrackedDeviceIndexInvalid).then_some(device)
}

fn transform(o: &VR_IVROverlay_FnTable, anchor: &Recentre, p: &Panel) -> Result<(), String> {
    let (None, Some(place)) = (p.fixed, p.place) else { return Ok(()) };
    let pose = moved_panel(anchor, place, &p.moved);
    let at = |handle, pose: &Pose| check(o, vr!(o, SetOverlayTransformAbsolute(handle, ETrackingUniverseOrigin::TrackingUniverseStanding, &HmdMatrix34_t { m: pose.0 })));
    at(p.handle, &pose)?;
    let Some(bar) = &p.bar else { return Ok(()) };
    let place = pushed(place, &p.moved);
    let bar_at = bar_pose(&pose, place, panel_height(p), bar.above);
    at(bar.handle, &bar_at)?;
    match &bar.close {
        Some(c) => at(c.handle, &close_pose(&bar_at, place)),
        None => Ok(()),
    }
}

fn upload(context: &ID3D11DeviceContext, o: &VR_IVROverlay_FnTable, handle: VROverlayHandle_t, texture: &ID3D11Texture2D, pixels: &[u8], area: D3D11_BOX) -> Result<(), String> {
    unsafe { context.UpdateSubresource(texture, 0, Some(&area), pixels.as_ptr() as *const c_void, (area.right - area.left) * 4, 0) };
    let t = Texture_t { handle: texture.as_raw(), eType: ETextureType::TextureType_DirectX, eColorSpace: EColorSpace::ColorSpace_Gamma };
    let set = check(o, vr!(o, SetOverlayTexture(handle, &t)));
    unsafe { context.Flush() };
    set
}

fn check_size(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 || width > 8192 || height > 8192 {
        return Err(format!("panel size {width}x{height} out of range"));
    }
    Ok(())
}

fn check(o: &VR_IVROverlay_FnTable, e: EVROverlayError) -> Result<(), String> {
    if e == EVROverlayError::VROverlayError_None { Ok(()) } else { Err(overlay_error(o, e)) }
}

fn overlay_error(o: &VR_IVROverlay_FnTable, e: EVROverlayError) -> String {
    if e == EVROverlayError::VROverlayError_KeyInUse {
        return "a headset panel with that key is already open".into();
    }
    let p = vr!(o, GetOverlayErrorNameFromEnum(e));
    let name = if p.is_null() { String::new() } else { unsafe { std::ffi::CStr::from_ptr(p) }.to_string_lossy().into_owned() };
    format!("SteamVR overlay error {name} ({})", e.0)
}

fn device(luid: u64) -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    let adapter: Option<IDXGIAdapter> = if luid == 0 {
        None
    } else {
        let factory: IDXGIFactory4 = unsafe { CreateDXGIFactory1() }.map_err(|e| format!("CreateDXGIFactory1: {e}"))?;
        let luid = LUID { LowPart: luid as u32, HighPart: (luid >> 32) as i32 };
        Some(unsafe { factory.EnumAdapterByLuid(luid) }.map_err(|e| format!("the headset's graphics card: {e}"))?)
    };
    let driver = if adapter.is_some() { D3D_DRIVER_TYPE_UNKNOWN } else { D3D_DRIVER_TYPE_HARDWARE };
    let (mut device, mut context) = (None, None);
    unsafe {
        D3D11CreateDevice(adapter.as_ref(), driver, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut context))
    }
    .map_err(|e| format!("D3D11CreateDevice: {e}"))?;
    Ok((device.ok_or("D3D11CreateDevice returned no device")?, context.ok_or("D3D11CreateDevice returned no context")?))
}

fn texture(device: &ID3D11Device, width: u32, height: u32) -> Result<ID3D11Texture2D, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut texture = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)) }.map_err(|e| format!("CreateTexture2D: {e}"))?;
    texture.ok_or_else(|| "CreateTexture2D returned no texture".into())
}
