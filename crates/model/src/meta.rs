use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;



#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelKind {
    Detector,
    Motion,
    Music,
}

impl ModelKind {
    pub fn id(self) -> &'static str {
        match self {
            ModelKind::Detector => "detector",
            ModelKind::Motion => "motion",
            ModelKind::Music => "music",
        }
    }

    pub fn from_id(s: &str) -> Option<ModelKind> {
        match s {
            "detector" => Some(ModelKind::Detector),
            "motion" => Some(ModelKind::Motion),
            "music" => Some(ModelKind::Music),
            _ => None,
        }
    }
}


#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Field {
    pub name: String,
    pub offset: usize,
    pub size: usize,
}

#[derive(Clone, Debug, Deserialize)]
struct Layout {
    size: usize,
    fields: Vec<Field>,
}

#[derive(Clone, Debug, Deserialize)]
struct Thresholds {
    event: f64,
    active: f64,
    active_hold_s: f64,

    nms_frames: Option<usize>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct Decode {
    nms_frames: Option<usize>,

    amplitude: Option<f64>,
    centre_tau_ms: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
struct PaceTable {
    cdf: BTreeMap<String, Option<Vec<f64>>>,
}

#[derive(Clone, Debug, Deserialize)]
struct Window {
    fps: f64,
    frames: usize,
    past: Option<usize>,
    future: Option<usize>,
    score: Option<[usize; 2]>,
}

#[derive(Clone, Debug, Deserialize)]
struct Input {
    name: String,
    shape: Vec<usize>,
}

#[derive(Clone, Debug, Deserialize)]
struct Raw {
    model: String,
    version: String,
    axes: Vec<String>,
    inputs: Vec<Input>,
    outputs: Vec<String>,
    feature_layout: Layout,
    thresholds: Thresholds,
    #[serde(default)]
    decode: Decode,
    pace: PaceTable,
    window: Window,
}




pub const NMS_FRAMES_DEFAULT: usize = 4;
pub const NMS_FRAMES_MUSIC: usize = 3;


#[derive(Clone, Debug)]
pub struct Meta {
    pub kind: ModelKind,
    pub version: String,

    pub axes: Vec<String>,
    pub input_name: String,

    pub input_shape: [usize; 3],
    pub outputs: Vec<String>,
    pub fields: Vec<Field>,
    pub event_threshold: f64,
    pub active_threshold: f64,
    pub active_hold_ms: f64,
    pub nms_frames: usize,
    pub amplitude: f64,
    pub centre_tau_ms: f64,

    pub pace_cdf: Vec<Vec<f64>>,
    pub fps: f64,
    pub frames: usize,
    pub past: usize,
    pub future: usize,
    pub score: [usize; 2],
}

impl Meta {
    pub fn read(path: &Path) -> Result<Meta, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Meta::parse(&text)
    }

    pub fn parse(text: &str) -> Result<Meta, String> {
        let raw: Raw = serde_json::from_str(text).map_err(|e| format!("metadata: {e}"))?;
        let kind = match raw.model.as_str() {
            m if m.starts_with("movement") => ModelKind::Motion,
            "music" => ModelKind::Music,
            other => return Err(format!("metadata: unknown model {other}")),
        };
        let input = raw.inputs.first().ok_or("metadata: no inputs")?;
        let shape: [usize; 3] = input.shape.as_slice().try_into().map_err(|_| format!("metadata: input shape {:?} is not [1, frames, width]", input.shape))?;
        if raw.feature_layout.size != shape[2] {
            return Err(format!("metadata: layout is {} wide but the input is {}", raw.feature_layout.size, shape[2]));
        }
        let expected: &[(&str, usize)] = match kind {
            ModelKind::Motion => crate::features::MOVEMENT_LAYOUT,
            ModelKind::Music => crate::music::MUSIC_LAYOUT,
            ModelKind::Detector => unreachable!(),
        };
        check_layout(&raw.feature_layout, expected)?;
        for name in ["pos", "active", "trough", "peak"] {
            if !raw.outputs.iter().any(|o| o == name) {
                return Err(format!("metadata: the graph has no {name} head"));
            }
        }
        if kind == ModelKind::Music && !raw.outputs.iter().any(|o| o == "style") {
            return Err("metadata: the music graph has no style head".into());
        }
        if raw.axes.len() != crate::AXES.len() || raw.axes.iter().zip(crate::AXES).any(|(a, b)| a != b) {
            return Err(format!("metadata: axes {:?}, expected {:?}", raw.axes, crate::AXES));
        }
        let past = raw.window.past.unwrap_or(raw.window.frames);
        let future = raw.window.future.unwrap_or(0);
        if past + future != raw.window.frames || raw.window.frames != shape[1] {
            return Err(format!("metadata: window {} past + {} future is not the {} frame input", past, future, shape[1]));
        }
        Ok(Meta {
            kind,
            version: raw.version,
            input_name: input.name.clone(),
            input_shape: shape,
            outputs: raw.outputs,
            fields: raw.feature_layout.fields,
            event_threshold: raw.thresholds.event,
            active_threshold: raw.thresholds.active,
            active_hold_ms: raw.thresholds.active_hold_s * 1000.0,
            nms_frames: raw.decode.nms_frames.or(raw.thresholds.nms_frames).unwrap_or(match kind {
                ModelKind::Music => NMS_FRAMES_MUSIC,
                _ => NMS_FRAMES_DEFAULT,
            }),
            amplitude: raw.decode.amplitude.unwrap_or(1.0),
            centre_tau_ms: raw.decode.centre_tau_ms.unwrap_or(crate::decoder::CENTRE_TAU_MS),
            pace_cdf: raw.axes.iter().map(|a| raw.pace.cdf.get(a).cloned().flatten().unwrap_or_default()).collect(),
            axes: raw.axes,
            fps: raw.window.fps,
            frames: raw.window.frames,
            past,
            future,
            score: raw.window.score.unwrap_or([0, past]),
        })
    }


    pub fn decode_config(&self, pace: f64) -> crate::decoder::DecodeConfig {
        crate::decoder::DecodeConfig {
            tau_ms: crate::pace::tau_for_pace(pace),
            event_threshold: self.event_threshold,
            nms_frames: self.nms_frames,
            rdp_eps: crate::decoder::RDP_EPS,
            active_threshold: self.active_threshold,
            active_hold_ms: self.active_hold_ms,
            amplitude: self.amplitude,
            centre_tau_ms: self.centre_tau_ms,
        }
    }
}


fn check_layout(layout: &Layout, expected: &[(&str, usize)]) -> Result<(), String> {
    let mut offset = 0;
    let mut ours = Vec::with_capacity(expected.len());
    for (name, size) in expected {
        ours.push(Field { name: (*name).to_string(), offset, size: *size });
        offset += size;
    }
    if layout.fields != ours {
        let show = |f: &[Field]| f.iter().map(|f| format!("{}@{}+{}", f.name, f.offset, f.size)).collect::<Vec<_>>().join(" ");
        return Err(format!("metadata: feature layout differs from the engine's.\n  export: {}\n  engine: {}", show(&layout.fields), show(&ours)));
    }
    if offset != layout.size {
        return Err(format!("metadata: fields span {offset} but the layout says {}", layout.size));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(fields: &[(&str, usize)], size: usize, extra: &str) -> String {
        let mut offset = 0;
        let fields: Vec<String> = fields
            .iter()
            .map(|(n, s)| {
                let f = format!(r#"{{"name":"{n}","offset":{offset},"size":{s}}}"#);
                offset += s;
                f
            })
            .collect();
        format!(
            r#"{{"model":"movement-a","version":"t","axes":["L0","L1","L2","R0","R1","R2"],
            "inputs":[{{"name":"features","shape":[1,144,{size}]}}],"outputs":["pos","vel","active","trough","peak"],
            "feature_layout":{{"size":{size},"fields":[{}]}},"thresholds":{{"event":0.4,"active":0.3,"active_hold_s":2.0}},
            {extra}"pace":{{"measure":"extrema","cdf":{{"L0":[0.1,1.0],"L1":null,"L2":null,"R0":null,"R1":null,"R2":null}}}},
            "window":{{"fps":30,"frames":144,"past":128,"future":16,"score":[64,128]}}}}"#,
            fields.join(",")
        )
    }



    #[test]
    fn the_bundled_movement_metadata_parses_and_matches_the_spec() {
        let m = Meta::parse(include_str!("../../../../app/models/movement-a-20260905-ens5.json")).unwrap();
        assert_eq!(m.version, crate::spec::MOVEMENT.version);
        assert_eq!(m.kind, ModelKind::Motion);
        assert_eq!((m.nms_frames, m.amplitude, m.centre_tau_ms), (4, 1.5, 4000.0));
        assert_eq!(m.event_threshold, 0.4);
        let music = Meta::parse(include_str!("../../../../app/models/music-20260905b-av.json")).unwrap();
        assert_eq!(music.version, crate::spec::MUSIC.version);
        assert_eq!(music.kind, ModelKind::Music);

        assert_eq!((music.nms_frames, music.amplitude), (NMS_FRAMES_MUSIC, 1.0));
        let variation = Meta::parse(include_str!("../../../../app/models/music-20260905-av.json")).unwrap();
        assert_eq!(variation.version, crate::spec::MUSIC_VARIATION.version);
        assert_eq!((variation.kind, variation.nms_frames, variation.event_threshold), (ModelKind::Music, NMS_FRAMES_MUSIC, 0.35));
    }

    #[test]
    fn the_shipping_layout_parses_and_a_moved_field_does_not() {
        let m = Meta::parse(&doc(crate::features::MOVEMENT_LAYOUT, crate::features::MOVEMENT_WIDTH, "")).unwrap();
        assert_eq!(m.kind, ModelKind::Motion);
        assert_eq!(m.nms_frames, NMS_FRAMES_DEFAULT);
        assert_eq!(m.event_threshold, 0.4);
        assert_eq!(m.active_hold_ms, 2000.0);
        assert_eq!(m.pace_cdf[0], vec![0.1, 1.0]);
        assert!(m.pace_cdf[1].is_empty());
        assert_eq!((m.past, m.future, m.score), (128, 16, [64, 128]));
        assert_eq!((m.amplitude, m.centre_tau_ms), (1.0, crate::decoder::CENTRE_TAU_MS));
        let ens = Meta::parse(&doc(crate::features::MOVEMENT_LAYOUT, crate::features::MOVEMENT_WIDTH,
            r#""members":5,"decode":{"nms_frames":3,"amplitude":1.5,"centre_tau_ms":4000.0,"snap":0.0,"tta":"none"},"#)).unwrap();
        assert_eq!((ens.nms_frames, ens.amplitude, ens.centre_tau_ms), (3, 1.5, 4000.0));
        assert_eq!(ens.decode_config(0.5).amplitude, 1.5);

        let mut moved: Vec<(&str, usize)> = crate::features::MOVEMENT_LAYOUT.to_vec();
        moved.swap(2, 3);
        let err = Meta::parse(&doc(&moved, crate::features::MOVEMENT_WIDTH, "")).unwrap_err();
        assert!(err.contains("differs") && err.contains("region@1536+4"), "{err}");
    }
}
