use std::ffi::{CStr, CString, c_char};
use std::time::{Duration, Instant};

use crate::Pose;
use crate::maths::{dot, sub};
use crate::runtime::{Session, device_string, vr};
use crate::sys::*;

const RETRY: Duration = Duration::from_secs(2);

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vertex {
    pub position: [f32; 3],
    pub normal: [f32; 3],
    pub uv: [f32; 2],
}

const _: () = assert!(size_of::<Vertex>() == 32);

pub struct Mesh {
    pub id: usize,
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u16>,
    pub texture: Option<i32>,
}

pub struct Texture {
    pub id: i32,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Part {
    pub mesh: usize,
    pub pose: Pose,
    pub lit: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HandModel {
    pub device: TrackedDeviceIndex_t,
    pub pose: Pose,
    pub parts: Vec<Part>,
}

#[derive(Default)]
pub struct ControllerModels {
    pub steamvr_draws: bool,
    pub hands: [Option<HandModel>; 2],
    pub meshes: Vec<Mesh>,
    pub textures: Vec<Texture>,
}

pub(crate) fn drawn(component: &str) -> bool {
    const NEVER: [&str; 9] = ["trackpad_scroll_cut", "trackpad_scroll_wheel", "scroll_wheel", "status", "status_left", "status_right", "led", "led_left", "led_right"];
    !component.ends_with("_touch") && !NEVER.contains(&component)
}

pub(crate) fn lit_components(kind: &str) -> &'static [&'static str] {
    match kind {
        "vive_controller" => &["trigger", "trackpad", "button"],
        _ => &["trigger", "thumbstick", "button_a", "button_b", "button_x", "button_y"],
    }
}

pub(crate) fn in_frame(pose: &Pose, point: [f32; 3]) -> [f32; 3] {
    let m = &pose.0;
    let to = sub(point, pose.position());
    [0, 1, 2].map(|c| dot([m[0][c], m[1][c], m[2][c]], to))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Loading,
    Done,
    Failed,
}

struct Model {
    name: CString,
    components: Vec<Component>,
}

struct Component {
    name: Option<CString>,
    mesh: usize,
}

struct Device {
    index: TrackedDeviceIndex_t,
    kind: String,
    model: Option<usize>,
    read: Instant,
}

pub(crate) struct RenderModels {
    table: &'static VR_IVRRenderModels_FnTable,
    paths: [VRInputValueHandle_t; 2],
    hands: [Option<Device>; 2],
    stale: [bool; 2],
    models: Vec<Model>,
    meshes: Vec<(CString, State)>,
    textures: Vec<(i32, State)>,
    waiting: Vec<Mesh>,
}

impl RenderModels {
    pub(crate) fn new(session: &Session) -> Result<RenderModels, String> {
        let table: &VR_IVRRenderModels_FnTable = unsafe { session.table(IVRRenderModels_FnTable)? };
        let input: &VR_IVRInput_FnTable = unsafe { session.table(IVRInput_FnTable)? };
        let path = |p: &CStr| {
            let mut h = k_ulInvalidInputValueHandle;
            vr!(input, GetInputSourceHandle(p.as_ptr(), &mut h));
            h
        };
        Ok(RenderModels {
            table,
            paths: [path(c"/user/hand/left"), path(c"/user/hand/right")],
            hands: [None, None],
            stale: [false; 2],
            models: Vec::new(),
            meshes: Vec::new(),
            textures: Vec::new(),
            waiting: Vec::new(),
        })
    }

    pub(crate) fn forget(&mut self) {
        self.stale = [true; 2];
    }

    pub(crate) fn frame(&mut self, system: &VR_IVRSystem_FnTable, poses: &[TrackedDevicePose_t]) -> ControllerModels {
        let mut out = ControllerModels { steamvr_draws: vr!(system, IsSteamVRDrawingControllers()), ..Default::default() };
        if !out.steamvr_draws {
            out.hands = [0, 1].map(|hand| self.hand(system, poses, hand));
        }
        self.load(&mut out);
        out
    }

