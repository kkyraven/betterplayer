use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub mod skin;
pub mod tagger;
pub use skin::{Skin, SkinMask};
pub use tagger::Tagger;

use ort::session::{
    Session,
    builder::{GraphOptimizationLevel, SessionBuilder},
};
use ort::value::TensorRef;

#[derive(Clone, Debug, PartialEq)]
pub struct Variant {
    pub width: u32,
    pub height: u32,
    pub path: PathBuf,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelSpec {
    pub id: &'static str,
    pub classes: Vec<&'static str>,
    pub variants: Vec<Variant>,
}

impl ModelSpec {
    pub fn new(id: &str, classes: &[String], variants: Vec<Variant>) -> ModelSpec {
        ModelSpec { id: intern(id), classes: classes.iter().map(|c| intern(&vocabulary(c))).collect(), variants }
    }
}

static NAMES: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());

fn intern(name: &str) -> &'static str {
    let mut names = NAMES.lock().unwrap();
    if let Some(n) = names.iter().find(|n| **n == name) {
        return n;
    }
    let leaked: &'static str = Box::leak(name.to_string().into_boxed_str());
    names.push(leaked);
    leaked
}

pub fn vocabulary(raw: &str) -> String {
    let up = raw.trim().to_ascii_uppercase();
    let (part, state) = match up.rsplit_once('_') {
        Some((p, s)) if s == "EXPOSED" || s == "COVERED" => (p, Some(s)),
        _ => (up.as_str(), None),
    };
    let part = match part {
        "PENIS" => "MALE_GENITALIA",
        "VAGINA" => "FEMALE_GENITALIA",
        "GENITALS" => "GENITALIA",
        "BREAST" | "NIPPLE" | "FEMALE_NIPPLE" => "FEMALE_BREAST",
        "MALE_NIPPLE" => "MALE_BREAST",
        "FOOT" => "FEET",
        p => p,
    };
    match state {
        Some(s) => format!("{part}_{s}"),
        None => part.to_string(),
    }
}

pub fn nearest_variant(variants: &[Variant], width: usize, height: usize) -> usize {
    let aspect = width.max(1) as f64 / height.max(1) as f64;
    let off = |v: &Variant| ((v.width as f64 / v.height.max(1) as f64) / aspect).ln().abs();
    (0..variants.len()).min_by(|a, b| off(&variants[*a]).total_cmp(&off(&variants[*b]))).unwrap_or(0)
}

const CONF_THRESHOLD: f32 = 0.35;
const IOU_THRESHOLD: f32 = 0.45;
const PAD: f32 = 114.0 / 255.0;

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Target {
    Genitals,
    Buttocks,
    GenitalsCovered,
    ButtocksCovered,
    Face,
    Breasts,
    BreastsCovered,
}

