//! Region detector: a YOLO body-part model run through ONNX Runtime on a small RGB frame, and
//! the rule that turns its boxes into the tracker's region (genitals first, else a face,
//! nearest the centre of the picture). Weights are never bundled: the host downloads a
//! `ModelSpec` with its SHA-256 checked and hands the file's path to `Detector::load`.

use std::path::Path;

pub mod tagger;
pub use tagger::Tagger;

use ort::session::{Session, builder::GraphOptimizationLevel};
use ort::value::TensorRef;

/// A model the host may offer to download. Every one here is a YOLO fine-tune, and every one
/// is treated as AGPL-3.0 (the base is, whatever the fine-tune declares), so the host must
/// show the licence and ask before fetching.
#[derive(Clone, Copy, Debug)]
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    /// File name in the host's model folder.
    pub file: &'static str,
    /// Square input size the model was exported at.
    pub input: u32,
    pub classes: &'static [&'static str],
    pub url: &'static str,
    pub sha256: &'static str,
    pub size_mb: u32,
    pub licence: &'static str,
    pub licence_url: &'static str,
    pub source_url: &'static str,
}

const AGPL_URL: &str = "https://www.gnu.org/licenses/agpl-3.0.txt";

pub const HOTSCREEN: ModelSpec = ModelSpec {
    id: "hotscreen",
    label: "HotScreen real+anime",
    file: "hs-real-anime-y11s-640-fp32.onnx",
    input: 640,
    classes: &[
        "FEMALE_FACE",
        "MALE_FACE",
        "FEMALE_GENITALIA_COVERED",
        "FEMALE_GENITALIA_EXPOSED",
        "BUTTOCKS_COVERED",
        "BUTTOCKS_EXPOSED",
        "FEMALE_BREAST_COVERED",
        "FEMALE_BREAST_EXPOSED",
        "MALE_BREAST_EXPOSED",
        "ARMPITS_EXPOSED",
        "BELLY_EXPOSED",
        "MALE_GENITALIA_EXPOSED",
        "ANUS_EXPOSED",
        "FEET_COVERED",
        "FEET_EXPOSED",
        "EYE",
    ],
    url: "https://huggingface.co/Perfectfox256/hotscreen-detection-models/resolve/main/yolo-07-2025/hs-real-anime-y11s-640-fp32.onnx",
    sha256: "bd2f67c628adb20ab2f1ffdd45c37015103f6fa6140e1a6a942dbbc3121a44a9",
    size_mb: 37,
    licence: "AGPL-3.0-only",
    licence_url: AGPL_URL,
    source_url: "https://huggingface.co/Perfectfox256/hotscreen-detection-models",
};

/// NudeNet's small detector. GitHub's release asset endpoint, since the human URL is
/// login-walled; the host asks for `application/octet-stream`.
pub const NUDENET: ModelSpec = ModelSpec {
    id: "nudenet",
    label: "NudeNet 320n",
    file: "320n.onnx",
    input: 320,
    classes: &[
        "FEMALE_GENITALIA_COVERED",
        "FACE_FEMALE",
        "BUTTOCKS_EXPOSED",
        "FEMALE_BREAST_EXPOSED",
        "FEMALE_GENITALIA_EXPOSED",
        "MALE_BREAST_EXPOSED",
        "ANUS_EXPOSED",
        "FEET_EXPOSED",
        "BELLY_COVERED",
        "FEET_COVERED",
        "ARMPITS_COVERED",
        "ARMPITS_EXPOSED",
        "FACE_MALE",
        "BELLY_EXPOSED",
        "MALE_GENITALIA_EXPOSED",
        "ANUS_COVERED",
        "FEMALE_BREAST_COVERED",
        "BUTTOCKS_COVERED",
    ],
    url: "https://api.github.com/repos/notAI-tech/NudeNet/releases/assets/176831997",
    sha256: "c15d8273adad2d0a92f014cc69ab2d6c311a06777a55545f2c4eb46f51911f0f",
    size_mb: 12,
    licence: "AGPL-3.0-only",
    licence_url: "https://raw.githubusercontent.com/notAI-tech/NudeNet/bac927ae7ef3ea6b57c175e3fb36686a1115db16/LICENSE",
    source_url: "https://github.com/notAI-tech/NudeNet",
};

