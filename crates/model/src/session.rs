use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use ort::session::{Session as OrtSession, builder::GraphOptimizationLevel};
use ort::value::TensorRef;

use crate::meta::Meta;


pub const TOO_SLOW_MS: f64 = 20.0;


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

    pub provider: &'static str,

    pub fallback: Option<String>,
    pub warmup_ms: f64,

    pub run_ms: f64,
    shape: [usize; 3],
}

impl Session {


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
