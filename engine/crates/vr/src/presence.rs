use std::time::{Duration, Instant};

const UNTRACKED: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Signal {
    Worn(bool),
    Gone(bool),
    Tracked(bool),
}

#[derive(Debug)]
pub struct Presence {
    worn: bool,
    gone: bool,
    untracked: Option<Instant>,
    said: bool,
    lost_tracking: bool,
}

impl Default for Presence {
    fn default() -> Presence {
        Presence { worn: true, gone: false, untracked: None, said: true, lost_tracking: false }
    }
}

impl Presence {
    pub fn signal(&mut self, signal: Signal, now: Instant) {
        match signal {
            Signal::Worn(on) => {
                self.worn = on;
                self.gone &= !on;
            }
            Signal::Gone(gone) => self.gone = gone,
            Signal::Tracked(true) => self.untracked = None,
            Signal::Tracked(false) => {
                self.untracked.get_or_insert(now);
            }
        }
    }

    pub fn mounted(&self, now: Instant) -> bool {
        self.worn && !self.gone && self.untracked.is_none_or(|since| now.duration_since(since) <= UNTRACKED)
    }

    pub fn changed(&mut self, now: Instant) -> Option<bool> {
        let mounted = self.mounted(now);
        let worn = self.worn && !self.gone;
        if !mounted {
            self.lost_tracking = if self.said { worn } else { self.lost_tracking && worn };
        }
        (mounted != self.said).then(|| {
            self.said = mounted;
            mounted
        })
    }

    pub fn lost_tracking(&self) -> bool {
        self.lost_tracking
    }
}

#[cfg(windows)]
pub(crate) fn signal_of(event: &crate::sys::VREvent_t) -> Option<Signal> {
    use crate::sys::{EVRButtonId, EVREventType as E, k_unTrackedDeviceIndex_Hmd};
    let head = event.trackedDeviceIndex == k_unTrackedDeviceIndex_Hmd;
    let proximity = || head && unsafe { event.data.controller }.button == EVRButtonId::k_EButton_ProximitySensor.0 as u32;
    Some(match event.event_type() {
        E::VREvent_ButtonPress if proximity() => Signal::Worn(true),
        E::VREvent_ButtonUnpress if proximity() => Signal::Worn(false),
        E::VREvent_TrackedDeviceUserInteractionStarted if head => Signal::Worn(true),
        E::VREvent_TrackedDeviceUserInteractionEnded if head => Signal::Worn(false),
        E::VREvent_TrackedDeviceDeactivated if head => Signal::Gone(true),
        E::VREvent_TrackedDeviceActivated if head => Signal::Gone(false),
        E::VREvent_EnterStandbyMode => Signal::Gone(true),
        E::VREvent_LeaveStandbyMode => Signal::Gone(false),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    #[test]
    fn the_sensor_takes_it_off_and_puts_it_back() {
        let t = Instant::now();
        let mut p = Presence::default();
        assert_eq!(p.changed(t), None, "starts on and says nothing");
        p.signal(Signal::Worn(false), t);
        assert_eq!(p.changed(t), Some(false));
        assert_eq!(p.changed(t), None, "said once");
        p.signal(Signal::Worn(true), at(t, 5));
        assert_eq!(p.changed(at(t, 5)), Some(true));
    }

    #[test]
    fn dropping_out_is_off_until_it_comes_back() {
        let t = Instant::now();
        let mut p = Presence::default();
        p.signal(Signal::Gone(true), t);
        assert_eq!(p.changed(t), Some(false));
        p.signal(Signal::Gone(false), t);
        assert_eq!(p.changed(t), Some(true));
        p.signal(Signal::Gone(true), t);
        p.signal(Signal::Worn(true), t);
        assert!(p.mounted(t));
        p.signal(Signal::Worn(false), t);
        p.signal(Signal::Gone(false), t);
        assert!(!p.mounted(t));
    }

    #[test]
    fn over_two_seconds_untracked_is_off_until_tracked_again() {
        let t = Instant::now();
        let mut p = Presence::default();
        p.signal(Signal::Tracked(false), t);
        p.signal(Signal::Tracked(false), at(t, 600));
        assert_eq!(p.changed(at(t, 2000)), None, "two seconds are allowed");
        assert_eq!(p.changed(at(t, 2001)), Some(false));
        assert!(p.lost_tracking(), "still worn: tracking alone");
        p.signal(Signal::Tracked(true), at(t, 2500));
        assert_eq!(p.changed(at(t, 2500)), Some(true));
        assert!(p.lost_tracking(), "kept for the way back on");
        p.signal(Signal::Tracked(false), at(t, 3000));
        p.signal(Signal::Tracked(true), at(t, 4900));
        assert_eq!(p.changed(at(t, 6000)), None);
    }

    #[test]
    fn taken_off_while_untracked_is_not_tracking_alone() {
        let t = Instant::now();
        let mut p = Presence::default();
        p.signal(Signal::Tracked(false), t);
        assert_eq!(p.changed(at(t, 2001)), Some(false));
        assert!(p.lost_tracking());
        p.signal(Signal::Worn(false), at(t, 3000));
        assert_eq!(p.changed(at(t, 3000)), None);
        assert!(!p.lost_tracking(), "the sensor said off meanwhile");
        p.signal(Signal::Worn(true), at(t, 4000));
        p.signal(Signal::Tracked(true), at(t, 4000));
        assert_eq!(p.changed(at(t, 4000)), Some(true));
        assert!(!p.lost_tracking());
        p.signal(Signal::Worn(false), at(t, 5000));
        assert_eq!(p.changed(at(t, 5000)), Some(false));
        assert!(!p.lost_tracking());
    }

    #[cfg(windows)]
    #[test]
    fn steamvr_events_map_to_signals() {
        use crate::sys::*;
        let event = |kind: EVREventType, device: u32, button: u32| VREvent_t {
            eventType: kind.0 as u32,
            trackedDeviceIndex: device,
            eventAgeSeconds: 0.0,
            data: VREvent_Data_t { controller: VREvent_Controller_t { button } },
        };
        let sensor = EVRButtonId::k_EButton_ProximitySensor.0 as u32;
        assert_eq!(signal_of(&event(EVREventType::VREvent_ButtonUnpress, 0, sensor)), Some(Signal::Worn(false)));
        assert_eq!(signal_of(&event(EVREventType::VREvent_ButtonPress, 0, sensor)), Some(Signal::Worn(true)));
        assert_eq!(signal_of(&event(EVREventType::VREvent_ButtonPress, 0, 33)), None);
        assert_eq!(signal_of(&event(EVREventType::VREvent_ButtonPress, 1, sensor)), None);
        assert_eq!(signal_of(&event(EVREventType::VREvent_TrackedDeviceUserInteractionEnded, 0, 0)), Some(Signal::Worn(false)));
        assert_eq!(signal_of(&event(EVREventType::VREvent_TrackedDeviceDeactivated, 0, 0)), Some(Signal::Gone(true)));
        assert_eq!(signal_of(&event(EVREventType::VREvent_TrackedDeviceDeactivated, 2, 0)), None);
        assert_eq!(signal_of(&event(EVREventType::VREvent_EnterStandbyMode, k_unTrackedDeviceIndexInvalid, 0)), Some(Signal::Gone(true)));
        assert_eq!(signal_of(&event(EVREventType::VREvent_LeaveStandbyMode, 0, 0)), Some(Signal::Gone(false)));
    }
}