impl Target {
    pub fn of(class: &str) -> Option<Target> {
        let exposed = class.ends_with("EXPOSED");
        if (class.contains("GENITALIA") && exposed) || class == "ANUS_EXPOSED" {
            Some(Target::Genitals)
        } else if class == "BUTTOCKS_EXPOSED" {
            Some(Target::Buttocks)
        } else if class.contains("GENITALIA") || class == "ANUS_COVERED" {
            Some(Target::GenitalsCovered)
        } else if class == "BUTTOCKS_COVERED" {
            Some(Target::ButtocksCovered)
        } else if class.contains("FACE") {
            Some(Target::Face)
        } else if class.contains("BREAST") {
            Some(if exposed { Target::Breasts } else { Target::BreastsCovered })
        } else {
            None
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Genitals,
    Breasts,
    Buttocks,
    Faces,
    Feet,
    Skin,
    GenitalsCovered,
    BreastsCovered,
    ButtocksCovered,
    FeetCovered,
}

impl Kind {
    pub const ALL: [Kind; 10] = [
        Kind::Genitals,
        Kind::Breasts,
        Kind::Buttocks,
        Kind::Faces,
        Kind::Feet,
        Kind::Skin,
        Kind::GenitalsCovered,
        Kind::BreastsCovered,
        Kind::ButtocksCovered,
        Kind::FeetCovered,
    ];
    pub const COUNT: usize = Self::ALL.len();

    pub fn id(self) -> &'static str {
        match self {
            Kind::Genitals => "genitals",
            Kind::Breasts => "breasts",
            Kind::Buttocks => "buttocks",
            Kind::Faces => "faces",
            Kind::Feet => "feet",
            Kind::Skin => "skin",
            Kind::GenitalsCovered => "genitalsCovered",
            Kind::BreastsCovered => "breastsCovered",
            Kind::ButtocksCovered => "buttocksCovered",
            Kind::FeetCovered => "feetCovered",
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
            Kind::GenitalsCovered => class.contains("GENITALIA") && class.ends_with("COVERED"),
            Kind::BreastsCovered => class.contains("BREAST") && class.ends_with("COVERED"),
            Kind::ButtocksCovered => class == "BUTTOCKS_COVERED" || class == "ANUS_COVERED",
            Kind::FeetCovered => class == "FEET_COVERED",
        }
    }
}

pub const FULL_COVERAGE: f64 = 0.4;

pub fn coverage(dets: &[Detection]) -> [f64; Kind::COUNT] {
    let mut out = [0.0; Kind::COUNT];
    for (i, kind) in Kind::ALL.iter().enumerate() {
        let area: f64 = dets.iter().filter(|d| kind.matches(d.class)).map(|d| d.rect.w * d.rect.h).sum();
        out[i] = (area / FULL_COVERAGE).min(1.0);
    }
    out
}

pub fn choose(dets: &[Detection], kind: Option<Kind>, floor: Option<Target>) -> Option<Detection> {
    let mut best: Option<(Target, f64, Detection)> = None;
    for d in dets {
        let target = match kind {
            Some(k) if k.matches(d.class) => Target::Genitals,
            Some(_) => continue,
            None => match Target::of(d.class) {
                Some(t) if floor.is_none_or(|f| t <= f) => t,
                _ => continue,
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

pub(crate) struct Shape {
    pub(crate) session: Session,
    pub(crate) input_name: String,
    pub(crate) width: usize,
    pub(crate) height: usize,
}

pub(crate) fn open_shapes(variants: &[Variant], cache_dir: Option<&Path>) -> Result<(Vec<Shape>, &'static str), String> {
    if variants.is_empty() {
        return Err("model has no files".into());
    }
    let mut provider = "cpu";
    let mut shapes = Vec::with_capacity(variants.len());
    for v in variants {
        let (builder, p) = register_provider(session_builder()?, cache_dir)?;
        provider = p;
        let session = builder.commit_from_file(&v.path).map_err(|e| format!("{}: {e}", v.path.display()))?;
        let input_name = session.inputs.first().map(|i| i.name.clone()).ok_or("model has no inputs")?;
        shapes.push(Shape { session, input_name, width: v.width as usize, height: v.height as usize });
    }
    Ok((shapes, provider))
}

pub struct Detector {
    shapes: Vec<Shape>,
    spec: Arc<ModelSpec>,
    provider: &'static str,
    input: Vec<f32>,
    threshold: f32,
}

impl Detector {
    pub fn load(spec: Arc<ModelSpec>, cache_dir: Option<&Path>) -> Result<Detector, String> {
        let (shapes, provider) = open_shapes(&spec.variants, cache_dir)?;
        Ok(Detector { shapes, spec, provider, input: Vec::new(), threshold: CONF_THRESHOLD })
    }

    pub fn spec(&self) -> &Arc<ModelSpec> {
        &self.spec
    }

    pub fn provider(&self) -> &'static str {
        self.provider
    }

    pub fn set_threshold(&mut self, threshold: f32) {
        self.threshold = threshold;
    }

    pub fn detect(&mut self, rgb: &[u8], width: usize, height: usize) -> Result<Vec<Detection>, String> {
        if width == 0 || height == 0 || rgb.len() < width * height * 3 {
            return Err(format!("frame is {} bytes, expected {}x{}x3", rgb.len(), width, height));
        }
        let shape = &mut self.shapes[nearest_variant(&self.spec.variants, width, height)];
        let (sw, sh) = (shape.width, shape.height);
        let fit = letterbox(rgb, width, height, sw, sh, &mut self.input);
        let tensor = TensorRef::from_array_view(([1usize, 3, sh, sw], self.input.as_slice())).map_err(|e| e.to_string())?;
        let outputs = shape.session.run(ort::inputs![shape.input_name.as_str() => tensor]).map_err(|e| e.to_string())?;
        let (out_shape, raw) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let dims: Vec<i64> = out_shape.iter().copied().collect();
        let classes = &self.spec.classes;
        let boxes = nms(decode(raw, &dims, classes.len(), self.threshold), IOU_THRESHOLD);
        Ok(boxes
            .into_iter()
            .map(|b| {
                let (x0, y0) = fit.unmap(b.x0, b.y0);
                let (x1, y1) = fit.unmap(b.x1, b.y1);
                let (x0, y0) = (x0.max(0.0), y0.max(0.0));
                let (x1, y1) = (x1.min(width as f32), y1.min(height as f32));
                Detection {
                    class: classes[b.class],
                    confidence: b.confidence,
                    rect: Rect { x: x0 as f64 / width as f64, y: y0 as f64 / height as f64, w: (x1 - x0).max(0.0) as f64 / width as f64, h: (y1 - y0).max(0.0) as f64 / height as f64 },
                }
            })
            .collect())
    }
}

fn session_builder() -> Result<SessionBuilder, String> {
    Session::builder()
        .and_then(|b| b.with_optimization_level(GraphOptimizationLevel::Level3))
        .and_then(|b| b.with_intra_threads(2))
        .and_then(|b| b.with_intra_op_spinning(false))
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn register_provider(mut builder: SessionBuilder, cache_dir: Option<&Path>) -> Result<(SessionBuilder, &'static str), String> {
    use ort::execution_providers::ExecutionProvider;
    use ort::execution_providers::coreml::{CoreMLComputeUnits, CoreMLExecutionProvider, CoreMLModelFormat};
    let mut ep = CoreMLExecutionProvider::default().with_model_format(CoreMLModelFormat::MLProgram).with_compute_units(CoreMLComputeUnits::CPUAndNeuralEngine);
    if let Some(dir) = cache_dir {
        ep = ep.with_model_cache_dir(dir.display());
    }
    let provider = match ep.register(&mut builder) {
        Ok(()) => "coreml",
        Err(_) => "cpu",
    };
    Ok((builder, provider))
}

#[cfg(windows)]
fn register_provider(builder: SessionBuilder, _cache_dir: Option<&Path>) -> Result<(SessionBuilder, &'static str), String> {
    use ort::execution_providers::ExecutionProvider;
    use ort::execution_providers::directml::DirectMLExecutionProvider;
    let ep = DirectMLExecutionProvider::default();
    if !ep.is_available().unwrap_or(false) {
        return Ok((builder, "cpu"));
    }
    let mut builder = builder.with_memory_pattern(false).map_err(|e| e.to_string())?;
    match ep.register(&mut builder) {
        Ok(()) => Ok((builder, "directml")),
        Err(_) => Ok((builder.with_memory_pattern(true).map_err(|e| e.to_string())?, "cpu")),
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn register_provider(builder: SessionBuilder, _cache_dir: Option<&Path>) -> Result<(SessionBuilder, &'static str), String> {
    Ok((builder, "cpu"))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Fit {
    pub(crate) scale: f32,
    pub(crate) pad_x: f32,
    pub(crate) pad_y: f32,
    pub(crate) fit_w: usize,
    pub(crate) fit_h: usize,
}

impl Fit {
    fn unmap(&self, x: f32, y: f32) -> (f32, f32) {
        ((x - self.pad_x) / self.scale, (y - self.pad_y) / self.scale)
    }
}

pub(crate) fn letterbox(rgb: &[u8], width: usize, height: usize, out_w: usize, out_h: usize, out: &mut Vec<f32>) -> Fit {
    let scale = (out_w as f32 / width as f32).min(out_h as f32 / height as f32);
    let fit_w = ((width as f32 * scale).round() as usize).clamp(1, out_w);
    let fit_h = ((height as f32 * scale).round() as usize).clamp(1, out_h);
    let pad_x = (out_w - fit_w) / 2;
    let pad_y = (out_h - fit_h) / 2;
    out.clear();
    out.resize(3 * out_w * out_h, PAD);
    let plane = out_w * out_h;
    for oy in 0..fit_h {
        let sy = ((oy as f32 + 0.5) / scale - 0.5).clamp(0.0, (height - 1) as f32);
        let y0 = sy.floor() as usize;
        let y1 = (y0 + 1).min(height - 1);
        let fy = sy - y0 as f32;
        let row = (pad_y + oy) * out_w + pad_x;
        for ox in 0..fit_w {
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
    Fit { scale, pad_x: pad_x as f32, pad_y: pad_y as f32, fit_w, fit_h }
}

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
        assert!((c[Kind::ButtocksCovered.index()] - 0.625).abs() < 1e-9, "but count for the covered kind");
        assert_eq!(c[Kind::GenitalsCovered.index()], 0.0);
        assert!(Kind::GenitalsCovered.matches("FEMALE_GENITALIA_COVERED") && !Kind::Genitals.matches("FEMALE_GENITALIA_COVERED"));
        assert!(Kind::ButtocksCovered.matches("ANUS_COVERED") && Kind::FeetCovered.matches("FEET_COVERED"));
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
            det("BUTTOCKS_EXPOSED", 0.8, 0.3, 0.5, 0.2, 0.2),
            det("FEMALE_BREAST_EXPOSED", 0.8, 0.4, 0.3, 0.1, 0.1),
        ];
        assert_eq!(choose(&dets, None, None).unwrap().class, "MALE_GENITALIA_EXPOSED");
        assert_eq!(choose(&dets[..1], None, None).unwrap().class, "FEMALE_FACE");
        assert_eq!(choose(&dets, Some(Kind::Faces), None).unwrap().class, "FEMALE_FACE", "a picked kind ignores the rule");
        assert_eq!(choose(&dets, Some(Kind::Feet), None), None, "nothing of that kind in shot");
        assert!(choose(&dets[3..4], None, None).is_none());
        assert_eq!(choose(&dets[3..], None, None).unwrap().class, "BUTTOCKS_EXPOSED");
        assert_eq!(choose(&[dets[0], dets[5]], None, None).unwrap().class, "FEMALE_FACE");
        let covered = [det("FEMALE_GENITALIA_COVERED", 0.8, 0.4, 0.4, 0.2, 0.2), det("BUTTOCKS_COVERED", 0.8, 0.4, 0.4, 0.2, 0.2)];
        assert_eq!(choose(&covered, None, None).unwrap().class, "FEMALE_GENITALIA_COVERED");
        assert_eq!(choose(&[covered[0], dets[0]], None, None).unwrap().class, "FEMALE_GENITALIA_COVERED", "covered genitals beat a face");
        assert_eq!(choose(&[covered[0], dets[4]], None, None).unwrap().class, "BUTTOCKS_EXPOSED");
        assert_eq!(choose(&dets[3..], None, Some(Target::Genitals)), None);
        assert_eq!(choose(&[det("FEMALE_BREAST_COVERED", 0.8, 0.4, 0.4, 0.2, 0.2)], None, Some(Target::Face)), None, "covered breasts wait for a held face");
        assert_eq!(choose(&dets[3..], None, Some(Target::Buttocks)).unwrap().class, "BUTTOCKS_EXPOSED");
        assert_eq!(choose(&dets, None, Some(Target::Breasts)).unwrap().class, "MALE_GENITALIA_EXPOSED", "a better target always may");
        assert_eq!(Target::of("ANUS_EXPOSED"), Some(Target::Genitals));
        assert_eq!(Target::of("BUTTOCKS_COVERED"), Some(Target::ButtocksCovered));
        assert_eq!(Target::of("FEMALE_GENITALIA_COVERED"), Some(Target::GenitalsCovered));
        assert_eq!(Target::of("FEMALE_BREAST_COVERED"), Some(Target::BreastsCovered));
        assert_eq!(Target::of("BELLY_COVERED"), None);
        assert_eq!(Target::of("FACE_MALE"), Some(Target::Face));
        assert_eq!(Target::of("MALE_BREAST_EXPOSED"), Some(Target::Breasts));
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
        for c in 0..3 {
            rgb[(10 * w + 40) * 3 + c] = 255;
        }
        let mut out = Vec::new();
        let fit = letterbox(&rgb, w, h, 32, 32, &mut out);
        assert_eq!(out.len(), 3 * 32 * 32);
        assert!((fit.scale - 0.5).abs() < 1e-6 && fit.pad_x == 0.0 && fit.pad_y == 8.0);
        assert!((out[0] - PAD).abs() < 1e-6);
        let bright = (0..32 * 32).map(|i| out[i]).fold(0.0f32, f32::max);
        assert!(bright > 0.2, "the white pixel should survive the downscale: {bright}");
        let (x, y) = fit.unmap(20.0, 13.0);
        assert!((x - 40.0).abs() < 1e-5 && (y - 10.0).abs() < 1e-5);
    }

    #[test]
    fn decode_reads_both_layouts_and_nms_merges() {
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

    #[test]
    fn nevermore_names_map_onto_the_vocabulary() {
        assert_eq!(vocabulary("penis_exposed"), "MALE_GENITALIA_EXPOSED");
        assert_eq!(vocabulary("vagina_covered"), "FEMALE_GENITALIA_COVERED");
        assert_eq!(vocabulary("genitals_exposed"), "GENITALIA_EXPOSED");
        assert_eq!(vocabulary("nipple_exposed"), "FEMALE_BREAST_EXPOSED");
        assert_eq!(vocabulary("foot_covered"), "FEET_COVERED");
        assert_eq!(vocabulary("face"), "FACE");
        assert_eq!(vocabulary("FEMALE_GENITALIA_EXPOSED"), "FEMALE_GENITALIA_EXPOSED", "NudeNet names pass through");
        assert!(Kind::Genitals.matches(&vocabulary("genitals_exposed")) && Kind::Feet.matches(&vocabulary("foot_exposed")));
        assert_eq!(Target::of(&vocabulary("face")), Some(Target::Face));
        let a = ModelSpec::new("m", &["face".into()], Vec::new());
        let b = ModelSpec::new("m", &["face".into()], Vec::new());
        assert!(std::ptr::eq(a.classes[0], b.classes[0]), "interned once");
    }

    #[test]
    fn the_shape_nearest_the_frame_runs_it() {
        let v = |width, height| Variant { width, height, path: PathBuf::new() };
        let shapes = [v(640, 640), v(640, 384)];
        assert_eq!(nearest_variant(&shapes, 1920, 1080), 1);
        assert_eq!(nearest_variant(&shapes, 1080, 1920), 0, "portrait takes the square");
        assert_eq!(nearest_variant(&shapes, 1000, 1000), 0);
        assert_eq!(nearest_variant(&shapes[..1], 1920, 1080), 0);
    }

    #[test]
    fn letterbox_fits_a_wide_frame_into_a_wide_shape() {
        let rgb = vec![255u8; 64 * 36 * 3];
        let mut out = Vec::new();
        let fit = letterbox(&rgb, 64, 36, 32, 20, &mut out);
        assert_eq!(out.len(), 3 * 32 * 20);
        assert_eq!((fit.fit_w, fit.fit_h), (32, 18));
        assert_eq!(fit.pad_y, 1.0);
    }

    #[test]
    fn real_model_finds_something_in_a_frame() {
        let Ok(model) = std::env::var("BP_DETECTOR") else { return };
        let Ok(frame) = std::env::var("BP_TEST_FRAME") else { return };
        let (w, h, rgb) = read_frame(&frame);
        let classes: Vec<String> = ["person", "face", "female_breast_exposed", "female_breast_covered", "male_breast_exposed", "male_breast_covered", "penis_exposed", "penis_covered", "vagina_exposed", "vagina_covered", "buttocks_exposed", "buttocks_covered", "foot_exposed", "foot_covered"].iter().map(|s| s.to_string()).collect();
        let (vw, vh) = shape_of(&model);
        let spec = Arc::new(ModelSpec::new("test", &classes, vec![Variant { width: vw, height: vh, path: model.into() }]));
        let t0 = std::time::Instant::now();
        let mut d = Detector::load(spec, None).unwrap();
        let load = t0.elapsed();
        let t1 = std::time::Instant::now();
        let dets = d.detect(&rgb, w, h).unwrap();
        let run = t1.elapsed();
        let t2 = std::time::Instant::now();
        let _ = d.detect(&rgb, w, h).unwrap();
        println!("{} on {}: load {:?}, first run {:?}, second {:?}", vw, d.provider(), load, run, t2.elapsed());
        for x in &dets {
            println!("  {} {:.2} at {:.2},{:.2} {:.2}x{:.2}", x.class, x.confidence, x.rect.x, x.rect.y, x.rect.w, x.rect.h);
        }
        println!("  chosen: {:?}", choose(&dets, None, None).map(|c| c.class));
    }

    pub(crate) fn read_frame(frame: &str) -> (usize, usize, Vec<u8>) {
        let stem = std::path::Path::new(frame).file_stem().unwrap().to_string_lossy().to_string();
        let (w, h) = stem.rsplit('_').next().unwrap().split_once('x').unwrap();
        (w.parse().unwrap(), h.parse().unwrap(), std::fs::read(frame).unwrap())
    }

    pub(crate) fn shape_of(file: &str) -> (u32, u32) {
        let stem = std::path::Path::new(file).file_stem().unwrap().to_string_lossy().replace("_fp16", "");
        let tag = stem.rsplit('_').next().unwrap();
        match tag.split_once('x') {
            Some((w, h)) => (w.parse().unwrap(), h.parse().unwrap()),
            None => tag.parse().map(|n| (n, n)).unwrap_or((640, 640)),
        }
    }
}
