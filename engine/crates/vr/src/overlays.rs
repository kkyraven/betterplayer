use std::ffi::c_void;
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

use crate::presence::signal_of;
use crate::runtime::{Session, c_string, head_pose, output_luid, vr};
use crate::sys::*;
use crate::{Follow, OverlayEvent, Pose, Presence, Recentre, Signal, panel};

struct Panel {
    handle: VROverlayHandle_t,
    texture: ID3D11Texture2D,
    width: u32,
    height: u32,
    place: Option<(f32, f32, f32)>,
    shown: bool,
    follow: Option<Follow>,
    pointed: bool,
}

struct Live {
    panels: Vec<Panel>,
    recentre: Option<Recentre>,
    recentre_next: bool,
    keep_recline: bool,
    presence: Presence,
    polled: Option<Instant>,
    context: ID3D11DeviceContext,
    device: ID3D11Device,
    overlay: &'static VR_IVROverlay_FnTable,
    system: &'static VR_IVRSystem_FnTable,
    _session: Session,
}

pub struct Overlays(Option<Live>);

impl Overlays {
    pub fn new() -> Result<Overlays, String> {
        let session = Session::connect(EVRApplicationType::VRApplication_Overlay)?;
        let overlay: &VR_IVROverlay_FnTable = unsafe { session.table(IVROverlay_FnTable)? };
        let system: &VR_IVRSystem_FnTable = unsafe { session.table(IVRSystem_FnTable)? };
        let (device, context) = device(output_luid(system))?;
        let recentre = head_pose(system).map(|h| Recentre::from_head(&h));
        let recentre_next = recentre.is_none();
        let presence = Presence::default();
        Ok(Overlays(Some(Live { panels: Vec::new(), recentre, recentre_next, keep_recline: false, presence, polled: None, context, device, overlay, system, _session: session })))
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
        live.panels.push(Panel { handle, texture, width, height, place: None, shown: false, follow: None, pointed: false });
        let clear = vec![0u8; (width * height * 4) as usize];
        self.paint(id, &clear, 0, 0, width, height)?;
        Ok(id)
    }

    pub fn resize(&mut self, id: u32, width: u32, height: u32) -> Result<(), String> {
        check_size(width, height)?;
        let live = self.live()?;
        let o = live.overlay;
        let p = live.panels.get_mut(id as usize).ok_or_else(|| format!("no headset panel {id}"))?;
        if (p.width, p.height) == (width, height) {
            return Ok(());
        }
        let texture = texture(&live.device, width, height)?;
        let scale = HmdVector2_t { v: [width as f32, height as f32] };
        check(o, vr!(o, SetOverlayMouseScale(p.handle, &scale)))?;
        p.texture = texture;
        (p.width, p.height) = (width, height);
        Ok(())
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
        unsafe { live.context.UpdateSubresource(&p.texture, 0, Some(&area), pixels.as_ptr() as *const c_void, w * 4, 0) };
        let t = Texture_t { handle: p.texture.as_raw(), eType: ETextureType::TextureType_DirectX, eColorSpace: EColorSpace::ColorSpace_Gamma };
        let set = check(live.overlay, vr!(live.overlay, SetOverlayTexture(p.handle, &t)));
        unsafe { live.context.Flush() };
        set
    }

    pub fn place(&mut self, id: u32, distance: f32, drop: f32, pitch_deg: f32) -> Result<(), String> {
        let live = self.live()?;
        let p = live.panels.get_mut(id as usize).ok_or_else(|| format!("no headset panel {id}"))?;
        p.place = Some((distance, drop, pitch_deg));
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
        let o = live.overlay;
        let p = live.panels.get(id as usize).ok_or_else(|| format!("no headset panel {id}"))?;
        let head = if p.shown || p.follow.is_none() || live.recentre.is_none() { None } else { head_pose(live.system) };
        let p = &mut live.panels[id as usize];
        let method = if interactive { VROverlayInputMethod::Mouse } else { VROverlayInputMethod::None };
        check(o, vr!(o, SetOverlayInputMethod(p.handle, method)))?;
        check(o, vr!(o, SetOverlayFlag(p.handle, VROverlayFlags::MakeOverlaysInteractiveIfVisible, interactive)))?;
        p.pointed &= interactive;
        if let (Some(f), Some(head)) = (&mut p.follow, head)
            && f.left_behind(&head)
        {
            f.snap(&head);
        }
        p.shown = true;
        put(o, live.recentre.as_ref(), p)
    }