    fn hand(&mut self, system: &VR_IVRSystem_FnTable, poses: &[TrackedDevicePose_t], hand: usize) -> Option<HandModel> {
        let role = if hand == 0 { ETrackedControllerRole::TrackedControllerRole_LeftHand } else { ETrackedControllerRole::TrackedControllerRole_RightHand };
        let index = vr!(system, GetTrackedDeviceIndexForControllerRole(role));
        let pose = poses.get(index as usize).filter(|p| p.bPoseIsValid)?;
        let fresh = !self.stale[hand] && self.hands[hand].as_ref().is_some_and(|d| d.index == index && (d.model.is_some() || d.read.elapsed() < RETRY));
        if !fresh {
            let kind = device_string(system, index, ETrackedDeviceProperty::Prop_ControllerType_String);
            let name = device_string(system, index, ETrackedDeviceProperty::Prop_RenderModelName_String);
            let model = if name.is_empty() { None } else { self.model(&name) };
            self.hands[hand] = Some(Device { index, kind, model, read: Instant::now() });
            self.stale[hand] = false;
        }
        let device = self.hands[hand].as_ref()?;
        let model = &self.models[device.model?];
        let lit = lit_components(&device.kind);
        let mode = RenderModel_ControllerMode_State_t::default();
        let parts = model
            .components
            .iter()
            .filter_map(|c| {
                let Some(name) = &c.name else { return Some(Part { mesh: c.mesh, pose: Pose::IDENTITY, lit: false }) };
                let mut state = RenderModel_ComponentState_t::default();
                let known = vr!(self.table, GetComponentStateForDevicePath(model.name.as_ptr(), name.as_ptr(), self.paths[hand], &mode, &mut state));
                if !known || state.uProperties & VRComponentProperty_IsVisible == 0 {
                    return None;
                }
                let lit = name.to_str().is_ok_and(|n| lit.contains(&n));
                Some(Part { mesh: c.mesh, pose: Pose(state.mTrackingToComponentRenderModel.m), lit })
            })
            .collect();
        Some(HandModel { device: index, pose: Pose(pose.mDeviceToAbsoluteTracking.m), parts })
    }

    fn model(&mut self, name: &str) -> Option<usize> {
        if let Some(i) = self.models.iter().position(|m| m.name.to_bytes() == name.as_bytes()) {
            return Some(i);
        }
        let model = CString::new(name).ok()?;
        let t = self.table;
        let count = vr!(t, GetComponentCount(model.as_ptr()));
        let mut components = Vec::new();
        for i in 0..count {
            let Some(component) = read(|buf, len| vr!(t, GetComponentName(model.as_ptr(), i, buf, len))) else { continue };
            if !drawn(component.to_str().unwrap_or("")) {
                continue;
            }
            let Some(mesh) = read(|buf, len| vr!(t, GetComponentRenderModelName(model.as_ptr(), component.as_ptr(), buf, len))) else { continue };
            components.push(Component { name: Some(component), mesh: self.mesh(mesh) });
        }
        if count == 0 {
            components.push(Component { name: None, mesh: self.mesh(model.clone()) });
        }
        self.models.push(Model { name: model, components });
        Some(self.models.len() - 1)
    }

    fn mesh(&mut self, name: CString) -> usize {
        self.meshes.iter().position(|(n, _)| *n == name).unwrap_or_else(|| {
            self.meshes.push((name, State::Loading));
            self.meshes.len() - 1
        })
    }