pub const MODELS: &[ModelSpec] = &[HOTSCREEN, NUDENET];

pub fn model(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

const CONF_THRESHOLD: f32 = 0.35;
const IOU_THRESHOLD: f32 = 0.45;
/// Ultralytics' letterbox padding grey.
const PAD: f32 = 114.0 / 255.0;

/// A rectangle in 0..1 of the frame, top-left origin.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn centre(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }

    /// Grown by `padding` of its own size on every side, kept inside the frame.
    pub fn padded(&self, padding: f64) -> Rect {
        let (dx, dy) = (self.w * padding, self.h * padding);
        let x = (self.x - dx).max(0.0);
        let y = (self.y - dy).max(0.0);
        Rect { x, y, w: (self.x + self.w + dx).min(1.0) - x, h: (self.y + self.h + dy).min(1.0) - y }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Detection {
    pub class: &'static str,
    pub confidence: f32,
    pub rect: Rect,
}

/// What a detection is for the region rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Target {
    Genitals,
    Face,
}

impl Target {
    /// Class names are shared across the models (NudeNet's vocabulary, which HotScreen kept).
    pub fn of(class: &str) -> Option<Target> {
        if (class.contains("GENITALIA") && class.ends_with("EXPOSED")) || class == "ANUS_EXPOSED" {
            Some(Target::Genitals)
        } else if class.contains("FACE") {
            Some(Target::Face)
        } else {
            None
        }
    }
}

/// Groups of classes a user can pick to drive a parameter from how much of the picture they
/// cover. Covered classes, armpits, belly and eyes are not offered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Genitals,
    Breasts,
    Buttocks,
    Faces,
    Feet,
    /// Every exposed class.
    Skin,
}

impl Kind {
    pub const ALL: [Kind; 6] = [Kind::Genitals, Kind::Breasts, Kind::Buttocks, Kind::Faces, Kind::Feet, Kind::Skin];
    pub const COUNT: usize = Self::ALL.len();

    pub fn id(self) -> &'static str {
        match self {
            Kind::Genitals => "genitals",
            Kind::Breasts => "breasts",
            Kind::Buttocks => "buttocks",
            Kind::Faces => "faces",
            Kind::Feet => "feet",
            Kind::Skin => "skin",
        }
    }

    pub fn from_id(s: &str) -> Option<Kind> {
        Self::ALL.iter().copied().find(|k| k.id() == s)
    }

    pub fn index(self) -> usize {
        Self::ALL.iter().position(|k| *k == self).unwrap_or(0)
    }

    pub fn matches(self, class: &str) -> bool {
        match self {
            Kind::Genitals => class.contains("GENITALIA") && class.ends_with("EXPOSED"),
            Kind::Breasts => class.contains("BREAST") && class.ends_with("EXPOSED"),
            Kind::Buttocks => class == "BUTTOCKS_EXPOSED" || class == "ANUS_EXPOSED",
            Kind::Faces => class.contains("FACE"),
            Kind::Feet => class == "FEET_EXPOSED",
            Kind::Skin => class.ends_with("EXPOSED"),
        }
    }
}

/// Share of the frame that reads as full coverage.
pub const FULL_COVERAGE: f64 = 0.4;

/// How much of the frame each kind covers, 0..1: the summed box area of its classes over the
/// frame, with `FULL_COVERAGE` of the frame as 1.
pub fn coverage(dets: &[Detection]) -> [f64; Kind::COUNT] {
    let mut out = [0.0; Kind::COUNT];
    for (i, kind) in Kind::ALL.iter().enumerate() {
        let area: f64 = dets.iter().filter(|d| kind.matches(d.class)).map(|d| d.rect.w * d.rect.h).sum();
        out[i] = (area / FULL_COVERAGE).min(1.0);
    }
    out
}

