use std::path::Path;

use ort::session::{Session, builder::GraphOptimizationLevel};
use ort::value::TensorRef;


pub const INPUT: usize = 448;
const CHANNELS: usize = 3;

pub struct Tagger {
    session: Session,
    input_name: String,
    output_name: String,
    input: Vec<f32>,
}

impl Tagger {



    pub fn load(path: &Path) -> Result<Tagger, String> {
        let builder = Session::builder()
            .and_then(|b| b.with_optimization_level(GraphOptimizationLevel::Level3))
            .and_then(|b| b.with_intra_threads(2))
            .and_then(|b| b.with_intra_op_spinning(false))
            .map_err(|e| e.to_string())?;
        let session = builder.commit_from_file(path).map_err(|e| e.to_string())?;
        let input_name = session.inputs.first().map(|i| i.name.clone()).ok_or("model has no inputs")?;
        let output_name = session.outputs.first().map(|o| o.name.clone()).ok_or("model has no outputs")?;
        Ok(Tagger { session, input_name, output_name, input: Vec::new() })
    }



    pub fn tag(&mut self, stills: &[&[u8]]) -> Result<Vec<Vec<f32>>, String> {
        let per_image = INPUT * INPUT * CHANNELS;
        if stills.is_empty() {
            return Ok(Vec::new());
        }
        for (i, still) in stills.iter().enumerate() {
            if still.len() != per_image {
                return Err(format!("still {i} is {} bytes, expected {}x{}x{}", still.len(), INPUT, INPUT, CHANNELS));
            }
        }
        self.input.clear();
        self.input.reserve(per_image * stills.len());
        for still in stills {
            self.input.extend(still.iter().map(|&b| b as f32));
        }
        let tensor = TensorRef::from_array_view(([stills.len(), INPUT, INPUT, CHANNELS], self.input.as_slice())).map_err(|e| e.to_string())?;
        let outputs = self.session.run(ort::inputs![self.input_name.as_str() => tensor]).map_err(|e| e.to_string())?;
        let (shape, raw) = outputs[self.output_name.as_str()].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let dims: Vec<i64> = shape.iter().copied().collect();
        let tags = match dims.as_slice() {
            [n, t] if *n as usize == stills.len() && *t > 0 => *t as usize,
            _ => return Err(format!("unexpected output shape {dims:?}")),
        };
        Ok(raw.chunks_exact(tags).map(|c| c.to_vec()).collect())
    }
}