    fn load(&mut self, out: &mut ControllerModels) {
        let t = self.table;
        for (id, (name, state)) in self.meshes.iter_mut().enumerate().filter(|(_, (_, s))| *s == State::Loading) {
            let mut p = std::ptr::null_mut();
            let e = vr!(t, LoadRenderModel_Async(name.as_ptr(), &mut p));
            if e == EVRRenderModelError::VRRenderModelError_Loading {
                continue;
            }
            let mesh = if e == EVRRenderModelError::VRRenderModelError_None && !p.is_null() {
                let m = copy_mesh(id, unsafe { &*p });
                vr!(t, FreeRenderModel(p));
                m
            } else {
                Err(format!("error {}", e.0))
            };
            match mesh {
                Ok(mesh) => {
                    *state = State::Done;
                    if let Some(texture) = mesh.texture.filter(|t| !self.textures.iter().any(|(id, _)| id == t)) {
                        self.textures.push((texture, State::Loading));
                    }
                    self.waiting.push(mesh);
                }
                Err(e) => {
                    eprintln!("bp-vr: the controller part {name:?} did not load ({e}); it is left out");
                    *state = State::Failed;
                }
            }
        }
        for (id, state) in self.textures.iter_mut().filter(|(_, s)| *s == State::Loading) {
            let mut p = std::ptr::null_mut();
            let e = vr!(t, LoadTexture_Async(*id, &mut p));
            if e == EVRRenderModelError::VRRenderModelError_Loading {
                continue;
            }
            let texture = if e == EVRRenderModelError::VRRenderModelError_None && !p.is_null() {
                let m = copy_texture(*id, unsafe { &*p });
                vr!(t, FreeTexture(p));
                m
            } else {
                Err(format!("error {}", e.0))
            };
            match texture {
                Ok(texture) => {
                    *state = State::Done;
                    out.textures.push(texture);
                }
                Err(e) => {
                    eprintln!("bp-vr: a controller texture did not load ({e}); its parts are drawn plain");
                    *state = State::Failed;
                }
            }
        }
        let textures = &self.textures;
        let (ready, waiting): (Vec<Mesh>, Vec<Mesh>) = std::mem::take(&mut self.waiting).into_iter().partition(|m| m.texture.is_none_or(|t| textures.iter().any(|(id, s)| *id == t && *s != State::Loading)));
        out.meshes = ready;
        self.waiting = waiting;
    }
}

fn read(get: impl FnOnce(*mut c_char, u32) -> u32) -> Option<CString> {
    let mut buf = [0 as c_char; 256];
    let len = get(buf.as_mut_ptr(), buf.len() as u32);
    if len == 0 || len as usize > buf.len() {
        return None;
    }
    let s = unsafe { CStr::from_ptr(buf.as_ptr()) };
    (!s.is_empty()).then(|| s.to_owned())
}

fn copy_mesh(id: usize, m: &RenderModel_t) -> Result<Mesh, String> {
    let vertices = unsafe { slice(m.rVertexData, m.unVertexCount as usize) };
    let indices = unsafe { slice(m.rIndexData, m.unTriangleCount as usize * 3) };
    if indices.iter().any(|&i| i as usize >= vertices.len()) {
        return Err("an index past its vertices".into());
    }
    Ok(Mesh {
        id,
        vertices: vertices.iter().map(|v| Vertex { position: v.vPosition.v, normal: v.vNormal.v, uv: v.rfTextureCoord }).collect(),
        indices: indices.to_vec(),
        texture: (m.diffuseTextureId >= 0).then_some(m.diffuseTextureId),
    })
}

fn copy_texture(id: i32, t: &RenderModel_TextureMap_t) -> Result<Texture, String> {
    if t.format != EVRRenderModelTextureFormat::VRRenderModelTextureFormat_RGBA8_SRGB {
        return Err(format!("format {}", t.format.0));
    }
    let (width, height) = (t.unWidth as u32, t.unHeight as u32);
    let rgba = unsafe { slice(t.rubTextureMapData, width as usize * height as usize * 4) }.to_vec();
    if rgba.is_empty() {
        return Err("no pixels".into());
    }
    Ok(Texture { id, width, height, rgba })
}

unsafe fn slice<'a, T>(p: *const T, len: usize) -> &'a [T] {
    if p.is_null() || len == 0 { &[] } else { unsafe { std::slice::from_raw_parts(p, len) } }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_leds_touch_and_scroll_parts_are_never_drawn() {
        for c in ["body", "trigger", "thumbstick", "button_a", "trackpad", "button", "grip", "handgrip"] {
            assert!(drawn(c), "{c}");
        }
        for c in ["trackpad_touch", "thumbstick_touch", "button_a_touch", "trackpad_scroll_cut", "trackpad_scroll_wheel", "scroll_wheel", "status", "status_left", "led", "led_right"] {
            assert!(!drawn(c), "{c}");
        }
    }

    #[test]
    fn the_legend_lights_the_vives_trackpad_and_everyone_elses_stick_and_face_buttons() {
        assert_eq!(lit_components("vive_controller"), ["trigger", "trackpad", "button"]);
        for kind in ["oculus_touch", "knuckles", "something_new", ""] {
            assert_eq!(lit_components(kind), ["trigger", "thumbstick", "button_a", "button_b", "button_x", "button_y"], "{kind}");
        }
    }

    #[test]
    fn a_point_comes_into_a_poses_frame() {
        let near = |a: [f32; 3], b: [f32; 3]| a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-5);
        let pose = Pose::translation(0.0, 1.0, -1.0).then(&Pose::yaw(std::f32::consts::FRAC_PI_2));
        assert!(near(in_frame(&pose, pose.position()), [0.0; 3]));
        assert!(near(in_frame(&pose, [0.0, 1.2, -0.5]), [-0.5, 0.2, 0.0]));
        assert!(near(in_frame(&Pose::IDENTITY, [0.1, 0.2, 0.3]), [0.1, 0.2, 0.3]));
    }
}
