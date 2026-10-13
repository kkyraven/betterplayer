use std::ops::Deref;
use std::sync::Arc;

use bp_axes::{AxisSettings, Fallback, Frame, Mixer, ScriptEffect, ScriptTable};
use bp_devices::{AxisClamp, Profile, Transport};
use bp_script::{Axis, Script};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OutputScriptMode {
    #[default]
    Auto,
    SingleAxis,
    MultiAxis,
}

pub(crate) struct ScriptMixer {
    single: Mixer,
    multi: Mixer,
}

impl Deref for ScriptMixer {
    type Target = Mixer;

    fn deref(&self) -> &Mixer {
        &self.single
    }
}

impl ScriptMixer {
    pub fn new() -> Self {
        Self { single: Mixer::new(), multi: Mixer::new() }
    }

    pub fn install(&mut self, single: ScriptTable, multi: ScriptTable) {
        self.single.install(single);
        self.multi.install(multi);
    }

    pub fn install_single(&mut self, table: ScriptTable) {
        self.single.install(table);
    }

    pub fn set_global_offset(&mut self, ms: f64) {
        self.single.global_offset_ms = ms;
        self.multi.global_offset_ms = ms;
    }

    pub fn set_settings(&mut self, axis: Axis, settings: AxisSettings) {
        self.single.set_settings(axis, settings.clone());
        self.multi.set_settings(axis, settings);
    }

    pub fn set_live(&mut self, axis: Axis, value: Option<f64>) {
        self.single.set_live(axis, value);
        self.multi.set_live(axis, value);
    }

    pub fn set_external(&mut self, axis: Axis, value: Option<f64>) {
        self.single.set_external(axis, value);
        self.multi.set_external(axis, value);
    }

    pub fn set_source(&mut self, axis: Axis, value: Option<f64>) {
        self.single.set_source(axis, value);
        self.multi.set_source(axis, value);
    }

    pub fn set_fallback(&mut self, axis: Axis, value: Fallback) {
        self.single.set_fallback(axis, value.clone());
        self.multi.set_fallback(axis, value);
    }

    pub fn set_script_effect(&mut self, axis: Axis, effect: Option<ScriptEffect>) {
        self.single.set_script_effect(axis, effect);
        self.multi.set_script_effect(axis, effect);
    }

    pub fn set_max_override(&mut self, axis: Axis, value: Option<f64>) {
        self.single.set_max_override(axis, value);
        self.multi.set_max_override(axis, value);
    }

    pub fn set_electrode_contrast(&mut self, contrast: f64) {
        self.single.set_electrode_contrast(contrast);
        self.multi.set_electrode_contrast(contrast);
    }

    pub fn set_script_live(&mut self, axis: Axis, script: Option<Arc<Script>>) {
        self.set_script_pair_live(axis, script.clone(), script);
    }

    pub fn set_script_pair_live(&mut self, axis: Axis, single: Option<Arc<Script>>, multi: Option<Arc<Script>>) {
        self.single.set_script_live(axis, single);
        self.multi.set_script_live(axis, multi);
    }

    pub fn resync(&mut self) {
        self.single.resync();
        self.multi.resync();
    }

    pub fn tick(&mut self, media_ms: f64, dt_ms: f64) -> (Frame, Frame) {
        let single = self.single.tick(media_ms, dt_ms);
        let multi = self.multi.tick(media_ms, dt_ms);
        (single, multi)
    }

    pub fn for_output(&self, multi_axis: bool) -> &Mixer {
        if multi_axis { &self.multi } else { &self.single }
    }
}

