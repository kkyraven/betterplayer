//! The models that ship inside the app. Ours: trained on Lucy's corpus, exported by
//! `ml/export.py` as fp32 ONNX plus the `metadata.json` beside it, and committed to
//! `app/models/`, from where the installer carries them as a resource. The host hands
//! `Session::load` the two paths; no download and no checksum, git and the installer are the
//! integrity check.

use crate::meta::ModelKind;

#[derive(Clone, Copy, Debug)]
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: ModelKind,
    /// The export version, as `metadata.json` names it.
    pub version: &'static str,
    /// File names in the app's models folder: the weights, then the metadata. Prefixed with the
    /// id and version so two models' `metadata.json` never collide.
    pub files: [&'static str; 2],
    pub size_mb: u32,
    pub licence: &'static str,
    pub licence_url: &'static str,
    pub source_url: &'static str,
}

impl ModelSpec {
    /// The ONNX file.
    pub fn weights(&self) -> &'static str {
        self.files[0]
    }

    /// `metadata.json`.
    pub fn metadata(&self) -> &'static str {
        self.files[1]
    }
}

const LICENCE_URL: &str = "https://github.com/kkyraven/betterplayer";
const SOURCE_URL: &str = "https://github.com/kkyraven/betterplayer";

pub const MOVEMENT: ModelSpec = ModelSpec {
    id: "movement-a",
    label: "AI Motion",
    kind: ModelKind::Motion,
    version: "20260905-ens5",
    files: ["movement-a-20260905-ens5.onnx", "movement-a-20260905-ens5.json"],
    size_mb: 15,
    licence: "Better Player model licence",
    licence_url: LICENCE_URL,
    source_url: SOURCE_URL,
};

/// The music recipe's last stage, event threshold 0.30. The default CH/PMV model.
pub const MUSIC: ModelSpec = ModelSpec {
    id: "music",
    label: "CH",
    kind: ModelKind::Music,
    version: "20260905b-av",
    files: ["music-20260905b-av.onnx", "music-20260905b-av.json"],
    size_mb: 7,
    licence: "Better Player model licence",
    licence_url: LICENCE_URL,
    source_url: SOURCE_URL,
};

/// The overnight round's drop-stream winner, event threshold 0.35: the same inputs, a different
/// take. Out of fold the two tie, so both ship and the user picks by ear in Settings.
pub const MUSIC_VARIATION: ModelSpec = ModelSpec {
    id: "music-variation",
    label: "CH Variation",
    kind: ModelKind::Music,
    version: "20260905-av",
    files: ["music-20260905-av.onnx", "music-20260905-av.json"],
    size_mb: 7,
    licence: "Better Player model licence",
    licence_url: LICENCE_URL,
    source_url: SOURCE_URL,
};

pub const MODELS: &[ModelSpec] = &[MOVEMENT, MUSIC, MUSIC_VARIATION];

pub fn model(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}
