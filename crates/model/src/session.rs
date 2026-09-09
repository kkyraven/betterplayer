//! One ONNX session with its provider and its cost. The ladder is CoreML as an ML program on
//! the CPU and Neural Engine, then the CPU; the name and the fallback reason are kept for the
//! bar. Warmup runs the graph on zeros, once untimed for the provider's compile and then three
//! times for the median, so a slow machine is known before the first frame.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use ort::session::{Session as OrtSession, builder::GraphOptimizationLevel};
use ort::value::TensorRef;

use crate::meta::Meta;

/// A warmup median past this, in ms, and the model is too slow to run live.
pub const TOO_SLOW_MS: f64 = 20.0;

/// One head's values, `[frames, axes]` row-major.
pub struct Head {
    pub name: String,
    pub frames: usize,
    pub axes: usize,
    pub values: Vec<f32>,
}

impl Head {
    pub fn at(&self, frame: usize, axis: usize) -> f32 {
        self.values[frame * self.axes + axis]
    }
}

pub struct Session {
    session: OrtSession,
    input_name: String,
    /// `coreml` or `cpu`.
    pub provider: &'static str,
    /// Why the first choice was not taken.
    pub fallback: Option<String>,
    pub warmup_ms: f64,
    /// The last run's cost.
    pub run_ms: f64,
    shape: [usize; 3],
}

impl Session {
    /// Loads `path` (a file the host has verified), warms it up on a zero window of the
    /// metadata's shape. `cache_dir` keeps the compiled CoreML graph between runs.
    pub fn load(path: &Path, meta: &Meta, cache_dir: Option<&Path>) -> Result<Session, String> {
        let mut builder = OrtSession::builder()
            .and_then(|b| b.with_optimization_level(GraphOptimizationLevel::Level3))
            .and_then(|b| b.with_intra_threads(2))
            .and_then(|b| b.with_intra_op_spinning(false))
            .map_err(|e| e.to_string())?;
        let (provider, fallback) = register_provider(&mut builder, cache_dir);
        let session = builder.commit_from_file(path).map_err(|e| e.to_string())?;
        let input_name = session.inputs.first().map(|i| i.name.clone()).ok_or("model has no inputs")?;
        if input_name != meta.input_name {
            return Err(format!("the graph's input is {input_name}, the metadata says {}", meta.input_name));
        }
        let mut s = Session { session, input_name, provider, fallback, warmup_ms: 0.0, run_ms: 0.0, shape: meta.input_shape };
        let zeros = vec![0.0f32; s.shape[1] * s.shape[2]];
        // The first run carries the provider's lazy compile (CoreML on a cold cache took a
        // five-way graph to 20 ms once and 8 ms after), so it is run and not timed.
        s.run(&zeros)?;
        let mut times = Vec::new();
        for _ in 0..3 {
            let t0 = Instant::now();
            s.run(&zeros)?;
            times.push(t0.elapsed().as_secs_f64() * 1000.0);
        }
        times.sort_by(f64::total_cmp);
        s.warmup_ms = times[1];
        Ok(s)
    }

    pub fn too_slow(&self) -> bool {
        self.warmup_ms > TOO_SLOW_MS
    }

    /// Runs one window (`frames * width` floats) and returns every head.
    pub fn run(&mut self, window: &[f32]) -> Result<Vec<Head>, String> {
        let [_, frames, width] = self.shape;
        if window.len() != frames * width {
            return Err(format!("window is {} floats, expected {}", window.len(), frames * width));
        }
        let t0 = Instant::now();
        let tensor = TensorRef::from_array_view(([1usize, frames, width], window)).map_err(|e| e.to_string())?;
        let outputs = self.session.run(ort::inputs![self.input_name.as_str() => tensor]).map_err(|e| e.to_string())?;
        let mut heads = Vec::with_capacity(outputs.len());
        for (name, value) in outputs.iter() {
            let (shape, raw) = value.try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
            let (frames, axes) = match dims.as_slice() {
                [1, f, a] => (*f, *a),
                other => return Err(format!("{name}: unexpected shape {other:?}")),
            };
            heads.push(Head { name: name.to_string(), frames, axes, values: raw.to_vec() });
        }
        self.run_ms = t0.elapsed().as_secs_f64() * 1000.0;
        Ok(heads)
    }
}

#[cfg(target_os = "macos")]
fn register_provider(builder: &mut ort::session::builder::SessionBuilder, cache_dir: Option<&Path>) -> (&'static str, Option<String>) {
    use ort::execution_providers::ExecutionProvider;
    use ort::execution_providers::coreml::{CoreMLComputeUnits, CoreMLExecutionProvider, CoreMLModelFormat};
    let mut ep = CoreMLExecutionProvider::default().with_model_format(CoreMLModelFormat::MLProgram).with_compute_units(CoreMLComputeUnits::CPUAndNeuralEngine);
    if let Some(dir) = cache_dir {
        ep = ep.with_model_cache_dir(dir.display());
    }
    match ep.register(builder) {
        Ok(()) => ("coreml", None),
        Err(e) => ("cpu", Some(format!("CoreML: {e}"))),
    }
}

#[cfg(not(target_os = "macos"))]
fn register_provider(_builder: &mut ort::session::builder::SessionBuilder, _cache_dir: Option<&Path>) -> (&'static str, Option<String>) {
    ("cpu", None)
}

/// A model the engine has loaded: its metadata and one session shared by whoever runs it (the
/// live worker, the lookahead, a generation). Runs are short and take the lock one at a time.
pub struct Loaded {
    pub meta: Arc<Meta>,
    pub session: Arc<Mutex<Session>>,
}

impl Loaded {
    pub fn load(weights: &Path, metadata: &Path, cache_dir: Option<&Path>) -> Result<Loaded, String> {
        let meta = Meta::read(metadata)?;
        let session = Session::load(weights, &meta, cache_dir)?;
        Ok(Loaded { meta: Arc::new(meta), session: Arc::new(Mutex::new(session)) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Loads the shipped weights from `app/models/` and runs a zero window through each: the
    /// acid test that ONNX Runtime and CoreML take these graphs, and that the metadata beside
    /// them matches this engine's feature layout.
    #[test]
    fn shipped_models_load_and_run() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../app/models");
        for spec in crate::spec::MODELS {
            let t0 = Instant::now();
            let loaded = Loaded::load(&dir.join(spec.weights()), &dir.join(spec.metadata()), Some(&std::env::temp_dir().join("bp-model-cache"))).unwrap();
            let s = loaded.session.lock().unwrap();
            println!("{} on {} ({:?}): load {:?}, warmup p50 {:.2} ms, too slow {}", spec.id, s.provider, s.fallback, t0.elapsed(), s.warmup_ms, s.too_slow());
            assert_eq!(loaded.meta.kind, spec.kind);
            assert_eq!(loaded.meta.version, spec.version);
        }
    }
}