/// The box the tracker should follow. With no `kind`: genitals before faces. With one: that
/// kind only. Among those, the one nearest the centre of the picture (more than one person in
/// shot: the middle one), larger on a tie.
pub fn choose(dets: &[Detection], kind: Option<Kind>) -> Option<Detection> {
    let mut best: Option<(Target, f64, Detection)> = None;
    for d in dets {
        let target = match kind {
            Some(k) if k.matches(d.class) => Target::Genitals,
            Some(_) => continue,
            None => match Target::of(d.class) {
                Some(t) => t,
                None => continue,
            },
        };
        let (cx, cy) = d.rect.centre();
        let dist = ((cx - 0.5).powi(2) + (cy - 0.5).powi(2)).sqrt() - d.rect.w * d.rect.h * 0.05;
        let better = match &best {
            None => true,
            Some((t, dd, _)) => target < *t || (target == *t && dist < *dd),
        };
        if better {
            best = Some((target, dist, *d));
        }
    }
    best.map(|(_, _, d)| d)
}

/// One loaded model. Construct once (loading compiles the graph; CoreML takes seconds the
/// first time), then `detect` from one thread.
pub struct Detector {
    session: Session,
    input_name: String,
    spec: &'static ModelSpec,
    provider: &'static str,
    input: Vec<f32>,
}

impl Detector {
    /// Loads `path`, a file the host has already downloaded and verified against `spec`.
    /// `cache_dir` holds the compiled CoreML graph so later loads are quick.
    pub fn load(spec: &'static ModelSpec, path: &Path, cache_dir: Option<&Path>) -> Result<Detector, String> {
        let mut builder = Session::builder()
            .and_then(|b| b.with_optimization_level(GraphOptimizationLevel::Level3))
            .and_then(|b| b.with_intra_threads(2))
            .and_then(|b| b.with_intra_op_spinning(false))
            .map_err(|e| e.to_string())?;
        let provider = register_provider(&mut builder, cache_dir);
        let session = builder.commit_from_file(path).map_err(|e| e.to_string())?;
        let input_name = session.inputs.first().map(|i| i.name.clone()).ok_or("model has no inputs")?;
        Ok(Detector { session, input_name, spec, provider, input: Vec::new() })
    }

    pub fn spec(&self) -> &'static ModelSpec {
        self.spec
    }

    /// `coreml` or `cpu`.
    pub fn provider(&self) -> &'static str {
        self.provider
    }

    /// Runs the model on a packed RGB frame and returns every box past the confidence
    /// threshold after class-wise suppression, in 0..1 of the frame.
    pub fn detect(&mut self, rgb: &[u8], width: usize, height: usize) -> Result<Vec<Detection>, String> {
        if width == 0 || height == 0 || rgb.len() < width * height * 3 {
            return Err(format!("frame is {} bytes, expected {}x{}x3", rgb.len(), width, height));
        }
        let size = self.spec.input as usize;
        let fit = letterbox(rgb, width, height, size, &mut self.input);
        let tensor = TensorRef::from_array_view(([1usize, 3, size, size], self.input.as_slice())).map_err(|e| e.to_string())?;
        let outputs = self.session.run(ort::inputs![self.input_name.as_str() => tensor]).map_err(|e| e.to_string())?;
        let (shape, raw) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let dims: Vec<i64> = shape.iter().copied().collect();
        let boxes = nms(decode(raw, &dims, self.spec.classes.len(), CONF_THRESHOLD), IOU_THRESHOLD);
        Ok(boxes
            .into_iter()
            .map(|b| {
                let (x0, y0) = fit.unmap(b.x0, b.y0);
                let (x1, y1) = fit.unmap(b.x1, b.y1);
                Detection {
                    class: self.spec.classes[b.class],
                    confidence: b.confidence,
                    rect: Rect { x: x0 as f64 / width as f64, y: y0 as f64 / height as f64, w: (x1 - x0) as f64 / width as f64, h: (y1 - y0) as f64 / height as f64 },
                }
            })
            .collect())
    }
}

#[cfg(target_os = "macos")]
fn register_provider(builder: &mut ort::session::builder::SessionBuilder, cache_dir: Option<&Path>) -> &'static str {
    use ort::execution_providers::ExecutionProvider;
    use ort::execution_providers::coreml::{CoreMLComputeUnits, CoreMLExecutionProvider, CoreMLModelFormat};
    let mut ep = CoreMLExecutionProvider::default().with_model_format(CoreMLModelFormat::MLProgram).with_compute_units(CoreMLComputeUnits::CPUAndNeuralEngine);
    if let Some(dir) = cache_dir {
        ep = ep.with_model_cache_dir(dir.display());
    }
    match ep.register(builder) {
        Ok(()) => "coreml",
        Err(_) => "cpu",
    }
}