    pub fn hide(&mut self, id: u32) -> Result<(), String> {
        let live = self.live()?;
        let p = live.panels.get_mut(id as usize).ok_or_else(|| format!("no headset panel {id}"))?;
        p.shown = false;
        p.pointed = false;
        check(live.overlay, vr!(live.overlay, HideOverlay(p.handle)))
    }

    pub fn follow(&mut self, id: u32, on: bool) -> Result<(), String> {
        let live = self.live()?;
        let anchor = live.recentre.unwrap_or_default();
        let p = live.panels.get_mut(id as usize).ok_or_else(|| format!("no headset panel {id}"))?;
        if on == p.follow.is_some() {
            return Ok(());
        }
        p.follow = on.then(|| Follow::new(anchor));
        put(live.overlay, live.recentre.as_ref(), p)
    }

    pub fn poll(&mut self) -> Vec<OverlayEvent> {
        let Some(live) = self.0.as_mut() else { return Vec::new() };
        let now = Instant::now();
        let mut out = Vec::new();
        let mut event = VREvent_t { eventType: 0, trackedDeviceIndex: 0, eventAgeSeconds: 0.0, data: VREvent_Data_t { reserved: Default::default() } };
        let size = size_of::<VREvent_t>() as u32;
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
                    EVREventType::VREvent_ScrollSmooth | EVREventType::VREvent_ScrollDiscrete => {
                        let s = unsafe { event.data.scroll };
                        OverlayEvent { overlay: id as i32, dx: s.xdelta, dy: s.ydelta, ..OverlayEvent::system("scroll") }
                    }
                    _ => continue,
                };
                p.pointed = e.kind != "leave";
                out.push(e);
            }
        }
        let mut recentred = false;
        while vr!(live.system, PollNextEvent(&mut event, size)) {
            if let Some(signal) = signal_of(&event) {
                live.presence.signal(signal, now);
                continue;
            }
            match event.event_type() {
                EVREventType::VREvent_ButtonPress => out.push(OverlayEvent::system("press")),
                EVREventType::VREvent_Quit => out.push(OverlayEvent::system("quit")),
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
        let dt = live.polled.map_or(0.0, |at| now.duration_since(at).min(Duration::from_millis(100)).as_secs_f32());
        live.polled = Some(now);
        if let (Some(head), Some(_)) = (head, live.recentre) {
            for p in live.panels.iter_mut().filter(|p| p.shown) {
                let Some(f) = &mut p.follow else { continue };
                if f.step(&head, now, dt, p.pointed) {
                    let anchor = *f.anchor();
                    if let Err(e) = transform(live.overlay, &anchor, p) {
                        eprintln!("bp-vr: moving a headset panel: {e}");
                    }
                }
            }
        }
        out
    }

    pub fn close(&mut self) {
        if let Some(live) = self.0.take() {
            for p in &live.panels {
                vr!(live.overlay, DestroyOverlay(p.handle));
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
        for p in &mut self.panels {
            if let Some(f) = &mut p.follow {
                *f = Follow::new(recentre);
            }
            put(self.overlay, self.recentre.as_ref(), p)?;
        }
        Ok(())
    }
}

fn put(o: &VR_IVROverlay_FnTable, recentre: Option<&Recentre>, p: &Panel) -> Result<(), String> {
    let (Some(recentre), Some(_)) = (recentre, p.place) else { return Ok(()) };
    transform(o, p.follow.as_ref().map_or(recentre, Follow::anchor), p)?;
    if p.shown { check(o, vr!(o, ShowOverlay(p.handle))) } else { Ok(()) }
}

fn transform(o: &VR_IVROverlay_FnTable, anchor: &Recentre, p: &Panel) -> Result<(), String> {
    let Some((distance, drop, pitch)) = p.place else { return Ok(()) };
    let m = HmdMatrix34_t { m: panel(anchor, distance, drop, pitch).0 };
    check(o, vr!(o, SetOverlayTransformAbsolute(p.handle, ETrackingUniverseOrigin::TrackingUniverseStanding, &m)))
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
