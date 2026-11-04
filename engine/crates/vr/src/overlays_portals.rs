use super::*;

const BACK: u64 = 1 << EVRButtonId::k_EButton_ApplicationMenu.0;

impl Overlays {
    pub fn pose(&mut self, id: u32) -> Result<Pose, String> {
        let (live, p) = self.get(id)?;
        let o = live.overlay;
        let mut origin = ETrackingUniverseOrigin::TrackingUniverseStanding;
        let mut m = HmdMatrix34_t { m: [[0.0; 4]; 3] };
        check(o, vr!(o, GetOverlayTransformAbsolute(p.handle, &mut origin, &mut m)))?;
        if origin != ETrackingUniverseOrigin::TrackingUniverseStanding {
            return Err(format!("headset panel {id} is not placed in standing space"));
        }
        Ok(Pose(m.m))
    }

    pub fn seat(&mut self) -> Option<Recentre> {
        self.0.as_ref().and_then(|live| live.recentre)
    }

    pub fn intersect(&mut self, id: u32, ray: &Ray) -> Result<Option<(f32, f32)>, String> {
        let (live, p) = self.get(id)?;
        let params = IntersectionParams {
            source: HmdVector3_t { v: ray.origin },
            direction: HmdVector3_t { v: ray.direction },
            origin: ETrackingUniverseOrigin::TrackingUniverseStanding,
        };
        let mut results = IntersectionResults::default();
        let o = live.overlay;
        let hit = vr!(o, ComputeOverlayIntersection(p.handle, (&params as *const IntersectionParams).cast(), (&mut results as *mut IntersectionResults).cast()));
        let [u, v] = results.uvs.v;
        Ok(hit.then_some((u * p.width as f32, (1.0 - v) * p.height as f32)))
    }
}

impl Live {
    pub(super) fn back_pressed(&mut self) -> bool {
        let interactive = self.panels.iter().filter(|p| p.shown).any(|p| {
            let mut method = VROverlayInputMethod::None;
            let read = vr!(self.overlay, GetOverlayInputMethod(p.handle, &mut method));
            read == EVROverlayError::VROverlayError_None && method == VROverlayInputMethod::Mouse && vr!(self.overlay, IsOverlayVisible(p.handle))
        });
        let pressed = [0, 1].map(|hand| {
            interactive
                && hand_device(self.system, hand).is_some_and(|device| {
                    let mut state = ControllerState::default();
                    let read = vr!(self.system, GetControllerState(device, (&mut state as *mut ControllerState).cast(), size_of::<ControllerState>() as u32));
                    read && state.pressed & BACK != 0
                })
        });
        self.back.step(pressed)
    }
}

#[derive(Default)]
pub(super) struct BackButton {
    was: [bool; 2],
}

impl BackButton {
    pub fn step(&mut self, pressed: [bool; 2]) -> bool {
        let rose = (0..2).any(|i| pressed[i] && !self.was[i]);
        self.was = pressed;
        rose
    }
}

#[cfg(test)]
mod tests {
    use super::BackButton;

    #[test]
    fn back_fires_once_per_press_on_either_hand() {
        let mut b = BackButton::default();
        assert!(!b.step([false, false]));
        assert!(b.step([false, true]));
        assert!(!b.step([false, true]));
        assert!(b.step([true, true]));
        assert!(!b.step([false, false]));
        assert!(b.step([true, false]));
    }
}