#[cfg(not(target_os = "macos"))]
fn register_provider(_builder: &mut ort::session::builder::SessionBuilder, _cache_dir: Option<&Path>) -> &'static str {
    "cpu"
}

/// How the frame was placed in the square model input, so boxes map back.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Fit {
    scale: f32,
    pad_x: f32,
    pad_y: f32,
}

impl Fit {
    fn unmap(&self, x: f32, y: f32) -> (f32, f32) {
        ((x - self.pad_x) / self.scale, (y - self.pad_y) / self.scale)
    }
}

/// Scales the frame to fit `size` square, centred on grey padding, bilinear, into a planar RGB
/// tensor of 0..1 floats.
fn letterbox(rgb: &[u8], width: usize, height: usize, size: usize, out: &mut Vec<f32>) -> Fit {
    let scale = (size as f32 / width as f32).min(size as f32 / height as f32);
    let out_w = ((width as f32 * scale).round() as usize).clamp(1, size);
    let out_h = ((height as f32 * scale).round() as usize).clamp(1, size);
    let pad_x = (size - out_w) / 2;
    let pad_y = (size - out_h) / 2;
    out.clear();
    out.resize(3 * size * size, PAD);
    let plane = size * size;
    for oy in 0..out_h {
        let sy = ((oy as f32 + 0.5) / scale - 0.5).clamp(0.0, (height - 1) as f32);
        let y0 = sy.floor() as usize;
        let y1 = (y0 + 1).min(height - 1);
        let fy = sy - y0 as f32;
        let row = (pad_y + oy) * size + pad_x;
        for ox in 0..out_w {
            let sx = ((ox as f32 + 0.5) / scale - 0.5).clamp(0.0, (width - 1) as f32);
            let x0 = sx.floor() as usize;
            let x1 = (x0 + 1).min(width - 1);
            let fx = sx - x0 as f32;
            for c in 0..3 {
                let at = |x: usize, y: usize| rgb[(y * width + x) * 3 + c] as f32;
                let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
                let bot = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
                out[c * plane + row + ox] = (top + (bot - top) * fy) / 255.0;
            }
        }
    }
    Fit { scale, pad_x: pad_x as f32, pad_y: pad_y as f32 }
}

/// One decoded box in model-input pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Raw {
    class: usize,
    confidence: f32,
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
}

impl Raw {
    fn area(&self) -> f32 {
        (self.x1 - self.x0).max(0.0) * (self.y1 - self.y0).max(0.0)
    }

    fn iou(&self, o: &Raw) -> f32 {
        let inter = (self.x1.min(o.x1) - self.x0.max(o.x0)).max(0.0) * (self.y1.min(o.y1) - self.y0.max(o.y0)).max(0.0);
        let union = self.area() + o.area() - inter;
        if union <= 0.0 { 0.0 } else { inter / union }
    }
}

/// A YOLOv8-style head, `[1, 4 + classes, N]` (stock export) or `[1, N, 4 + classes]`:
/// each anchor is centre, size and one score per class.
fn decode(data: &[f32], shape: &[i64], classes: usize, threshold: f32) -> Vec<Raw> {
    let attrs = 4 + classes;
    let (n, attr_major) = match shape {
        [_, a, n] if *a as usize == attrs => (*n as usize, true),
        [_, n, a] if *a as usize == attrs => (*n as usize, false),
        _ => return Vec::new(),
    };
    if data.len() < n * attrs {
        return Vec::new();
    }
    let at = |anchor: usize, attr: usize| if attr_major { data[attr * n + anchor] } else { data[anchor * attrs + attr] };
    let mut out = Vec::new();
    for i in 0..n {
        let (mut class, mut confidence) = (0, 0.0f32);
        for c in 0..classes {
            let s = at(i, 4 + c);
            if s > confidence {
                class = c;
                confidence = s;
            }
        }
        if confidence < threshold {
            continue;
        }
        let (cx, cy, w, h) = (at(i, 0), at(i, 1), at(i, 2), at(i, 3));
        if !(cx.is_finite() && cy.is_finite() && w.is_finite() && h.is_finite()) {
            continue;
        }
        out.push(Raw { class, confidence, x0: cx - w / 2.0, y0: cy - h / 2.0, x1: cx + w / 2.0, y1: cy + h / 2.0 });
    }
    out
}

