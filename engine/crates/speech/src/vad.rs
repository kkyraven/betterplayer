use std::path::Path;

use ort::session::Session;
use ort::value::{Tensor, TensorRef};

pub const FRAME: usize = 512;
const CONTEXT: usize = 64;
const STATE: usize = 2 * 128;

pub struct Vad {
    session: Session,
    sr: Tensor<i64>,
    state: Vec<f32>,
    input: [f32; CONTEXT + FRAME],
    pending: Vec<f32>,
}

impl Vad {
    pub fn load(path: &Path) -> Result<Vad, String> {
        let session = crate::session(path, 1)?;
        let sr = Tensor::from_array(((), vec![crate::mel::RATE as i64])).map_err(|e| e.to_string())?;
        Ok(Vad { session, sr, state: vec![0.0; STATE], input: [0.0; CONTEXT + FRAME], pending: Vec::new() })
    }

    pub fn reset(&mut self) {
        self.state.fill(0.0);
        self.input.fill(0.0);
        self.pending.clear();
    }

    pub fn push(&mut self, pcm: &[i16]) -> Result<Vec<f32>, String> {
        let _low = crate::Lowered::new();
        self.pending.extend(pcm.iter().map(|&s| s as f32 / 32768.0));
        let mut out = Vec::with_capacity(self.pending.len() / FRAME);
        let mut at = 0;
        while self.pending.len() - at >= FRAME {
            self.input.copy_within(FRAME.., 0);
            self.input[CONTEXT..].copy_from_slice(&self.pending[at..at + FRAME]);
            at += FRAME;
            let input = TensorRef::from_array_view(([1usize, CONTEXT + FRAME], &self.input[..])).map_err(|e| e.to_string())?;
            let state = TensorRef::from_array_view(([2usize, 1, 128], self.state.as_slice())).map_err(|e| e.to_string())?;
            let outputs = self
                .session
                .run(ort::inputs!["input" => input, "state" => state, "sr" => &self.sr])
                .map_err(|e| e.to_string())?;
            let (_, p) = outputs["output"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            let (_, state) = outputs["stateN"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            out.push(p.first().copied().unwrap_or(0.0));
            if state.len() != STATE {
                return Err(format!("VAD state is {} values, expected {STATE}", state.len()));
            }
            self.state.copy_from_slice(state);
        }
        self.pending.drain(..at);
        Ok(out)
    }
}