pub(crate) fn multi_axis_output(transport: &Transport, profile: Profile, clamps: &[AxisClamp; Axis::COUNT], mode: OutputScriptMode) -> bool {
    profile == Profile::Stroker
        && matches!(transport, Transport::Serial { .. } | Transport::Udp { .. } | Transport::Tcp { .. } | Transport::WebSocket { .. } | Transport::Ble { .. })
        && match mode {
            OutputScriptMode::SingleAxis => false,
            OutputScriptMode::MultiAxis => true,
            OutputScriptMode::Auto => [Axis::L1, Axis::L2, Axis::R0, Axis::R1, Axis::R2].into_iter().any(|a| clamps[a.index()].enabled),
        }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bp_devices::HandyHosting;

    fn script(start: f64, end: f64, duration: f64) -> Arc<Script> {
        Arc::new(Script {
            actions: vec![bp_script::Action { at: 0.0, pos: start }, bp_script::Action { at: duration, pos: end }],
            ..Script::default()
        })
    }

    fn dual_mixer() -> ScriptMixer {
        let mut mixer = ScriptMixer::new();
        mixer.single.sync_ms = 0.0;
        mixer.multi.sync_ms = 0.0;
        let roll = script(0.25, 0.75, 1000.0);
        mixer.install(
            ScriptTable::build(vec![(Axis::L0, script(0.0, 1.0, 1000.0)), (Axis::R1, roll.clone())], false),
            ScriptTable::build(vec![(Axis::L0, script(1.0, 0.0, 2000.0)), (Axis::R1, roll)], false),
        );
        mixer.resync();
        mixer
    }

    #[test]
    fn simultaneous_outputs_sample_their_own_stroke_and_keyframes() {
        let mut mixer = dual_mixer();
        let (single, multi) = mixer.tick(250.0, 10.0);
        assert_eq!(single[Axis::L0.index()], 0.25);
        assert_eq!(multi[Axis::L0.index()], 0.875);
        assert_eq!(single[Axis::R1.index()], multi[Axis::R1.index()]);
        assert_eq!(mixer.for_output(false).next_keyframe(Axis::L0, 250.0).unwrap().at, 1000.0);
        assert_eq!(mixer.for_output(true).next_keyframe(Axis::L0, 250.0).unwrap().at, 2000.0);
        assert!(mixer.for_output(false).driven()[Axis::L0.index()]);
        assert!(mixer.for_output(true).driven()[Axis::L0.index()]);
    }

    #[test]
    fn both_representations_obey_range_invert_offset_and_live_controls() {
        let mut mixer = dual_mixer();
        mixer.set_global_offset(50.0);
        mixer.set_settings(Axis::L0, AxisSettings { min: 0.2, max: 0.8, invert: true, offset_ms: 50.0, ..AxisSettings::default() });
        let (single, multi) = mixer.tick(350.0, 10.0);
        assert!((single[0] - 0.65).abs() < 1e-9);
        assert!((multi[0] - 0.275).abs() < 1e-9);
        assert_eq!(mixer.for_output(true).next_keyframe(Axis::L0, 350.0).unwrap().at, 2100.0);
        mixer.set_live(Axis::L0, Some(0.45));
        let (single, multi) = mixer.tick(500.0, 10.0);
        assert_eq!(single[0], 0.45);
        assert_eq!(multi[0], 0.45);
        assert!(mixer.for_output(true).next_keyframe(Axis::L0, 500.0).is_none());
        mixer.set_live(Axis::L0, None);
        mixer.set_external(Axis::L0, Some(0.5));
        let (single, multi) = mixer.tick(500.0, 10.0);
        assert!((single[0] - 0.5).abs() < 1e-9);
        assert_eq!(single[0], multi[0]);
    }

    #[test]
    fn draft_then_restore_keeps_the_two_file_representations() {
        let mut mixer = dual_mixer();
        mixer.set_script_live(Axis::L0, Some(script(0.4, 0.4, 1000.0)));
        let (single, multi) = mixer.tick(250.0, 10.0);
        assert_eq!(single[0], 0.4);
        assert_eq!(multi[0], 0.4);
        mixer.set_script_pair_live(Axis::L0, Some(script(0.0, 1.0, 1000.0)), Some(script(1.0, 0.0, 2000.0)));
        let (single, multi) = mixer.tick(250.0, 10.0);
        assert_eq!(single[0], 0.25);
        assert_eq!(multi[0], 0.875);
        let plain = vec![(Axis::L0, script(0.6, 0.6, 1000.0))];
        mixer.install(ScriptTable::build(plain.clone(), false), ScriptTable::build(plain, false));
        let (single, multi) = mixer.tick(250.0, 10.0);
        assert_eq!(single, multi, "a plain script clears the previous bundle's alternate pipeline");
    }

    #[test]
    fn dual_plain_dual_loads_ramp_from_the_last_multi_output() {
        let mut mixer = dual_mixer();
        mixer.single.sync_ms = 4000.0;
        mixer.multi.sync_ms = 4000.0;
        mixer.install(
            ScriptTable::build(vec![(Axis::L0, script(0.2, 0.2, 1000.0))], false),
            ScriptTable::build(vec![(Axis::L0, script(0.9, 0.9, 1000.0))], false),
        );
        mixer.resync();
        for _ in 0..600 { mixer.tick(250.0, 10.0); }
        let plain = vec![(Axis::L0, script(0.1, 0.1, 1000.0))];
        mixer.install(ScriptTable::build(plain.clone(), false), ScriptTable::build(plain, false));
        mixer.resync();
        let mut before = 0.0;
        for _ in 0..600 { before = mixer.tick(250.0, 10.0).1[0]; }
        assert!((before - 0.1).abs() < 0.001);
        mixer.install(
            ScriptTable::build(vec![(Axis::L0, script(0.2, 0.2, 1000.0))], false),
            ScriptTable::build(vec![(Axis::L0, script(0.1, 0.1, 1000.0))], false),
        );
        mixer.resync();
        let after = mixer.tick(250.0, 10.0).1[0];
        assert!((after - before).abs() < 0.001, "the new script must ramp from the device's last frame");
    }

    #[test]
    fn handy_ossm_and_estim_use_root_while_multi_axis_tcode_uses_channels() {
        let clamps = [AxisClamp::default(); Axis::COUNT];
        let handy = Transport::Handy { key: String::new(), app_key: None, hosting: HandyHosting::Lan };
        assert!(!multi_axis_output(&handy, Profile::Stroker, &clamps, OutputScriptMode::Auto));
        assert!(!multi_axis_output(&Transport::Ossm { name: String::new() }, Profile::Stroker, &clamps, OutputScriptMode::Auto));
        let tcode = Transport::Udp { host: "127.0.0.1".into(), port: 1 };
        assert!(multi_axis_output(&tcode, Profile::Stroker, &clamps, OutputScriptMode::Auto));
        assert!(!multi_axis_output(&tcode, Profile::Restim, &clamps, OutputScriptMode::Auto));
        assert!(!multi_axis_output(&tcode, Profile::Stroker, &clamps, OutputScriptMode::SingleAxis));
        let mut stroke_only = clamps;
        for axis in [Axis::L1, Axis::L2, Axis::R0, Axis::R1, Axis::R2] {
            stroke_only[axis.index()].enabled = false;
        }
        assert!(!multi_axis_output(&tcode, Profile::Stroker, &stroke_only, OutputScriptMode::Auto));
        assert!(multi_axis_output(&tcode, Profile::Stroker, &stroke_only, OutputScriptMode::MultiAxis));
    }
}