/// Keeps the strongest box of every overlapping same-class cluster.
fn nms(mut dets: Vec<Raw>, iou: f32) -> Vec<Raw> {
    dets.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
    let mut keep: Vec<Raw> = Vec::with_capacity(dets.len());
    'next: for d in dets {
        for k in &keep {
            if k.class == d.class && k.iou(&d) > iou {
                continue 'next;
            }
        }
        keep.push(d);
    }
    keep
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coverage_sums_the_chosen_classes_and_caps_at_full() {
        let d = |class, w, h| Detection { class, confidence: 0.9, rect: Rect { x: 0.1, y: 0.1, w, h } };
        let dets = [d("FEMALE_GENITALIA_EXPOSED", 0.2, 0.5), d("FEMALE_BREAST_EXPOSED", 0.2, 0.2), d("FEMALE_FACE", 0.1, 0.1), d("BUTTOCKS_COVERED", 0.5, 0.5)];
        let c = coverage(&dets);
        assert!((c[Kind::Genitals.index()] - 0.25).abs() < 1e-9, "{c:?}");
        assert!((c[Kind::Breasts.index()] - 0.1).abs() < 1e-9);
        assert!((c[Kind::Faces.index()] - 0.025).abs() < 1e-9);
        assert_eq!(c[Kind::Buttocks.index()], 0.0, "covered classes do not count");
        assert!((c[Kind::Skin.index()] - 0.35).abs() < 1e-9, "every exposed class");
        assert_eq!(coverage(&[d("ANUS_EXPOSED", 1.0, 1.0)])[Kind::Buttocks.index()], 1.0);
        for k in Kind::ALL {
            assert_eq!(Kind::from_id(k.id()), Some(k));
        }
    }

    fn det(class: &'static str, confidence: f32, x: f64, y: f64, w: f64, h: f64) -> Detection {
        Detection { class, confidence, rect: Rect { x, y, w, h } }
    }

    #[test]
    fn genitals_beat_faces_and_the_middle_one_wins() {
        let dets = [
            det("FEMALE_FACE", 0.9, 0.45, 0.1, 0.1, 0.1),
            det("FEMALE_GENITALIA_EXPOSED", 0.6, 0.05, 0.5, 0.1, 0.1),
            det("MALE_GENITALIA_EXPOSED", 0.5, 0.45, 0.6, 0.1, 0.1),
            det("BELLY_EXPOSED", 0.99, 0.4, 0.4, 0.2, 0.2),
        ];
        assert_eq!(choose(&dets, None).unwrap().class, "MALE_GENITALIA_EXPOSED");
        assert_eq!(choose(&dets[..1], None).unwrap().class, "FEMALE_FACE");
        assert_eq!(choose(&dets, Some(Kind::Faces)).unwrap().class, "FEMALE_FACE", "a picked kind ignores the rule");
        assert_eq!(choose(&dets, Some(Kind::Breasts)), None, "nothing of that kind in shot");
        assert!(choose(&dets[3..], None).is_none());
        assert_eq!(Target::of("ANUS_EXPOSED"), Some(Target::Genitals));
        assert_eq!(Target::of("FEMALE_GENITALIA_COVERED"), None);
        assert_eq!(Target::of("FACE_MALE"), Some(Target::Face));
    }

    #[test]
    fn padding_stays_inside_the_frame() {
        let r = Rect { x: 0.9, y: 0.1, w: 0.1, h: 0.2 }.padded(0.5);
        assert!((r.x - 0.85).abs() < 1e-9 && (r.x + r.w - 1.0).abs() < 1e-9);
        assert!((r.y - 0.0).abs() < 1e-9 && (r.h - 0.4).abs() < 1e-9);
    }

    #[test]
    fn letterbox_centres_a_wide_frame_and_maps_back() {
        let (w, h) = (64usize, 32usize);
        let mut rgb = vec![0u8; w * h * 3];
        // A white pixel at (40, 10).
        for c in 0..3 {
            rgb[(10 * w + 40) * 3 + c] = 255;
        }
        let mut out = Vec::new();
        let fit = letterbox(&rgb, w, h, 32, &mut out);
        assert_eq!(out.len(), 3 * 32 * 32);
        assert!((fit.scale - 0.5).abs() < 1e-6 && fit.pad_x == 0.0 && fit.pad_y == 8.0);
        // Padding rows are grey, the picture rows are not all grey.
        assert!((out[0] - PAD).abs() < 1e-6);
        let bright = (0..32 * 32).map(|i| out[i]).fold(0.0f32, f32::max);
        assert!(bright > 0.2, "the white pixel should survive the downscale: {bright}");
        let (x, y) = fit.unmap(20.0, 13.0);
        assert!((x - 40.0).abs() < 1e-5 && (y - 10.0).abs() < 1e-5);
    }

    #[test]
    fn decode_reads_both_layouts_and_nms_merges() {
        // Two classes, three anchors: two overlapping class-1 boxes and one weak one.
        let rows = [[100.0, 100.0, 40.0, 40.0, 0.1, 0.9], [102.0, 101.0, 40.0, 40.0, 0.1, 0.8], [50.0, 50.0, 10.0, 10.0, 0.2, 0.1]];
        let anchor_major: Vec<f32> = rows.iter().flatten().copied().collect();
        let mut attr_major = vec![0.0f32; 6 * 3];
        for (i, row) in rows.iter().enumerate() {
            for (a, v) in row.iter().enumerate() {
                attr_major[a * 3 + i] = *v;
            }
        }
        let a = decode(&anchor_major, &[1, 3, 6], 2, 0.5);
        let b = decode(&attr_major, &[1, 6, 3], 2, 0.5);
        assert_eq!(a, b);
        assert_eq!(a.len(), 2);
        let kept = nms(a, 0.45);
        assert_eq!(kept.len(), 1);
        assert!((kept[0].confidence - 0.9).abs() < 1e-6);
        assert!(decode(&anchor_major, &[1, 3, 7], 2, 0.5).is_empty(), "a shape that matches no layout decodes to nothing");
    }

    /// Runs a real model when `BP_MODEL_DIR` points at a folder holding it. Not a CI test:
    /// the weights are downloaded on demand and never bundled.
    #[test]
    fn real_model_finds_something_in_a_frame() {
        let Ok(dir) = std::env::var("BP_MODEL_DIR") else { return };
        let Ok(frame) = std::env::var("BP_TEST_FRAME") else { return };
        // `frame` is a raw RGB file named `<name>_<w>x<h>.rgb`.
        let stem = std::path::Path::new(&frame).file_stem().unwrap().to_string_lossy().to_string();
        let dims = stem.rsplit('_').next().unwrap();
        let (w, h) = dims.split_once('x').unwrap();
        let (w, h): (usize, usize) = (w.parse().unwrap(), h.parse().unwrap());
        let rgb = std::fs::read(&frame).unwrap();
        for spec in MODELS {
            let path = std::path::Path::new(&dir).join(spec.file);
            if !path.exists() {
                continue;
            }
            let t0 = std::time::Instant::now();
            let mut d = Detector::load(spec, &path, None).unwrap();
            let load = t0.elapsed();
            let t1 = std::time::Instant::now();
            let dets = d.detect(&rgb, w, h).unwrap();
            let run = t1.elapsed();
            let _ = d.detect(&rgb, w, h).unwrap();
            let run2 = t1.elapsed() - run;
            println!("{} on {}: load {:?}, first run {:?}, second {:?}", spec.label, d.provider(), load, run, run2);
            for x in &dets {
                println!("  {} {:.2} at {:.2},{:.2} {:.2}x{:.2}", x.class, x.confidence, x.rect.x, x.rect.y, x.rect.w, x.rect.h);
            }
            println!("  chosen: {:?}", choose(&dets, None).map(|c| c.class));
        }
    }
}
