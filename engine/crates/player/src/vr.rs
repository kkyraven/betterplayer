#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VrView {
    pub kind: VrKind,
    pub layout: VrLayout,
    pub fov: f32,
    pub swap_eyes: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VrKind {
    Flat,
    Equirect180,
    Equirect360,
    Fisheye,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VrLayout {
    Mono,
    Sbs,
    Ou,
}

impl Default for VrView {
    fn default() -> VrView {
        VrView { kind: VrKind::Flat, layout: VrLayout::Mono, fov: 190.0, swap_eyes: false }
    }
}

impl VrView {
    pub fn parse(kind: &str, layout: &str, fov: f64, swap_eyes: bool) -> Result<VrView, String> {
        let kind = match kind {
            "flat" => VrKind::Flat,
            "equirect180" => VrKind::Equirect180,
            "equirect360" => VrKind::Equirect360,
            "fisheye" => VrKind::Fisheye,
            k => return Err(format!("unknown projection {k:?}")),
        };
        let layout = match layout {
            "mono" => VrLayout::Mono,
            "sbs" => VrLayout::Sbs,
            "ou" => VrLayout::Ou,
            l => return Err(format!("unknown layout {l:?}")),
        };
        if !fov.is_finite() {
            return Err("fov is not a number".into());
        }
        Ok(VrView { kind, layout, fov: fov.clamp(60.0, 360.0) as f32, swap_eyes })
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct VrStatus {
    pub active: bool,
    pub error: Option<String>,
    pub quit: bool,
    pub hmd_name: String,
    pub mounted: bool,
    pub lost_tracking: bool,
    pub focused: bool,
    pub shortcuts: Vec<bp_vr::Shortcut>,
    pub presses: u32,
    pub refresh_hz: f32,
    pub width: u32,
    pub height: u32,
    pub fps: f32,
    pub frames: u64,
}

const SHORTCUTS_KEPT: usize = 32;

pub(crate) const VR_SCREEN_ARC_DEFAULT: f32 = 50.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Asked {
    pub turn: f32,
    pub recentred: bool,
    pub screen: f32,
}

pub(crate) static ASKED: std::sync::Mutex<Asked> = std::sync::Mutex::new(Asked { turn: 0.0, recentred: false, screen: VR_SCREEN_ARC_DEFAULT });

impl VrStatus {
    pub(crate) fn push_shortcuts(&mut self, shortcuts: Vec<bp_vr::Shortcut>) {
        self.shortcuts.extend(shortcuts);
        let over = self.shortcuts.len().saturating_sub(SHORTCUTS_KEPT);
        self.shortcuts.drain(..over);
    }
}

#[cfg(windows)]
pub(crate) use crate::windows::vr::Headset;

#[cfg(not(windows))]
pub(crate) struct Headset(std::convert::Infallible);

#[cfg(not(windows))]
impl Headset {
    pub fn start(_: &crate::gl_context::GlContext, _: VrView, _: std::sync::Arc<std::sync::Mutex<Option<VrStatus>>>) -> Result<Headset, String> {
        Err("not-installed: SteamVR needs Windows".into())
    }
    pub fn view(&mut self, _: VrView) {
        match self.0 {}
    }
    pub fn recentre(&mut self, _: bool) {
        match self.0 {}
    }
    pub fn draw_video(&mut self, _: *mut crate::mpv::mpv_render_context, _: (u32, u32)) -> bool {
        match self.0 {}
    }
    pub fn copy_video(&self, _: u32, _: u32, _: u32) -> bool {
        match self.0 {}
    }
    pub fn overdue(&self) -> bool {
        match self.0 {}
    }
    pub fn frame(&mut self) {
        match self.0 {}
    }
    pub fn ended(&self) -> bool {
        match self.0 {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn views_parse_the_apps_projection_names() {
        let v = VrView::parse("fisheye", "sbs", 200.0, true).unwrap();
        assert_eq!(v, VrView { kind: VrKind::Fisheye, layout: VrLayout::Sbs, fov: 200.0, swap_eyes: true });
        assert_eq!(VrView::parse("equirect360", "mono", 190.0, false).unwrap().kind, VrKind::Equirect360);
        assert!(VrView::parse("cubemap", "mono", 190.0, false).is_err());
        assert!(VrView::parse("flat", "tb", 190.0, false).is_err());
        assert!(VrView::parse("flat", "mono", f64::NAN, false).is_err());
    }

    #[test]
    fn an_undrained_queue_keeps_the_newest_shortcuts() {
        use bp_vr::Shortcut::{PlayPause, Stop};
        let mut s = VrStatus::default();
        s.push_shortcuts(vec![PlayPause; 30]);
        s.push_shortcuts(vec![Stop; 5]);
        assert_eq!(s.shortcuts.len(), SHORTCUTS_KEPT);
        assert_eq!(s.shortcuts[..27], [PlayPause; 27]);
        assert_eq!(s.shortcuts[27..], [Stop; 5]);
    }
}
