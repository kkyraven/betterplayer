use crate::meta::ModelKind;

#[derive(Clone, Copy, Debug)]
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: ModelKind,

    pub version: &'static str,


    pub files: [&'static str; 2],
    pub size_mb: u32,
    pub licence: &'static str,
    pub licence_url: &'static str,
    pub source_url: &'static str,
}

impl ModelSpec {

    pub fn weights(&self) -> &'static str {
        self.files[0]
    }


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
    version: "20260905",
    files: ["movement-a-20260905.onnx", "movement-a-20260905.json"],
    size_mb: 3,
    licence: "Better Player model licence",
    licence_url: LICENCE_URL,
    source_url: SOURCE_URL,
};

pub const MUSIC: ModelSpec = ModelSpec {
    id: "music",
    label: "AI CH/PMV",
    kind: ModelKind::Music,
    version: "20260905b-av",
    files: ["music-20260905b-av.onnx", "music-20260905b-av.json"],
    size_mb: 7,
    licence: "Better Player model licence",
    licence_url: LICENCE_URL,
    source_url: SOURCE_URL,
};

pub const MODELS: &[ModelSpec] = &[MOVEMENT, MUSIC];

pub fn model(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}
